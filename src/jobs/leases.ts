/**
 * Cron overlap guard (DESIGN.md §9 "Overlap"), the D1 replacement for Python's Redis `SET worker:tick NX EX`.
 * One row per trigger; acquiring is a single self-seeding UPSERT that only moves `until` forward when the previous
 * lease has expired, so two overlapping invocations can never both hold it.
 */
import { and, eq, sql } from "drizzle-orm";
import { runBatch } from "../db/batch.ts";
import type { Db } from "../db/client.ts";
import { jobLeases } from "../db/schema/index.ts";

/** Longer than any tick should take, shorter than the 5-minute trigger interval. */
export const LEASE_MS = 240_000;

export interface Lease {
  readonly name: string;
  readonly until: number;
}

export const acquireLeaseStmt = (db: Db, name: string, now: number, ttlMs: number) =>
  db
    .insert(jobLeases)
    .values({ name, until: now + ttlMs })
    .onConflictDoUpdate({
      target: jobLeases.name,
      set: { until: sql`excluded.until` },
      setWhere: sql`${jobLeases.until} <= ${now}`,
    })
    .returning({ name: jobLeases.name, until: jobLeases.until });

/** The lease, or null when another invocation holds it (the caller skips the tick, without a heartbeat). */
export async function acquireLease(
  db: Db,
  name: string,
  now: number,
  ttlMs = LEASE_MS,
): Promise<Lease | null> {
  const [rows] = await runBatch(db, [acquireLeaseStmt(db, name, now, ttlMs)]);
  return rows?.[0] ?? null;
}

/** Frees the lease early, only if it is still ours (a stale holder must not free a newer lease). */
export async function releaseLease(db: Db, lease: Lease, now: number): Promise<void> {
  await runBatch(db, [
    db
      .update(jobLeases)
      .set({ until: now })
      .where(and(eq(jobLeases.name, lease.name), eq(jobLeases.until, lease.until))),
  ]);
}
