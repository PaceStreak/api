/** Admin queries (Python app/admin/router.py). Every list here is admin-only and bounded by a LIMIT. */
import { and, count, desc, eq, gte, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { withFoldPatch } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import type { UserRole } from "../../db/schema/auth.ts";
import {
  activityEvents,
  auditLog,
  challenges,
  comments,
  groups,
  notifications,
  profiles,
  reports,
  sessions,
  userStats,
  users,
  workouts,
} from "../../db/schema/index.ts";
import { likePattern } from "../../lib/fold.ts";

const reporter = alias(profiles, "reporter");
const reported = alias(profiles, "reported");

/** Reports with both sides' profiles and the reported user's actioned count, in one statement. */
export const listReports = (db: Db, status: "open" | "actioned" | "dismissed") =>
  db
    .select({
      id: reports.id,
      targetType: reports.targetType,
      targetId: reports.targetId,
      reason: reports.reason,
      detail: reports.detail,
      snapshot: reports.snapshot,
      status: reports.status,
      createdAt: reports.createdAt,
      resolution: reports.resolution,
      reportedUserId: reports.reportedUserId,
      reporterId: sql<string | null>`${reporter.userId}`.as("reporter_id"),
      reporterHandle: sql<string | null>`${reporter.handle}`.as("reporter_handle"),
      reporterName: sql<string | null>`${reporter.displayName}`.as("reporter_name"),
      reporterSuspended: sql<number | null>`${reporter.socialSuspendedAt}`.as("reporter_suspended"),
      reportedId: sql<string | null>`${reported.userId}`.as("reported_id"),
      reportedHandle: sql<string | null>`${reported.handle}`.as("reported_handle"),
      reportedName: sql<string | null>`${reported.displayName}`.as("reported_name"),
      reportedSuspended: sql<number | null>`${reported.socialSuspendedAt}`.as("reported_suspended"),
      priorActioned:
        sql<number>`(SELECT count(*) FROM reports p WHERE p.reported_user_id = ${reports.reportedUserId} AND p.status = 'actioned')`.as(
          "prior_actioned",
        ),
    })
    .from(reports)
    .leftJoin(reporter, eq(reporter.userId, reports.reporterId))
    .leftJoin(reported, eq(reported.userId, reports.reportedUserId))
    .where(eq(reports.status, status))
    .orderBy(desc(reports.createdAt))
    .limit(200);

export const reportById = (db: Db, id: string) => db.select().from(reports).where(eq(reports.id, id));

/** The table a report's target lives in; `user` targets have nothing to hide. */
export const HIDEABLE = {
  comment: comments,
  event: activityEvents,
  group: groups,
  challenge: challenges,
} as const;
export type HideableType = keyof typeof HIDEABLE;

const reportTarget = (id: string) => sql`(SELECT target_id FROM reports WHERE id = ${id})`;

/** Whether the report's target row exists in each hideable table (the report's type picks one). */
export const targetExists = (db: Db, reportId: string) =>
  db
    .select({
      comment: sql<number>`EXISTS (SELECT 1 FROM comments WHERE id = ${reportTarget(reportId)})`.as(
        "comment",
      ),
      event: sql<number>`EXISTS (SELECT 1 FROM activity_events WHERE id = ${reportTarget(reportId)})`.as(
        "event",
      ),
      group: sql<number>`EXISTS (SELECT 1 FROM groups WHERE id = ${reportTarget(reportId)})`.as("group"),
      challenge: sql<number>`EXISTS (SELECT 1 FROM challenges WHERE id = ${reportTarget(reportId)})`.as(
        "challenge",
      ),
      reportedProfile:
        sql<number>`EXISTS (SELECT 1 FROM profiles WHERE user_id = (SELECT reported_user_id FROM reports WHERE id = ${reportId}))`.as(
          "reported_profile",
        ),
    })
    .from(sql`(SELECT 1)`);

export const openSiblings = (db: Db, reportId: string) =>
  db
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.status, "open"),
        ne(reports.id, reportId),
        eq(reports.targetType, sql`(SELECT target_type FROM reports WHERE id = ${reportId})`),
        eq(reports.targetId, sql`(SELECT target_id FROM reports WHERE id = ${reportId})`),
      ),
    );

