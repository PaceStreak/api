/**
 * Moderation and administration (spec/misc.md §3, Python app/admin/router.py).
 *
 * Moderators review reports and act on content and social privileges; admins also change roles, deactivate
 * accounts, grant official handles and merge accounts. Every action writes the audit log, which nothing updates
 * or deletes. Suspension removes social privileges only: the training log stays the person's own.
 *
 * Each handler reads once (the role gate runs on that read) and writes once. Every write batch also starts with
 * a guard that the actor still holds the role, so a demotion between the read and the write cannot slip through.
 */
import { sql } from "drizzle-orm";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, runBatch, type Stmt, toWire } from "../../db/batch.ts";
import type { UserRole } from "../../db/schema/auth.ts";
import type { ConsumerRegistry } from "../../jobs/consumer.ts";
import { dispatchDeliver, enqueue, type MessageOf } from "../../jobs/dispatch.ts";
import { workerState } from "../../jobs/heartbeat.ts";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors.ts";
import { checkHandle, isReserved, mentionsBrand } from "../../lib/handles.ts";
import { addDays } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { workerStateStmt } from "../ops/service.ts";
import { mergePlan, movedCounts } from "./merge.ts";
import * as repo from "./repo.ts";

type Gate = "moderator" | "admin";
const ROLES: Record<Gate, readonly UserRole[]> = { moderator: ["moderator", "admin"], admin: ["admin"] };

/** Write with the session guard and an actor-role guard first; a lost role is the gate's 404. */
async function write(ctx: Ctx, authed: AuthedBatch, gate: Gate, stmts: Stmt[]): Promise<unknown[]> {
  const roles = sql.join(
    ROLES[gate].map((r) => sql`${r}`),
    sql`, `,
  );
  const guard = abortUnless(ctx.db, sql`(SELECT role FROM users WHERE id = ${authed.userId}) IN (${roles})`);
  try {
    return (await authed.write(guard, ...stmts)) as unknown[];
  } catch (err) {
    if (isCondAbort(err)) throw notFound();
    throw err;
  }
}

const audit = (
  ctx: Ctx,
  actorId: string,
  action: string,
  target: [string | null, string | null],
  detail: Record<string, unknown> | null,
) =>
  repo.insertAudit(
    ctx.db,
    { id: uuid7(ctx.clock.now()), actorId, action, targetType: target[0], targetId: target[1], detail },
    ctx.clock.now(),
  );

// ---- reports ------------------------------------------------------------------------------------------------

const who = (id: string | null, handle: string | null, name: string | null, suspended: number | null) =>
  id === null ? null : { id, handle, display_name: name, email: null, suspended: suspended !== null };

export async function listReports(ctx: Ctx, authed: AuthedBatch, status: "open" | "actioned" | "dismissed") {
  const [, rows] = await authed.read(repo.listReports(ctx.db, status));
  return rows.map((r) => ({
    id: r.id,
    target_type: r.targetType,
    target_id: r.targetId,
    reason: r.reason,
    detail: r.detail,
    snapshot: r.snapshot,
    status: r.status,
    created_at: toWire(r.createdAt),
    resolution: r.resolution,
    reporter: who(r.reporterId, r.reporterHandle, r.reporterName, r.reporterSuspended),
    reported:
      r.reportedUserId === null
        ? null
        : who(r.reportedId, r.reportedHandle, r.reportedName, r.reportedSuspended),
    prior_actioned: r.reportedUserId === null ? 0 : r.priorActioned,
  }));
}

export type ResolveAction = "dismiss" | "hide_content" | "suspend_user" | "hide_and_suspend";

