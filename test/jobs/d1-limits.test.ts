/**
 * D1 counts every statement, each one inside a batch too, against a per-invocation cap: 50 queries on Workers Free,
 * 1,000 on Paid (https://developers.cloudflare.com/d1/platform/limits/; src/lib/plan.ts). The queue consumer takes
 * one message per invocation and a cron tick is one invocation, so each must fit with room to spare: this measures
 * the per-id cost of the heavy jobs on the seeded heavy account (5 years, 3,000 workouts, 20 habits) and holds the
 * pack sizes (src/jobs/dispatch.ts) and every split job to the plan's budget, 90% of the cap.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Ctx, createCtx } from "../../src/ctx.ts";
import { runBatch } from "../../src/db/batch.ts";
import { auditLog, users } from "../../src/db/schema/index.ts";
import { loadConfig } from "../../src/env.ts";
import { idsPerSlice, SLICE_COSTS, SLICE_OVERHEAD } from "../../src/jobs/dispatch.ts";
import { createJobRegistry, runTick } from "../../src/jobs/scheduled.ts";
import { registerJobs } from "../../src/jobs/tasks/index.ts";
import { d1Budget } from "../../src/lib/plan.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import "../../src/modules/account/service.ts";
import { exportAttachment } from "../../src/modules/account/service.ts";
import { mergePlan } from "../../src/modules/admin/merge.ts";
import { mergeSlice } from "../../src/modules/admin/service.ts";
import * as game from "../../src/modules/game/service.ts";
import { ATTACHMENT_STATEMENTS, deliver, notifyMany } from "../../src/modules/notifications/service.ts";
import { type HeavyUser, heavyUser } from "../contract/heavy.ts";
import { signup } from "../fixtures/auth.ts";
import { testDb } from "../fixtures/db.ts";
import { jobCtx, recordingQueue } from "./helpers.ts";

const FREE = d1Budget("free");

/** Statements `run` spends on a fresh context. */
async function cost(run: (ctx: Ctx) => Promise<unknown>, ctx: Ctx = jobCtx()): Promise<number> {
  const before = ctx.stats.statements;
  await run(ctx);
  return ctx.stats.statements - before;
}

