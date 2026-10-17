import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBatch } from "../../src/db/batch.ts";
import { workerHeartbeats } from "../../src/db/schema/index.ts";
import {
  healthWorker,
  readHeartbeatStmt,
  recordHeartbeat,
  STALE_AFTER_SECONDS,
  WORKER_NAME,
  workerState,
} from "../../src/jobs/heartbeat.ts";
import { acquireLease, LEASE_MS, releaseLease } from "../../src/jobs/leases.ts";
import { createLogger } from "../../src/lib/logger.ts";
import { testDb } from "../fixtures/db.ts";

const T = Date.UTC(2026, 9, 14, 12, 0);
const log = createLogger();

async function heartbeatRow() {
  const { db } = testDb();
  const [rows] = await runBatch(db, [readHeartbeatStmt(db)]);
  return rows?.[0];
}

describe("leases", () => {
  it("first acquire seeds the row; a second is refused until expiry", async () => {
    const { db } = testDb();
    expect(await acquireLease(db, "t:one", T)).toEqual({ name: "t:one", until: T + LEASE_MS });
    expect(await acquireLease(db, "t:one", T + 1000)).toBeNull();
    expect(await acquireLease(db, "t:one", T + LEASE_MS - 1)).toBeNull();
    expect(await acquireLease(db, "t:one", T + LEASE_MS)).toEqual({ name: "t:one", until: T + 2 * LEASE_MS });
  });

  it("leases are per name", async () => {
    const { db } = testDb();
    expect(await acquireLease(db, "t:a", T)).not.toBeNull();
    expect(await acquireLease(db, "t:b", T)).not.toBeNull();
  });

  it("release frees the lease, but only for its holder", async () => {
    const { db } = testDb();
    const a = await acquireLease(db, "t:rel", T);
    if (a === null) throw new Error("lease");
    await releaseLease(db, a, T + 10);
    expect(await acquireLease(db, "t:rel", T + 10)).not.toBeNull();
    // A stale holder releasing late must not free the newer lease.
    await releaseLease(db, a, T + 20);
    expect(await acquireLease(db, "t:rel", T + 20)).toBeNull();
  });

  it("concurrent acquires: exactly one wins", async () => {
    const { db } = testDb();
    const got = await Promise.all(Array.from({ length: 5 }, () => acquireLease(db, "t:race", T)));
    expect(got.filter((g) => g !== null)).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  it("before the first tick: never_ran, 503", async () => {
    const row = await heartbeatRow();
    expect(row).toBeUndefined();
    expect(workerState(row, T)).toEqual({ status: "never_ran", last_tick_at: null });
    expect(healthWorker(row, T)).toEqual({ status: 503, body: { status: "never_ran", age_seconds: null } });
  });

  it("upserts the scheduler row, merges jobs and counts failing ticks", async () => {
    const { db } = testDb();
    await recordHeartbeat(db, log, { stats: { result: 3 } }, 12, T);
    let row = await heartbeatRow();
    expect(row).toMatchObject({ name: WORKER_NAME, lastTickAt: T, durationMs: 12, failingTicks: 0 });

    await recordHeartbeat(db, log, { purge: { error: "TypeError" } }, 7, T + 60_000);
    await recordHeartbeat(db, log, { nudges: { error: "Error" } }, 8, T + 120_000);
    row = await heartbeatRow();
    expect(row).toMatchObject({ lastTickAt: T + 120_000, durationMs: 8, failingTicks: 2 });
    expect(row?.jobs).toEqual({
      stats: { result: 3 },
      purge: { error: "TypeError" },
      nudges: { error: "Error" },
    });

    await recordHeartbeat(db, log, { purge: { result: 0 } }, 1, T + 180_000);
    row = await heartbeatRow();
    expect(row?.failingTicks).toBe(0);
    expect(row?.jobs.purge).toEqual({ result: 0 });
    const [all] = await runBatch(db, [
      db.select().from(workerHeartbeats).where(eq(workerHeartbeats.name, WORKER_NAME)),
    ]);
    expect(all).toHaveLength(1);
  });

  it("ok while fresh, stale after 15 minutes; the health body never has jobs", async () => {
    const row = await heartbeatRow();
    if (row === undefined) throw new Error("no heartbeat");
    const at = row.lastTickAt;
    const fresh = healthWorker(row, at + 61_500);
    expect(fresh).toEqual({ status: 200, body: { status: "ok", age_seconds: 61 } });
    expect("jobs" in fresh.body).toBe(false);
    expect(healthWorker(row, at + STALE_AFTER_SECONDS * 1000).status).toBe(200);
    expect(healthWorker(row, at + STALE_AFTER_SECONDS * 1000 + 1000)).toEqual({
      status: 503,
      body: { status: "stale", age_seconds: STALE_AFTER_SECONDS + 1 },
    });
    expect(workerState(row, at)).toMatchObject({
      status: "ok",
      last_tick_at: new Date(at).toISOString(),
      age_seconds: 0,
      failing_ticks: 0,
    });
    expect(healthWorker("error", at)).toEqual({ status: 503, body: { status: "unknown" } });
  });
});
