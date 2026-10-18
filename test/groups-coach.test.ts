/**
 * The coach view on a large group. D1 counts every statement of a batch against its 1,000 queries per Worker
 * invocation (https://developers.cloudflare.com/d1/platform/limits/, "Batch limits"), so the per-member snapshot
 * reads (~18 statements each) would break a 200-member group. `mainChainsFor` reads every member with a fixed
 * handful of set-based statements; these tests pin the statement count and the rows against the full snapshot.
 */
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema/index.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import { snapshotsFor } from "../src/modules/game/service.ts";
import * as groups from "../src/modules/groups/service.ts";
import { authedBatch, testDb } from "./fixtures/db.ts";
import { person } from "./fixtures/game.ts";
import { api, jsonOf } from "./fixtures/http.ts";
import { type Json, logSession } from "./fixtures/training.ts";
import { jobCtx } from "./jobs/helpers.ts";

const MEMBERS = 40;

describe("coach view on a large group", () => {
  it("costs a fixed number of statements however many members share, and matches the snapshot", async () => {
    const coach = await person();
    const group = await jsonOf<Json>(
      await api("/v1/groups", { token: coach.token, json: { name: "Big crew", kind: "coaching" } }),
    );
    const members = await Promise.all(
      Array.from({ length: MEMBERS }, async (_, i) => {
        const m = await person();
        await api("/v1/groups/join", { token: m.token, json: { code: group.invite_code } });
        await api(`/v1/groups/${group.id}/me`, {
          token: m.token,
          method: "PATCH",
          json: { shares_with_coach: true },
        });
        if (i % 3 === 0) await logSession(m.token, { title: `Run ${i}` });
        return m;
      }),
    );

    const sessionId = uuid7();
    const now = Date.now();
    await testDb()
      .db.insert(sessions)
      .values({ id: sessionId, userId: coach.userId, createdAt: now, expiresAt: now + 86_400_000 });
    const ctx = jobCtx();
    const view = await groups.coachView(
      ctx,
      authedBatch(ctx.db, { userId: coach.userId, sessionId, tokenVersion: 0 }),
      group.id,
    );
    expect(view.members).toHaveLength(MEMBERS);
    expect(ctx.stats.roundTrips).toBe(2);
    // The membership read plus eight set-based statements, independent of MEMBERS (was ~18 x MEMBERS).
    expect(ctx.stats.statements).toBeLessThanOrEqual(16);

    const snaps = await snapshotsFor(
      jobCtx(),
      members.map((m) => m.userId),
    );
    for (const row of view.members as Json[]) {
      const m = members.find((x) => x.handle === row.handle);
      const main = snaps.get(m?.userId ?? "")?.snapshot.chains[0].result;
      expect(main).toBeDefined();
      expect(row.current_streak).toBe(main?.current);
      expect(row.this_week_days).toBe(main?.thisWeekDays);
      expect(row.this_week_target).toBe(main?.thisWeekTarget);
      expect(row.at_risk).toBe(main?.atRisk);
      expect(row.consistency).toBe(main?.consistency);
      expect(row.weeks).toEqual(
        main?.weeks
          .slice(-8)
          .map((c) => ({ week_start: c.weekStart, days: c.days, target: c.target, status: c.status })),
      );
    }
    const ran = (view.members as Json[]).filter((r) => r.recent.length === 1);
    expect(ran).toHaveLength(Math.ceil(MEMBERS / 3));
    expect(Object.keys(ran[0]?.recent[0] ?? {})).not.toContain("user_id");

    // The overview across every coaching group costs the same.
    const all = jobCtx();
    const overview = await groups.coaching(
      all,
      authedBatch(all.db, { userId: coach.userId, sessionId, tokenVersion: 0 }),
    );
    expect(overview.people).toHaveLength(MEMBERS);
    expect(all.stats.statements).toBeLessThanOrEqual(16);
  }, 120_000);
});