export const hideTarget = (db: Db, type: HideableType, id: string, now: number) => {
  const t = HIDEABLE[type];
  return db.update(t).set({ hiddenAt: now, updatedAt: now }).where(eq(t.id, id));
};

export const suspendProfile = (db: Db, userId: string, now: number) =>
  db
    .update(profiles)
    .set({ socialSuspendedAt: now, leaderboardOptIn: false, updatedAt: now })
    .where(eq(profiles.userId, userId));

export const unsuspendProfile = (db: Db, userId: string, now: number) =>
  db.update(profiles).set({ socialSuspendedAt: null, updatedAt: now }).where(eq(profiles.userId, userId));

export const resolveReports = (
  db: Db,
  ids: string[],
  r: { status: "actioned" | "dismissed"; by: string; now: number; resolution: (id: string) => string },
) =>
  ids.map((id) =>
    db
      .update(reports)
      .set({
        status: r.status,
        resolvedBy: r.by,
        resolvedAt: r.now,
        resolution: r.resolution(id),
        updatedAt: r.now,
      })
      .where(eq(reports.id, id)),
  );

export const insertNotification = (
  db: Db,
  n: { id: string; userId: string; kind: string; category: string; title: string; body: string; url: string },
  now: number,
) => db.insert(notifications).values({ ...n, createdAt: now, updatedAt: now });

export const insertAudit = (
  db: Db,
  a: {
    id: string;
    actorId: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    detail: Record<string, unknown> | null;
  },
  now: number,
) => db.insert(auditLog).values({ ...a, createdAt: now, updatedAt: now });

const reportCount = sql<number>`(SELECT count(*) FROM reports r WHERE r.reported_user_id = ${users.id})`;

/**
 * `email LIKE %q% OR handle LIKE %q%`. Python passed `%` and `_` through unescaped; here they are literal (the
 * search box is for finding a person, not for patterns). SQLite LIKE is case-insensitive for ASCII like ILIKE.
 */
export const searchUsers = (db: Db, q: string) => {
  const term = q.trim().toLowerCase();
  const where: SQL | undefined =
    q === ""
      ? undefined
      : or(
          sql`${users.email} LIKE ${likePattern(term, "contains")} ESCAPE '\\'`,
          sql`${profiles.handle} LIKE ${likePattern(term, "contains")} ESCAPE '\\'`,
        );
  return db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      isVerified: users.isVerified,
      createdAt: users.createdAt,
      handle: profiles.handle,
      displayName: profiles.displayName,
      socialSuspendedAt: profiles.socialSuspendedAt,
      isOfficial: profiles.isOfficial,
      deletionScheduledAt: profiles.deletionScheduledAt,
      reports: reportCount.as("reports"),
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(100);
};

export const userById = (db: Db, id: string) =>
  db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, id));

export const profileOf = (db: Db, userId: string) =>
  db
    .select({
      userId: profiles.userId,
      handle: profiles.handle,
      displayName: profiles.displayName,
      isOfficial: profiles.isOfficial,
      onboardedAt: profiles.onboardedAt,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId));

export const handleTaken = (db: Db, handle: string, userId: string) =>
  db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(eq(profiles.handle, handle), ne(profiles.userId, userId)));

export const setOfficial = (
  db: Db,
  userId: string,
  o: { official: boolean; handle: string | null; clearName: boolean },
  now: number,
) =>
  db
    .update(profiles)
    .set(
      withFoldPatch(profiles, {
        isOfficial: o.official,
        ...(o.handle === null ? {} : { handle: o.handle }),
        ...(o.clearName ? { displayName: null } : {}),
        updatedAt: now,
      }),
    )
    .where(eq(profiles.userId, userId));

export const auditDetail = (db: Db, id: string, detail: Record<string, unknown>) =>
  db.update(auditLog).set({ detail }).where(eq(auditLog.id, id));

export const setRole = (db: Db, userId: string, role: UserRole, now: number) =>
  db.update(users).set({ role, updatedAt: now }).where(eq(users.id, userId));

export const setActive = (db: Db, userId: string, isActive: boolean, now: number) =>
  db.update(users).set({ isActive, updatedAt: now }).where(eq(users.id, userId));

/** Python `revoke_all_sessions`: every session revoked and the token version bumped. */
export const revokeAllSessions = (db: Db, userId: string, now: number) =>
  [
    db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: now })
      .where(eq(users.id, userId)),
  ] as const;

