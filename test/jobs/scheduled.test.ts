import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../../src/ctx.ts";
import { runBatch } from "../../src/db/batch.ts";
import { readHeartbeatStmt } from "../../src/jobs/heartbeat.ts";
import { acquireLease } from "../../src/jobs/leases.ts";
import {
  CRONS,
  createJobRegistry,
  handleScheduled,
  JOB_NAMES,
  type JobName,
  runTick,
  slotsFor,
  type Tick,
  triggerOf,
} from "../../src/jobs/scheduled.ts";
import { useFixedClock } from "../fixtures/clock.ts";
import { jobCtx, recordingQueue } from "./helpers.ts";

const AT = (h: number, m: number) => Date.UTC(2026, 9, 14, h, m);

async function heartbeat(ctx: Ctx) {
  const [rows] = await runBatch(ctx.db, [readHeartbeatStmt(ctx.db)]);
  return rows?.[0];
}

describe("cron routing", () => {
  it("maps the three wrangler crons and nothing else", () => {
    expect(triggerOf("*/5 * * * *")).toBe("frequent");
    expect(triggerOf("2,17,32,47 * * * *")).toBe("quarter");
    expect(triggerOf("23 3 * * *")).toBe("daily");
    expect(triggerOf("0 * * * *")).toBeNull();
  });

  it("every job has exactly one trigger; hourly jobs run only on the minute-2 tick", () => {
    const at2 = slotsFor("quarter", AT(10, 2));
    const at17 = slotsFor("quarter", AT(10, 17));
    expect(at2).toEqual([
      "stats",
      "nudges",
      "habits",
      "habit_summary",
      "digest",
      "challenges",
      "backup",
      "buddies",
      "error_alerts",
    ]);
    expect(at17).toEqual(["nudges", "habits", "habit_summary", "digest", "backup", "buddies"]);
    expect(slotsFor("frequent", AT(10, 5))).toEqual(["habit_snoozes", "delivery_retry"]);
    expect(slotsFor("daily", AT(3, 23))).toEqual(["purge", "housekeeping"]);
    const all = new Set([...at2, ...slotsFor("frequent", 0), ...slotsFor("daily", 0)]);
    expect([...all].sort()).toEqual([...JOB_NAMES].sort());
  });
});

describe("runTick", () => {
  it("runs registered slots in order, delivers returned ids, reports, heartbeats, releases", async () => {
    const clock = useFixedClock(AT(10, 2));
    const ctx = jobCtx();
    const q = recordingQueue();
    const reg = createJobRegistry();
    const order: JobName[] = [];
    let seen: Tick | undefined;
    reg.register("error_alerts", async () => {
      order.push("error_alerts");
      return 2;
    });
    reg.register("nudges", async (_c, tick) => {
      order.push("nudges");
      seen = tick;
      clock.advance(40);
      return { notificationIds: ["n1", "n2", "n3"] };
    });
    reg.register("digest", async () => {
      order.push("digest");
      throw new TypeError("boom");
    });
    reg.register("habits", async () => {
      order.push("habits");
      return undefined;
    });
    reg.register("housekeeping", async () => {
      throw new Error("must not run on the quarter trigger");
    });

    const report = await runTick(ctx, "quarter", AT(10, 2), { registry: reg, queue: q });
    expect(order).toEqual(["nudges", "habits", "digest", "error_alerts"]);
    expect(report).toEqual({
      nudges: { result: 3 },
      habits: { result: 0 },
      digest: { error: "TypeError" },
      error_alerts: { result: 2 },
    });
    expect(q.messages).toEqual([{ type: "deliver", ids: ["n1", "n2", "n3"] }]);
    expect(seen).toMatchObject({ trigger: "quarter", cron: CRONS.quarter, now: AT(10, 2) });

    const hb = await heartbeat(ctx);
    expect(hb).toMatchObject({ lastTickAt: AT(10, 2) + 40, durationMs: 40, failingTicks: 1 });

    // The lease was released: the next tick runs at once.
    expect(await runTick(ctx, "quarter", AT(10, 2), { registry: createJobRegistry(), queue: q })).toEqual({});
  });

  it("a held lease skips the tick without a heartbeat", async () => {
    useFixedClock(AT(11, 0));
    const ctx = jobCtx();
    const before = await heartbeat(ctx);
    expect(await acquireLease(ctx.db, "cron:frequent", AT(11, 0))).not.toBeNull();
    const reg = createJobRegistry();
    let ran = false;
    reg.register("habit_snoozes", async () => {
      ran = true;
      return 1;
    });
    expect(await runTick(ctx, "frequent", AT(11, 0), { registry: reg, queue: recordingQueue() })).toBeNull();
    expect(ran).toBe(false);
    expect(await heartbeat(ctx)).toEqual(before);
  });

  it("an empty registry reports nothing and enqueues nothing", async () => {
    useFixedClock(AT(3, 23));
    const q = recordingQueue();
    expect(await runTick(jobCtx(), "daily", AT(3, 23), { registry: createJobRegistry(), queue: q })).toEqual(
      {},
    );
    expect(q.calls).toEqual([]);
  });

  it("a job registered twice is an error", () => {
    const reg = createJobRegistry();
    reg.register("stats", async () => 0);
    expect(() => reg.register("stats", async () => 0)).toThrow(/twice/);
  });
});

describe("handleScheduled", () => {
  it("ignores an unknown cron", async () => {
    const controller = createScheduledController({ cron: "1 1 * * *", scheduledTime: AT(1, 1) });
    expect(await handleScheduled(controller, env, createExecutionContext(), createJobRegistry())).toBeNull();
  });

  it("routes a known cron to its trigger", async () => {
    useFixedClock(AT(12, 30));
    const reg = createJobRegistry();
    reg.register("housekeeping", async () => 7);
    const controller = createScheduledController({ cron: CRONS.daily, scheduledTime: AT(3, 23) });
    expect(await handleScheduled(controller, env, createExecutionContext(), reg)).toEqual({
      housekeeping: { result: 7 },
    });
  });
});
