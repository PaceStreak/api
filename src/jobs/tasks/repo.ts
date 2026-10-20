/**
 * Query builders for the twelve worker jobs (spec/misc.md §4). Every candidate query is driven by an index: the
 * local-hour jobs by `ix_profiles_timezone` (zones grouped by their local hour in JS, see jobs/zones.ts), the rest
 * by the partial or retention indexes named next to each builder. `IN (...)` lists are chunked by the callers
 * (D1 binds at most 100 parameters per statement).
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  bodyPhotos,
  buddyPairs,
  clientErrors,
  exportJobs,
  habitLogs,
  habits,
  importJobs,
  notificationPreferences,
  notifications,
  profiles,
  rateCounters,
  sessions,
  streakPauses,
  userStats,
  users,
} from "../../db/schema/index.ts";

/** Most values bound into one `IN (...)` list, leaving room for the statement's other parameters. */
export const IN_CHUNK = 90;
/** Python's candidate caps: BATCH (500) for stats, 5000 for the hour-matched jobs. */
export const STATS_LIMIT = 500;
export const CANDIDATE_LIMIT = 5000;

/** Onboarded, not leaving, account active: who the nudges and summaries are for. */
const eligible = () =>
  and(isNotNull(profiles.onboardedAt), isNull(profiles.deletionScheduledAt), eq(users.isActive, true));

/** Every zone in use; resolved to local hours once per tick (jobs/zones.ts). */
export const distinctZones = (db: Db) => db.selectDistinct({ tz: profiles.timezone }).from(profiles);

// ---- 1. stats ---------------------------------------------------------------------------------------------------

/** Projections computed for a local date before `today`, in zones whose local date is `today`. */
export const staleStats = (db: Db, zones: string[], today: string) =>
  db
    .select({ userId: userStats.userId, computedAt: userStats.computedAt })
    .from(profiles)
    .innerJoin(userStats, eq(userStats.userId, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), lt(userStats.computedFor, today)))
    .orderBy(asc(userStats.computedAt))
    .limit(STATS_LIMIT);

// ---- 2. nudges --------------------------------------------------------------------------------------------------

/** Smart mode nudges at the learned hour when there is one; everyone else at their fixed hour. */
const nudgeHour = sql<number>`CASE WHEN ${profiles.reminderMode} = 'smart' AND ${profiles.learnedReminderHour} IS NOT NULL THEN ${profiles.learnedReminderHour} ELSE ${profiles.reminderHour} END`;

const nudgeCols = {
  userId: profiles.userId,
  timezone: profiles.timezone,
  reminderMode: profiles.reminderMode,
  reminderHour: profiles.reminderHour,
  learnedReminderHour: profiles.learnedReminderHour,
};

export type NudgeRow = Awaited<ReturnType<typeof nudgeCandidates>>[number];

export const nudgeCandidates = (db: Db, zones: string[], hour: number) =>
  db
    .select(nudgeCols)
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), eligible(), sql`${nudgeHour} = ${hour}`))
    .limit(CANDIDATE_LIMIT);

/** Re-read by the slice consumer, which checks the hour again at its own `now`. */
export const nudgeRows = (db: Db, userIds: string[]) =>
  db
    .select(nudgeCols)
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(inArray(profiles.userId, userIds), eligible()));

// ---- 3-5. habits ------------------------------------------------------------------------------------------------

const habitCols = {
  id: habits.id,
  userId: habits.userId,
  name: habits.name,
  emoji: habits.emoji,
  kind: habits.kind,
  unit: habits.unit,
  dailyGoal: habits.dailyGoal,
  cue: habits.cue,
  remindHour: habits.remindHour,
  startedOn: habits.startedOn,
  archivedAt: habits.archivedAt,
  snoozedUntil: habits.snoozedUntil,
  daysMask: habits.daysMask,
  pausedFrom: habits.pausedFrom,
  pausedUntil: habits.pausedUntil,
  timezone: profiles.timezone,
};

export type HabitRow = Awaited<ReturnType<typeof reminderRows>>[number];

/** Python `habit_reminders` filter: a remind hour, live, not a quit habit, no evening summary chosen instead. */
const reminderFilter = () =>
  and(
    isNotNull(habits.remindHour),
    isNull(habits.archivedAt),
    ne(habits.kind, "quit"),
    eligible(),
    isNull(notificationPreferences.habitSummaryHour),
  );

