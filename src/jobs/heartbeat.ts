/**
 * Worker heartbeat (spec/misc.md §4 `record_heartbeat`, spec/core.md §1 `/health/worker`, `worker_state()`).
 * Every trigger upserts the single `scheduler` row; `jobs` is merged with `json_patch`, so the row keeps the last
 * result of every job even though the three triggers run different jobs.
 */
import { eq, sql } from "drizzle-orm";
import { runBatch } from "../db/batch.ts";
import type { Db } from "../db/client.ts";
import { type HeartbeatJobs, workerHeartbeats } from "../db/schema/index.ts";
import type { Logger } from "../lib/logger.ts";
import { toWire } from "../lib/time.ts";
import { uuid7 } from "../lib/uuid7.ts";

export const WORKER_NAME = "scheduler";
/**
 * The most frequent trigger fires every 5 minutes; three missed ticks is stale (DESIGN.md §9: "stale after 15 min").
 * Python used max(180 s, 3 x WORKER_INTERVAL_SECONDS) for the same three-ticks rule.
 */
export const STALE_AFTER_SECONDS = 900;

export type JobReport = HeartbeatJobs;

export const heartbeatStmt = (db: Db, report: JobReport, durationMs: number, now: number) => {
  const failed = Object.values(report).some((r) => "error" in r);
  const clearKeys = JSON.stringify(Object.fromEntries(Object.keys(report).map((k) => [k, null])));
  return db
    .insert(workerHeartbeats)
    .values({
      id: uuid7(now),
      name: WORKER_NAME,
      lastTickAt: now,
      durationMs,
      jobs: report,
      failingTicks: failed ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.name,
      set: {
        lastTickAt: sql`excluded.last_tick_at`,
        durationMs: sql`excluded.duration_ms`,
        // RFC 7396 merges nested objects, so first null out this tick's jobs: a job's entry is replaced whole
        // (`{error}` must not survive next to a later `{result}`).
        jobs: sql`json_patch(json_patch(${workerHeartbeats.jobs}, ${clearKeys}), excluded.jobs)`,
        failingTicks: failed ? sql`${workerHeartbeats.failingTicks} + 1` : sql`0`,
        updatedAt: now,
      },
    });
};

/** Upserts the heartbeat. Failure is logged, never thrown: a heartbeat problem must not stop the jobs. */
export async function recordHeartbeat(
  db: Db,
  log: Logger,
  report: JobReport,
  durationMs: number,
  now: number,
): Promise<void> {
  try {
    await runBatch(db, [heartbeatStmt(db, report, durationMs, now)]);
  } catch (err) {
    log.error("worker heartbeat not recorded", err);
  }
}

export type WorkerState =
  | { status: "never_ran"; last_tick_at: null }
  | {
      status: "ok" | "stale";
      last_tick_at: string;
      age_seconds: number;
      duration_ms: number;
      failing_ticks: number;
      jobs: JobReport;
    };

export const readHeartbeatStmt = (db: Db) =>
  db.select().from(workerHeartbeats).where(eq(workerHeartbeats.name, WORKER_NAME)).limit(1);

type HeartbeatRow = typeof workerHeartbeats.$inferSelect;

/** `worker_state()`: the admin view (spec/misc.md §3 `/v1/admin/metrics`). */
export function workerState(row: HeartbeatRow | undefined, now: number): WorkerState {
  if (row === undefined) return { status: "never_ran", last_tick_at: null };
  // Truncated like Python's int(age.total_seconds()).
  const age = Math.trunc((now - row.lastTickAt) / 1000);
  return {
    status: age > STALE_AFTER_SECONDS ? "stale" : "ok",
    last_tick_at: toWire(row.lastTickAt),
    age_seconds: age,
    duration_ms: row.durationMs,
    failing_ticks: row.failingTicks,
    jobs: row.jobs,
  };
}

/**
 * `/health/worker`: status 200 only when ok, else 503; the body never carries `jobs`, `duration_ms` or
 * `failing_ticks`. Pass `row = "error"` when the read failed (503 `{"status":"unknown"}`).
 */
export function healthWorker(
  row: HeartbeatRow | undefined | "error",
  now: number,
): { status: 200 | 503; body: { status: string; age_seconds?: number | null } } {
  if (row === "error") return { status: 503, body: { status: "unknown" } };
  const s = workerState(row, now);
  if (s.status === "never_ran") return { status: 503, body: { status: "never_ran", age_seconds: null } };
  return { status: s.status === "ok" ? 200 : 503, body: { status: s.status, age_seconds: s.age_seconds } };
}