export async function resolveReport(
  ctx: Ctx,
  authed: AuthedBatch,
  reportId: string,
  body: { action: ResolveAction; note?: string | null | undefined },
) {
  const [mod, found, exists, siblings] = await authed.read(
    repo.reportById(ctx.db, reportId),
    repo.targetExists(ctx.db, reportId),
    repo.openSiblings(ctx.db, reportId),
  );
  const report = found[0];
  if (report === undefined) throw notFound();
  const flags = exists[0];
  const now = ctx.clock.now();
  const stmts: Stmt[] = [];
  let hidden = false;
  let suspended = false;
  if (
    (body.action === "hide_content" || body.action === "hide_and_suspend") &&
    report.targetType !== "user"
  ) {
    const type = report.targetType;
    if (flags?.[type]) {
      stmts.push(repo.hideTarget(ctx.db, type, report.targetId, now));
      hidden = true;
    }
  }
  if (
    (body.action === "suspend_user" || body.action === "hide_and_suspend") &&
    report.reportedUserId !== null
  ) {
    if (flags?.reportedProfile) {
      stmts.push(repo.suspendProfile(ctx.db, report.reportedUserId, now));
      suspended = true;
    }
  }
  const status = body.action === "dismiss" ? "dismissed" : "actioned";
  stmts.push(
    ...repo.resolveReports(ctx.db, [report.id], {
      status,
      by: mod.id,
      now,
      resolution: () => body.note || body.action,
    }),
    ...repo.resolveReports(
      ctx.db,
      siblings.map((s) => s.id),
      { status, by: mod.id, now, resolution: () => `grouped with ${report.id}` },
    ),
  );
  let notificationId: string | null = null;
  if (report.reportedUserId !== null && (hidden || suspended)) {
    notificationId = uuid7(now);
    stmts.push(
      repo.insertNotification(
        ctx.db,
        {
          id: notificationId,
          userId: report.reportedUserId,
          kind: "moderation",
          category: "security",
          title: hidden ? "Some of your content was removed" : "Your social features are paused",
          body: "A moderator reviewed a report. Your training log is unaffected and still yours to use and export.",
          url: "/settings/privacy",
        },
        now,
      ),
    );
  }
  stmts.push(
    audit(ctx, mod.id, `report.${body.action}`, [report.targetType, report.targetId], {
      report: report.id,
      note: body.note ?? null,
      grouped: siblings.length,
    }),
  );
  await write(ctx, authed, "moderator", stmts);
  if (notificationId !== null) ctx.defer(dispatchDeliver(ctx.env.JOBS, [notificationId]));
  return { status, grouped: siblings.length };
}

// ---- users --------------------------------------------------------------------------------------------------

export async function listUsers(ctx: Ctx, authed: AuthedBatch, q: string) {
  const [, rows] = await authed.read(repo.searchUsers(ctx.db, q));
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    handle: u.handle,
    display_name: u.displayName,
    role: u.role,
    is_active: u.isActive,
    is_verified: u.isVerified,
    created_at: toWire(u.createdAt),
    social_suspended: u.socialSuspendedAt !== null,
    official: u.isOfficial === true,
    deletion_scheduled_at: toWire(u.deletionScheduledAt),
    reports: u.reports,
  }));
}

export interface UserPatch {
  role?: UserRole | null | undefined;
  social_suspended?: boolean | null | undefined;
  is_active?: boolean | null | undefined;
}

export async function updateUser(ctx: Ctx, authed: AuthedBatch, userId: string, body: UserPatch) {
  const [mod, target, profile] = await authed.read(
    repo.userById(ctx.db, userId),
    repo.profileOf(ctx.db, userId),
  );
  if (target[0] === undefined) throw notFound();
  const role = body.role ?? null;
  const isActive = body.is_active ?? null;
  const suspend = body.social_suspended ?? null;
  if ((role !== null || isActive !== null) && mod.role !== "admin") throw forbidden("Admins only");
  if (userId === mod.id && (role !== null || isActive === false)) throw conflict("Not on your own account");
  const now = ctx.clock.now();
  const changes: Record<string, unknown> = {};
  const stmts: Stmt[] = [];
  if (role !== null) {
    stmts.push(repo.setRole(ctx.db, userId, role, now));
    changes.role = role;
  }
  if (suspend !== null && profile[0] !== undefined) {
    stmts.push(
      suspend ? repo.suspendProfile(ctx.db, userId, now) : repo.unsuspendProfile(ctx.db, userId, now),
    );
    changes.social_suspended = suspend;
  }
  if (isActive !== null) {
    stmts.push(repo.setActive(ctx.db, userId, isActive, now));
    changes.is_active = isActive;
    if (!isActive) stmts.push(...repo.revokeAllSessions(ctx.db, userId, now));
  }
  stmts.push(audit(ctx, mod.id, "user.update", ["user", userId], changes));
  // Role changes take effect on the target's next request: every authed read loads the role from D1.
  await write(ctx, authed, "moderator", stmts);
  return { ok: true, ...changes };
}