export const reminderCandidates = (db: Db, zones: string[], hour: number) =>
  db
    .select({ id: habits.id })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .innerJoin(habits, eq(habits.userId, profiles.userId))
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), eq(habits.remindHour, hour), reminderFilter()))
    .limit(CANDIDATE_LIMIT);

export const reminderRows = (db: Db, habitIds: string[]) =>
  db
    .select(habitCols)
    .from(habits)
    .innerJoin(profiles, eq(profiles.userId, habits.userId))
    .innerJoin(users, eq(users.id, habits.userId))
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, habits.userId))
    .where(and(inArray(habits.id, habitIds), reminderFilter()));

/** Every snooze that ran out (ix_habits_snoozed_until), whoever owns it: each one is cleared once it fires. */
export const dueSnoozes = (db: Db, now: number) =>
  db
    .select({ id: habits.id })
    .from(habits)
    .where(and(isNotNull(habits.snoozedUntil), lte(habits.snoozedUntil, now)))
    .limit(CANDIDATE_LIMIT);

/** The due snoozes among `habitIds`, with whether their owner may still be reminded. */
export const snoozeRows = (db: Db, habitIds: string[], now: number) =>
  db
    .select({
      ...habitCols,
      remindable: sql<number>`(${users.isActive} = 1 AND ${profiles.deletionScheduledAt} IS NULL)`.as(
        "remindable",
      ),
    })
    .from(habits)
    .innerJoin(profiles, eq(profiles.userId, habits.userId))
    .innerJoin(users, eq(users.id, habits.userId))
    .where(and(inArray(habits.id, habitIds), isNotNull(habits.snoozedUntil), lte(habits.snoozedUntil, now)));

/**
 * Clears exactly the snoozes that fired, in ONE statement: a newer snooze set meanwhile (its `snoozed_until`
 * differs from `due`) is kept.
 */
export const clearSnoozesSql = (fired: readonly { id: string; due: number }[], now: number) =>
  sql`UPDATE habits SET snoozed_until = NULL, updated_at = ${now}
    FROM json_each(${JSON.stringify(fired)}) AS j
    WHERE habits.id = j.value ->> 'id' AND habits.snoozed_until = j.value ->> 'due'`;

export const clearSnoozes = (db: Db, fired: readonly { id: string; due: number }[], now: number) =>
  db.run(clearSnoozesSql(fired, now));

const summaryFilter = () => and(isNotNull(notificationPreferences.habitSummaryHour), eligible());

const summaryCols = {
  userId: profiles.userId,
  timezone: profiles.timezone,
  hour: notificationPreferences.habitSummaryHour,
};

export const summaryCandidates = (db: Db, zones: string[], hour: number) =>
  db
    .select({ userId: profiles.userId })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .innerJoin(notificationPreferences, eq(notificationPreferences.userId, profiles.userId))
    .where(
      and(
        inArray(profiles.timezone, zones),
        eq(notificationPreferences.habitSummaryHour, hour),
        summaryFilter(),
      ),
    )
    .limit(CANDIDATE_LIMIT);

export const summaryRows = (db: Db, userIds: string[]) =>
  db
    .select(summaryCols)
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .innerJoin(notificationPreferences, eq(notificationPreferences.userId, profiles.userId))
    .where(and(inArray(profiles.userId, userIds), summaryFilter()));

/** Live, non-quit habits of `userIds` (ix_habits_user_name). */
export const openHabits = (db: Db, userIds: string[]) =>
  db
    .select(habitCols)
    .from(habits)
    .innerJoin(profiles, eq(profiles.userId, habits.userId))
    .where(and(inArray(habits.userId, userIds), isNull(habits.archivedAt), ne(habits.kind, "quit")));

/** Streak pauses of `userIds`; "active today" is decided in JS (ix_streak_pauses_user_start). */
export const pausesOf = (db: Db, userIds: string[]) =>
  db
    .select({ userId: streakPauses.userId, startsOn: streakPauses.startsOn, endsOn: streakPauses.endsOn })
    .from(streakPauses)
    .where(inArray(streakPauses.userId, userIds));

/** Logs of `habitIds` on any of `days` (uq_habit_log_day). */
export const logsOn = (db: Db, habitIds: string[], days: string[]) =>
  db
    .select({ habitId: habitLogs.habitId, day: habitLogs.day, amount: habitLogs.amount })
    .from(habitLogs)
    .where(and(inArray(habitLogs.habitId, habitIds), inArray(habitLogs.day, days)));