export const listAudit = (db: Db) =>
  db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      detail: auditLog.detail,
      createdAt: auditLog.createdAt,
      actor: profiles.handle,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.userId, auditLog.actorId))
    .orderBy(desc(auditLog.createdAt))
    .limit(200);

// ---- metrics ------------------------------------------------------------------------------------------------

export const countUsers = (db: Db) => db.select({ n: count() }).from(users);
export const countOnboarded = (db: Db) =>
  db.select({ n: count() }).from(profiles).where(isNotNull(profiles.onboardedAt));
export const countActiveSince = (db: Db, day: string) =>
  db.select({ n: count() }).from(userStats).where(gte(userStats.lastActive, day));
export const countSessionsSince = (db: Db, day: string) =>
  db
    .select({ n: count() })
    .from(workouts)
    .where(and(isNull(workouts.deletedAt), gte(workouts.localDate, day)));
export const countOpenReports = (db: Db) =>
  db.select({ n: count() }).from(reports).where(eq(reports.status, "open"));
export const countSuspended = (db: Db) =>
  db.select({ n: count() }).from(profiles).where(isNotNull(profiles.socialSuspendedAt));

/** ISO week (Monday, UTC) of each signup over the last 12 weeks. */
const signupWeek = sql<string>`date(${users.createdAt} / 1000, 'unixepoch', 'weekday 0', '-6 days')`;
export const signupsByWeek = (db: Db, since: number) =>
  db
    .select({ week: signupWeek.as("week"), n: count() })
    .from(users)
    .where(gte(users.createdAt, since))
    .groupBy(sql`week`)
    .orderBy(sql`week`);

/**
 * D1 reports the database size in every result's `meta.size_after`; this no-op statement is there to carry it.
 * (`PRAGMA page_count` is refused by D1 with SQLITE_AUTH.)
 */
export const sizeProbe = (db: Db) => db.run(sql`SELECT 1`);

const ADMIN = "admin-only, bounded by LIMIT";
const METRIC = "admin-only metrics count";

export const explain: ExplainCase[] = [
  { name: "admin.listReports", build: (db) => listReports(db, "open") },
  { name: "admin.reportById", build: (db) => reportById(db, "r") },
  { name: "admin.targetExists", build: (db) => targetExists(db, "r") },
  { name: "admin.openSiblings", build: (db) => openSiblings(db, "r") },
  { name: "admin.hideTarget.comment", build: (db) => hideTarget(db, "comment", "x", 0) },
  { name: "admin.suspendProfile", build: (db) => suspendProfile(db, "u", 0) },
  {
    name: "admin.resolveReports",
    build: (db) =>
      resolveReports(db, ["r"], { status: "actioned", by: "u", now: 0, resolution: () => "x" })[0] ??
      reportById(db, "r"),
  },
  { name: "admin.searchUsers", build: (db) => searchUsers(db, ""), scanOk: ADMIN },
  { name: "admin.searchUsers.q", build: (db) => searchUsers(db, "ann"), scanOk: `${ADMIN}; contains search` },
  { name: "admin.userById", build: (db) => userById(db, "u") },
  { name: "admin.profileOf", build: (db) => profileOf(db, "u") },
  { name: "admin.handleTaken", build: (db) => handleTaken(db, "h", "u") },
  { name: "admin.revokeAllSessions", build: (db) => revokeAllSessions(db, "u", 0)[0] },
  { name: "admin.listAudit", build: (db) => listAudit(db), scanOk: "index-ordered scan, LIMIT 200" },
  { name: "admin.countUsers", build: (db) => countUsers(db), scanOk: METRIC },
  { name: "admin.countOnboarded", build: (db) => countOnboarded(db), scanOk: METRIC },
  { name: "admin.countActiveSince", build: (db) => countActiveSince(db, "2026-01-01"), scanOk: METRIC },
  { name: "admin.countSessionsSince", build: (db) => countSessionsSince(db, "2026-01-01"), scanOk: METRIC },
  { name: "admin.countOpenReports", build: (db) => countOpenReports(db) },
  { name: "admin.countSuspended", build: (db) => countSuspended(db), scanOk: METRIC },
  { name: "admin.signupsByWeek", build: (db) => signupsByWeek(db, 0), scanOk: METRIC },
];