export async function setOfficial(
  ctx: Ctx,
  authed: AuthedBatch,
  userId: string,
  body: { official: boolean; handle?: string | null | undefined },
) {
  // The handle is normalised before the read so the "taken" check rides in the same round trip. A malformed or
  // reserved handle is still reported after the 404 below, as in Python, because its errors are deferred.
  let handle: string | null = null;
  let handleError: unknown = null;
  if (body.handle !== undefined && body.handle !== null) {
    try {
      handle = checkHandle(body.handle, body.official);
    } catch (err) {
      handleError = err;
    }
  }
  const [admin, found, taken] = await authed.read(
    repo.profileOf(ctx.db, userId),
    repo.handleTaken(ctx.db, handle ?? "", userId),
  );
  const profile = found[0];
  if (profile === undefined || profile.onboardedAt === null) throw notFound();
  if (handleError !== null) throw handleError;
  if (handle !== null && taken.length > 0) throw conflict("That handle is taken");
  if (!body.official && handle === null && profile.handle && isReserved(profile.handle)) {
    throw conflict("This account holds a reserved handle; give it an ordinary one to revoke");
  }
  const before = { official: profile.isOfficial, handle: profile.handle };
  const after = { official: body.official, handle: handle ?? profile.handle };
  const clearName = !body.official && !!profile.displayName && mentionsBrand(profile.displayName);
  const now = ctx.clock.now();
  await write(ctx, authed, "admin", [
    repo.setOfficial(ctx.db, userId, { official: body.official, handle, clearName }, now),
    audit(ctx, admin.id, "user.official", ["user", userId], { before, after }),
  ]);
  return after;
}

/**
 * Merges `userId` into `body.into`. The merge is about a hundred and fifty statements (two per user column of every
 * table), far past the Workers Free plan's 50 D1 queries per invocation, so it runs on the queue in slices
 * (`mergeSlice`) and this answers 202. The request freezes the source first (sessions revoked, token version
 * bumped, inactive), so nothing can write to it between slices, and opens the audit row the slices complete.
 */
export async function merge(
  ctx: Ctx,
  authed: AuthedBatch,
  userId: string,
  body: { into: string; confirm_email: string; keep_source_profile: boolean },
) {
  const [admin, source, dest] = await authed.read(
    repo.userById(ctx.db, userId),
    repo.userById(ctx.db, body.into),
  );
  // Order matters (Python): 422 self, then 409 acting admin, then 404, then the typed-back email.
  if (userId === body.into) throw new HttpError(422, "Pick two different accounts");
  if (userId === admin.id) throw conflict("Sign in as another admin to merge this account away");
  const src = source[0];
  if (src === undefined || dest[0] === undefined) throw notFound();
  if (body.confirm_email.trim().toLowerCase() !== src.email.toLowerCase()) {
    throw new HttpError(422, "Type the source account's email to confirm");
  }
  const now = ctx.clock.now();
  const auditId = uuid7(now);
  await write(ctx, authed, "admin", [
    ...repo.revokeAllSessions(ctx.db, userId, now),
    repo.setActive(ctx.db, userId, false, now),
    repo.insertAudit(
      ctx.db,
      {
        id: auditId,
        actorId: admin.id,
        action: "user.merge",
        targetType: "user",
        targetId: body.into,
        detail: { source: userId, source_email: src.email, status: "running" },
      },
      now,
    ),
  ]);
  await enqueue(ctx.env.JOBS, [
    {
      type: "merge-slice",
      source: userId,
      into: body.into,
      keepSourceProfile: body.keep_source_profile,
      auditId,
      from: 0,
      moved: {},
    },
  ]);
  return { merged_into: body.into, status: "queued" as const };
}