/** Logs of `userIds` on any of `days` (ix_habit_logs_user_day). */
export const userLogsOn = (db: Db, userIds: string[], days: string[]) =>
  db
    .select({ habitId: habitLogs.habitId, day: habitLogs.day, amount: habitLogs.amount })
    .from(habitLogs)
    .where(and(inArray(habitLogs.userId, userIds), inArray(habitLogs.day, days)));

// ---- 6. digest and 8. backup ------------------------------------------------------------------------------------

const localCols = {
  userId: profiles.userId,
  timezone: profiles.timezone,
  weekStartsOn: profiles.weekStartsOn,
};

/** At local 09:00 on the first day of their week: `zones` are the zones where it is 09:00 on weekday `weekday`. */
export const digestCandidates = (db: Db, zones: string[], weekday: number) =>
  db
    .select({ userId: profiles.userId })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), eq(profiles.weekStartsOn, weekday), eligible()))
    .limit(CANDIDATE_LIMIT);

export const localRows = (db: Db, userIds: string[]) =>
  db
    .select(localCols)
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(inArray(profiles.userId, userIds), eligible()));

/**
 * Backup reminders at local 09:00: monthly people on the 1st, weekly people on the first day of their week. No
 * preferences row means never asked (an inner join, as in Python).
 */
export const backupCandidates = (db: Db, zones: string[], weekday: number, firstOfMonth: boolean) => {
  const weekly = and(
    eq(notificationPreferences.backupFrequency, "weekly"),
    eq(profiles.weekStartsOn, weekday),
  );
  const when: SQL | undefined = firstOfMonth
    ? or(eq(notificationPreferences.backupFrequency, "monthly"), weekly)
    : weekly;
  return db
    .select({ userId: profiles.userId })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .innerJoin(notificationPreferences, eq(notificationPreferences.userId, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), when, eligible()))
    .limit(CANDIDATE_LIMIT);
};