describe("D1 queries per invocation", () => {
  let h: HeavyUser;
  beforeAll(async () => {
    h = await heavyUser();
  }, 120_000);

  it("the tests run on the Free plan's budget: 45 statements of 50", () => {
    expect(jobCtx().cfg.plan).toBe("free");
    expect(jobCtx().cfg.d1Budget).toBe(45);
    expect(d1Budget("paid")).toBe(900);
  });

  it("a recompute and a snapshot of the heavy account stay within their declared per-id cost", async () => {
    // A recompute that writes (the stats job's per-id cost), from a stale projection.
    await testDb().db.run(sql`UPDATE user_stats SET computed_for = '2000-01-01' WHERE user_id = ${h.userId}`);
    const recompute = await cost((ctx) => game.recompute(ctx, h.userId, { notify: false }));
    expect(recompute).toBeGreaterThan(0);
    expect(recompute).toBeLessThanOrEqual(SLICE_COSTS.stats ?? 0);
    // A snapshot (nudges, digest), plus its share of the notes insert.
    const snapshot = await cost((ctx) => game.snapshotsFor(ctx, [h.userId]));
    expect(snapshot + 1).toBeLessThanOrEqual(SLICE_COSTS.nudges ?? 0);
    expect(snapshot + 1).toBeLessThanOrEqual(SLICE_COSTS.digest ?? 0);
  });

  it("every heavy pack fits the budget, and a single id always goes alone at worst", () => {
    for (const job of ["stats", "nudges", "digest"] as const) {
      const n = idsPerSlice(job, FREE);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n * (SLICE_COSTS[job] ?? 0) + SLICE_OVERHEAD, job).toBeLessThanOrEqual(FREE);
    }
  });

  it("a full rebuild of the heavy account (import, merge, restore) fits one invocation", async () => {
    const n = await cost((ctx) => game.rebuild(ctx, h.userId));
    expect(n).toBeLessThanOrEqual(game.REBUILD_STATEMENTS);
    expect(game.REBUILD_STATEMENTS).toBeLessThanOrEqual(FREE);
  });

  it("a backup attachment of the heavy account costs at most ATTACHMENT_STATEMENTS", async () => {
    const n = await cost((ctx) => exportAttachment(ctx, h.userId));
    expect(n).toBeLessThanOrEqual(ATTACHMENT_STATEMENTS);
  });

  it("a delivery hands the backup notes that do not fit to a fresh message", async () => {
    const me = await signup();
    const queue = recordingQueue();
    const cfg = loadConfig(env);
    if (!cfg.ok) throw new Error(cfg.reasons.join("; "));
    const ctx = createCtx(
      { ...env, JOBS: queue as unknown as Queue },
      cfg.config,
      createExecutionContext(),
      "t",
    );
    const ids = Array.from({ length: 5 }, () => uuid7());
    const [inserted] = (await runBatch(testDb().db, [
      notifyMany(
        jobCtx(),
        ids.map((id, i) => ({
          id,
          userId: me.userId,
          kind: "monthly_backup",
          category: "backup" as const,
          title: "Your monthly PaceStreak backup",
          data: { export_attachment: true },
          dedupeKey: `backup:test-${i}`,
        })),
      ),
    ])) as unknown as [{ id: string }[]];
    expect(inserted).toHaveLength(5);
    await deliver(ctx, ids);
    expect(ctx.stats.statements).toBeLessThanOrEqual(FREE);
    const resent = queue.messages.flatMap((m) => (m.type === "deliver" ? m.ids : []));
    expect(resent.length).toBeGreaterThan(0);
    expect(resent.length).toBeLessThan(5);
    expect(new Set([...ids].slice(5 - resent.length))).toEqual(new Set(resent));
  });

  it("a merge runs in slices, each within the budget, and finishes", async () => {
    const a = await signup();
    const b = await signup();
    const auditId = uuid7();
    const now = Date.now();
    await testDb()
      .db.insert(auditLog)
      .values({
        id: auditId,
        actorId: b.userId,
        action: "user.merge",
        targetType: "user",
        targetId: b.userId,
        detail: { source: a.userId, status: "running" },
        createdAt: now,
        updatedAt: now,
      });
    const total = mergePlan(testDb().db, a.userId, b.userId, false).stmts.length;
    expect(total).toBeGreaterThan(FREE);
    let msg: Parameters<typeof mergeSlice>[1] | null = {
      type: "merge-slice",
      source: a.userId,
      into: b.userId,
      keepSourceProfile: false,
      auditId,
      from: 0,
      moved: {},
    };
    let slices = 0;
    while (msg !== null) {
      const ctx = jobCtx();
      const m: Parameters<typeof mergeSlice>[1] = msg;
      msg = await mergeSlice(ctx, m);
      expect(ctx.stats.statements, `slice ${slices}`).toBeLessThanOrEqual(FREE);
      slices++;
    }
    expect(slices).toBe(Math.ceil(total / (FREE - 5)));
    expect(await testDb().db.select().from(users).where(eq(users.id, a.userId))).toEqual([]);
    const [entry] = await testDb()
      .db.select()
      .from(auditLog)
      .where(and(eq(auditLog.id, auditId)));
    expect(entry?.detail).toHaveProperty("moved");
    expect(entry?.detail).not.toHaveProperty("status");
  });

  it("each cron tick, every job of it included, fits one invocation", async () => {
    const reg = createJobRegistry();
    registerJobs(reg);
    for (const [trigger, minute] of [
      ["quarter", 2],
      ["quarter", 17],
      ["frequent", 5],
      ["daily", 23],
    ] as const) {
      const ctx = jobCtx();
      const at = Date.UTC(2026, 9, 20, trigger === "daily" ? 3 : 10, minute);
      await runTick(ctx, trigger, at, { registry: reg, queue: recordingQueue() });
      expect(ctx.stats.statements, `${trigger} :${minute}`).toBeLessThanOrEqual(FREE);
    }
  });
});