/** Merge statements one slice may run: the plan's budget less the audit update and headroom. */
export const mergeSliceSize = (budget: number) => Math.max(1, budget - 5);

/**
 * One slice of a merge: runs the next `mergeSliceSize` statements of the (deterministic) plan in one atomic batch
 * and returns the message for the next slice, or `null` once the source is gone, the audit row carries the moved
 * counts and the destination's rebuild is queued. Re-running a slice is harmless: every statement is an
 * `UPDATE OR IGNORE` / `DELETE` keyed on the source, which the first run already emptied.
 */
export async function mergeSlice(
  ctx: Ctx,
  msg: MessageOf<"merge-slice">,
): Promise<MessageOf<"merge-slice"> | null> {
  const plan = mergePlan(ctx.db, msg.source, msg.into, msg.keepSourceProfile);
  const end = Math.min(plan.stmts.length, msg.from + mergeSliceSize(ctx.cfg.d1Budget));
  const part = plan.stmts.slice(msg.from, end);
  const results = part.length === 0 ? [] : ((await runBatch(ctx.db, part)) as unknown[]);
  const moved = { ...msg.moved };
  for (const [table, n] of Object.entries(movedCounts(plan, results, -msg.from, msg.from, end))) {
    moved[table] = (moved[table] ?? 0) + n;
  }
  if (end < plan.stmts.length) return { ...msg, from: end, moved };
  const sorted = Object.fromEntries(Object.entries(moved).sort(([a], [b]) => (a < b ? -1 : 1)));
  await runBatch(ctx.db, [repo.auditMoved(ctx.db, msg.auditId, sorted)]);
  // The destination's projections are rebuilt from the merged log by the GAME consumer.
  await enqueue(ctx.env.JOBS, [{ type: "recompute", userId: msg.into, full: true }]);
  return null;
}

/** Registers the `merge-slice` consumer: each slice enqueues the next, so a merge runs in order. */
export function registerConsumers(registry: ConsumerRegistry): void {
  registry.register("merge-slice", async (ctx, msg) => {
    const next = await mergeSlice(ctx, msg);
    if (next !== null) await enqueue(ctx.env.JOBS, [next]);
  });
}

// ---- audit and metrics --------------------------------------------------------------------------------------

export async function listAudit(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listAudit(ctx.db));
  return rows.map((a) => ({
    id: a.id,
    action: a.action,
    target_type: a.targetType,
    target_id: a.targetId,
    detail: a.detail,
    created_at: toWire(a.createdAt),
    actor: a.actor,
  }));
}

/** `meta.size_after` of a D1 result: the database size in bytes after the statement ran. */
const sizeAfter = (r: unknown): number | null => {
  const v = (r as D1Result | undefined)?.meta?.size_after;
  return typeof v === "number" ? v : null;
};

export async function metrics(ctx: Ctx, authed: AuthedBatch) {
  const now = ctx.clock.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [, users, onboarded, a1, a7, a30, sessions7, open, suspended, signups, beat, probe] =
    await authed.read(
      repo.countUsers(ctx.db),
      repo.countOnboarded(ctx.db),
      repo.countActiveSince(ctx.db, addDays(today, -1)),
      repo.countActiveSince(ctx.db, addDays(today, -7)),
      repo.countActiveSince(ctx.db, addDays(today, -30)),
      repo.countSessionsSince(ctx.db, addDays(today, -7)),
      repo.countOpenReports(ctx.db),
      repo.countSuspended(ctx.db),
      repo.signupsByWeek(ctx.db, now - 84 * 86_400_000),
      workerStateStmt(ctx.db),
      repo.sizeProbe(ctx.db),
    );
  return {
    users: n(users),
    onboarded: n(onboarded),
    active_1d: n(a1),
    active_7d: n(a7),
    active_30d: n(a30),
    sessions_7d: n(sessions7),
    open_reports: n(open),
    suspended: n(suspended),
    signups_by_week: signups.map((s) => ({ week: s.week, count: s.n })),
    worker: workerState(beat[0], now),
    database: { size_bytes: sizeAfter(probe) },
  };
}