export const backupRows = (db: Db, userIds: string[]) =>
  db
    .select({
      ...localCols,
      channels: notificationPreferences.channels,
      attach: notificationPreferences.backupAttachment,
      frequency: notificationPreferences.backupFrequency,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .innerJoin(notificationPreferences, eq(notificationPreferences.userId, profiles.userId))
    .where(and(inArray(profiles.userId, userIds), eligible()));

// ---- 9. buddies -------------------------------------------------------------------------------------------------

/** Active pairs with a side in `zones` (helpers at 17:00): one statement per side, each on its own index. */
export const buddyCandidates = (db: Db, zones: string[], side: "a" | "b") => {
  const col = side === "a" ? buddyPairs.userA : buddyPairs.userB;
  return db
    .select({ id: buddyPairs.id })
    .from(profiles)
    .innerJoin(buddyPairs, eq(col, profiles.userId))
    .where(and(inArray(profiles.timezone, zones), eq(buddyPairs.status, "active")))
    .limit(CANDIDATE_LIMIT);
};

export const activePairs = (db: Db, pairIds: string[]) =>
  db
    .select({ id: buddyPairs.id, userA: buddyPairs.userA, userB: buddyPairs.userB })
    .from(buddyPairs)
    .where(and(inArray(buddyPairs.id, pairIds), eq(buddyPairs.status, "active")));

/** Both sides' profiles; `live` = may hear about or be talked about (active, not leaving). */
export const buddyProfiles = (db: Db, userIds: string[]) =>
  db
    .select({
      userId: profiles.userId,
      handle: profiles.handle,
      timezone: profiles.timezone,
      weekStartsOn: profiles.weekStartsOn,
      live: sql<number>`(${users.isActive} = 1 AND ${profiles.deletionScheduledAt} IS NULL)`.as("live"),
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(inArray(profiles.userId, userIds));

export const buddyStats = (db: Db, userIds: string[]) =>
  db
    .select({
      userId: userStats.userId,
      recentWeeks: userStats.recentWeeks,
      thisWeekDays: userStats.thisWeekDays,
      thisWeekTarget: userStats.thisWeekTarget,
    })
    .from(userStats)
    .where(inArray(userStats.userId, userIds));

// ---- 10. purge --------------------------------------------------------------------------------------------------

/** Accounts whose deletion grace period ran out (partial ix_profiles_deletion_scheduled_at). */
export const duePurges = (db: Db, now: number) =>
  db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(isNotNull(profiles.deletionScheduledAt), lt(profiles.deletionScheduledAt, now)))
    .limit(STATS_LIMIT);

/** Re-checked inside the purge batch, so a deletion cancelled after dispatch is never carried out. */
const stillDue = (userIds: string[], now: number) =>
  sql`(SELECT ${profiles.userId} FROM ${profiles} WHERE ${inArray(profiles.userId, userIds)} AND ${profiles.deletionScheduledAt} < ${now})`;

export const purgePhotoKeys = (db: Db, userIds: string[], now: number) =>
  db
    .select({ key: bodyPhotos.objectKey })
    .from(bodyPhotos)
    .where(sql`${bodyPhotos.userId} IN ${stillDue(userIds, now)}`);

export const purgeImportKeys = (db: Db, userIds: string[], now: number) =>
  db
    .select({ key: importJobs.objectKey })
    .from(importJobs)
    .where(sql`${importJobs.userId} IN ${stillDue(userIds, now)}`);

export const purgeExportKeys = (db: Db, userIds: string[], now: number) =>
  db
    .select({ key: exportJobs.objectKey, parts: exportJobs.parts })
    .from(exportJobs)
    .where(sql`${exportJobs.userId} IN ${stillDue(userIds, now)}`);

/** Cascades to every table keyed on the user (D1 enforces foreign keys). */
export const purgeUsers = (db: Db, userIds: string[], now: number) =>
  db
    .delete(users)
    .where(sql`${users.id} IN ${stillDue(userIds, now)}`)
    .returning({ id: users.id });

// ---- 11. housekeeping -------------------------------------------------------------------------------------------

export const NOTIFICATION_RETENTION_MS = 180 * 86_400_000;
/** The longest rate-limit window is a day; a counter older than two is dead. */
export const RATE_COUNTER_RETENTION_MS = 2 * 86_400_000;
/** Import and export jobs finish in minutes; a week later the row and its staged objects go. */
export const STAGING_RETENTION_MS = 7 * 86_400_000;
/** Staged rows swept per night; the rest wait for the next night. */
export const STAGING_SWEEP_LIMIT = 500;

export const oldNotifications = (db: Db, before: number) =>
  db.delete(notifications).where(lt(notifications.createdAt, before));

export const oldRateCounters = (db: Db, before: number) =>
  db.delete(rateCounters).where(lt(rateCounters.windowStart, before));

/** Expired sessions; their refresh tokens cascade. */
export const expiredSessions = (db: Db, now: number) =>
  db.delete(sessions).where(lt(sessions.expiresAt, now));

export const oldImportJobs = (db: Db, before: number) =>
  db
    .select({ id: importJobs.id, key: importJobs.objectKey })
    .from(importJobs)
    .where(lt(importJobs.createdAt, before))
    .limit(STAGING_SWEEP_LIMIT);

export const oldExportJobs = (db: Db, before: number) =>
  db
    .select({ id: exportJobs.id, key: exportJobs.objectKey, parts: exportJobs.parts })
    .from(exportJobs)
    .where(lt(exportJobs.createdAt, before))
    .limit(STAGING_SWEEP_LIMIT);

export const deleteImportJobs = (db: Db, ids: string[]) =>
  db.delete(importJobs).where(inArray(importJobs.id, ids));
export const deleteExportJobs = (db: Db, ids: string[]) =>
  db.delete(exportJobs).where(inArray(exportJobs.id, ids));

// ---- 12. error alerts -------------------------------------------------------------------------------------------

export const ALERT_LIMIT = 20;

/** Crash groups never alerted and first seen since `since` (partial ix_client_errors_unalerted). */
export const unalertedErrors = (db: Db, since: number) =>
  db
    .select({
      id: clientErrors.id,
      message: clientErrors.message,
      path: clientErrors.path,
      count: clientErrors.count,
      firstSeen: clientErrors.firstSeen,
    })
    .from(clientErrors)
    .where(and(isNull(clientErrors.alertedAt), gte(clientErrors.firstSeen, since)))
    .orderBy(desc(clientErrors.count))
    .limit(ALERT_LIMIT);

export const activeAdmins = (db: Db) =>
  db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.isActive, true)));

