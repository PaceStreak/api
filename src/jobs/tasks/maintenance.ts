/**
 * The daily and hourly maintenance jobs (spec/misc.md §4): 10 `purge_deleted_accounts`, 11 `housekeeping`,
 * 12 `error_alerts`, plus the hourly challenge resolution (7).
 */
import type { Ctx } from "../../ctx.ts";
import { runBatch, type Stmt } from "../../db/batch.ts";
import { createMailer } from "../../lib/mailer/index.ts";
import { deleteMany } from "../../lib/r2.ts";
import { sweepExpiredChallenges } from "../../modules/auth/service.ts";
import { resolveFinished } from "../../modules/groups/service.ts";
import { sweepStmts } from "../../modules/ops/service.ts";
import { purgeExpired } from "../../modules/trash/service.ts";
import { chunk } from "../dispatch.ts";
import {
  activeAdmins,
  deleteExportJobs,
  deleteImportJobs,
  duePurges,
  expiredSessions,
  IN_CHUNK,
  markAlerted,
  NOTIFICATION_RETENTION_MS,
  oldExportJobs,
  oldImportJobs,
  oldNotifications,
  oldRateCounters,
  purgeExportKeys,
  purgeImportKeys,
  purgePhotoKeys,
  purgeUsers,
  RATE_COUNTER_RETENTION_MS,
  STAGING_RETENTION_MS,
  unalertedErrors,
} from "./repo.ts";

// ---- 7. challenges ------------------------------------------------------------------------------------------

/** Freezes finished challenges. `resolveFinished` defers delivery of its own notices, so this reports a count. */
export async function resolveChallenges(ctx: Ctx): Promise<number> {
  const today = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  return (await resolveFinished(ctx, today)).length;
}

// ---- 10. purge ----------------------------------------------------------------------------------------------

/** Accounts whose grace period ran out; the cron dispatcher sends them as `purge` messages of 50. */
export async function duePurgeIds(ctx: Ctx, now: number): Promise<string[]> {
  const [rows] = await runBatch(ctx.db, [duePurges(ctx.db, now)] as const);
  return rows.map((r) => r.userId);
}

const stagedKeys = (rows: readonly { key: string | null; parts?: string[] }[]) =>
  rows.flatMap((r) => [...(r.key === null ? [] : [r.key]), ...(r.parts ?? [])]);

/**
 * The `purge` consumer: one atomic batch collects the R2 keys of every account still due and deletes the users
 * (foreign keys cascade to every table keyed on them); then the photos and staged files go from R2, which the
 * database cannot reach. A cancelled deletion is re-checked inside the batch. An R2 failure after the commit
 * leaks objects but loses nothing (Python behaved the same); returns how many accounts were deleted.
 */
export async function purgeAccounts(ctx: Ctx, userIds: readonly string[]): Promise<number> {
  const now = ctx.clock.now();
  let purged = 0;
  for (const part of chunk([...new Set(userIds)], IN_CHUNK)) {
    const [photos, imports, exports, deleted] = await runBatch(ctx.db, [
      purgePhotoKeys(ctx.db, part, now),
      purgeImportKeys(ctx.db, part, now),
      purgeExportKeys(ctx.db, part, now),
      purgeUsers(ctx.db, part, now),
    ] as const);
    purged += deleted.length;
    await deleteMany(
      ctx.env.PHOTOS,
      photos.map((p) => p.key),
    );
    await deleteMany(ctx.env.STAGING, [...stagedKeys(imports), ...stagedKeys(exports)]);
  }
  return purged;
}

// ---- 11. housekeeping ---------------------------------------------------------------------------------------

/**
 * Retention: 180-day notifications, trash past its 30 days, expired WebAuthn challenges, 30-day auth failures and
 * crash groups, dead rate-limit counters, expired sessions (refresh tokens cascade), and import/export jobs a week
 * old together with their staged R2 objects. Two round trips plus the challenge sweep's own.
 */
export async function housekeeping(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const stagedBefore = now - STAGING_RETENTION_MS;
  const [imports, exports] = await runBatch(ctx.db, [
    oldImportJobs(ctx.db, stagedBefore),
    oldExportJobs(ctx.db, stagedBefore),
  ] as const);
  const stmts: Stmt[] = [
    oldNotifications(ctx.db, now - NOTIFICATION_RETENTION_MS),
    purgeExpired(ctx.db, now),
    ...sweepStmts(ctx),
    oldRateCounters(ctx.db, now - RATE_COUNTER_RETENTION_MS),
    expiredSessions(ctx.db, now),
    ...chunk(
      imports.map((j) => j.id),
      IN_CHUNK,
    ).map((ids) => deleteImportJobs(ctx.db, ids)),
    ...chunk(
      exports.map((j) => j.id),
      IN_CHUNK,
    ).map((ids) => deleteExportJobs(ctx.db, ids)),
  ];
  await runBatch(ctx.db, stmts);
  await sweepExpiredChallenges(ctx);
  // Rows first, objects second: a failed R2 delete leaks an object, never a row pointing at nothing.
  await deleteMany(ctx.env.STAGING, [...stagedKeys(imports), ...stagedKeys(exports)]);
  return 0;
}

// ---- 12. error alerts ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Python slices code points; JS `.slice` would split an emoji. */
const codePoints = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/**
 * Emails every active admin about crash groups first seen in the last day and never reported (hourly: the job
 * runs on the minute-2 tick only, which replaces Python's Redis gate). Each group is reported once however often
 * it recurs. Anonymous like the reports themselves: message, path, count. Returns how many groups it reported.
 */
export async function errorAlerts(ctx: Ctx): Promise<number> {
  // Email off: the groups stay unalerted (Admin > Ops lists them); nothing is sent or marked.
  if (!ctx.cfg.emailEnabled) return 0;
  const now = ctx.clock.now();
  const [fresh, admins] = await runBatch(ctx.db, [
    unalertedErrors(ctx.db, now - DAY_MS),
    activeAdmins(ctx.db),
  ] as const);
  if (fresh.length === 0) return 0;
  const lines = fresh.map(
    (e) =>
      `- ${codePoints(e.message, 200)}\n  at ${e.path || "?"} - ${e.count} time(s), first ${stamp(e.firstSeen)} UTC`,
  );
  const n = fresh.length;
  const body = `${n} new kind(s) of error in the app since the last alert:\n\n${lines.join("\n")}\n\nDetails: Admin > Ops in the app.`;
  const mailer = createMailer(ctx.cfg, ctx.env, ctx.log);
  for (const a of admins)
    await mailer.send({ to: a.email, subject: `PaceStreak: ${n} new app error(s)`, text: body });
  await runBatch(ctx.db, [
    markAlerted(
      ctx.db,
      fresh.map((e) => e.id),
      now,
    ),
  ]);
  return n;
}