export const markAlerted = (db: Db, ids: string[], now: number) =>
  db
    .update(clientErrors)
    .set({ alertedAt: now, updatedAt: now })
    .where(and(inArray(clientErrors.id, ids), isNull(clientErrors.alertedAt)));

// ---- EXPLAIN lint -----------------------------------------------------------------------------------------------

const Z = ["UTC", "Asia/Kolkata"];
const IDS = ["a", "b"];

export const explain: ExplainCase[] = [
  {
    name: "jobs.distinctZones",
    build: (db) => distinctZones(db),
    scanOk: "covering scan of ix_profiles_timezone, once per tick",
  },
  { name: "jobs.staleStats", build: (db) => staleStats(db, Z, "2026-10-14") },
  { name: "jobs.nudgeCandidates", build: (db) => nudgeCandidates(db, Z, 18) },
  { name: "jobs.nudgeRows", build: (db) => nudgeRows(db, IDS) },
  { name: "jobs.reminderCandidates", build: (db) => reminderCandidates(db, Z, 18) },
  { name: "jobs.reminderRows", build: (db) => reminderRows(db, IDS) },
  { name: "jobs.dueSnoozes", build: (db) => dueSnoozes(db, 0) },
  { name: "jobs.snoozeRows", build: (db) => snoozeRows(db, IDS, 0) },
  { name: "jobs.clearSnoozes", build: () => clearSnoozesSql([], 0) },
  { name: "jobs.summaryCandidates", build: (db) => summaryCandidates(db, Z, 18) },
  { name: "jobs.summaryRows", build: (db) => summaryRows(db, IDS) },
  { name: "jobs.openHabits", build: (db) => openHabits(db, IDS) },
  { name: "jobs.pausesOf", build: (db) => pausesOf(db, IDS) },
  { name: "jobs.logsOn", build: (db) => logsOn(db, IDS, ["2026-10-14"]) },
  { name: "jobs.userLogsOn", build: (db) => userLogsOn(db, IDS, ["2026-10-14"]) },
  { name: "jobs.digestCandidates", build: (db) => digestCandidates(db, Z, 0) },
  { name: "jobs.localRows", build: (db) => localRows(db, IDS) },
  { name: "jobs.backupCandidates", build: (db) => backupCandidates(db, Z, 0, true) },
  { name: "jobs.backupRows", build: (db) => backupRows(db, IDS) },
  { name: "jobs.buddyCandidatesA", build: (db) => buddyCandidates(db, Z, "a") },
  { name: "jobs.buddyCandidatesB", build: (db) => buddyCandidates(db, Z, "b") },
  { name: "jobs.activePairs", build: (db) => activePairs(db, IDS) },
  { name: "jobs.buddyProfiles", build: (db) => buddyProfiles(db, IDS) },
  { name: "jobs.buddyStats", build: (db) => buddyStats(db, IDS) },
  { name: "jobs.duePurges", build: (db) => duePurges(db, 0) },
  { name: "jobs.purgePhotoKeys", build: (db) => purgePhotoKeys(db, IDS, 0) },
  { name: "jobs.purgeImportKeys", build: (db) => purgeImportKeys(db, IDS, 0) },
  { name: "jobs.purgeExportKeys", build: (db) => purgeExportKeys(db, IDS, 0) },
  { name: "jobs.purgeUsers", build: (db) => purgeUsers(db, IDS, 0) },
  { name: "jobs.oldNotifications", build: (db) => oldNotifications(db, 0) },
  { name: "jobs.oldRateCounters", build: (db) => oldRateCounters(db, 0) },
  { name: "jobs.expiredSessions", build: (db) => expiredSessions(db, 0) },
  { name: "jobs.oldImportJobs", build: (db) => oldImportJobs(db, 0) },
  { name: "jobs.oldExportJobs", build: (db) => oldExportJobs(db, 0) },
  { name: "jobs.deleteImportJobs", build: (db) => deleteImportJobs(db, IDS) },
  { name: "jobs.deleteExportJobs", build: (db) => deleteExportJobs(db, IDS) },
  { name: "jobs.unalertedErrors", build: (db) => unalertedErrors(db, 0) },
  { name: "jobs.activeAdmins", build: (db) => activeAdmins(db) },
  { name: "jobs.markAlerted", build: (db) => markAlerted(db, IDS, 0) },
];
