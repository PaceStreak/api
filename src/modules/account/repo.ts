/**
 * Account queries (spec/account.md §3): export reads, import context and bulk inserts, deletion, security events,
 * the calendar feed and queued import jobs. Builders are returned un-awaited; the service batches them.
 */
import { and, asc, count, desc, eq, gte, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  blocks,
  bodyMetrics,
  bodyPhotos,
  buddyPairs,
  challengeParticipants,
  challenges,
  comments,
  customExercises,
  exerciseNotes,
  follows,
  foods,
  gear,
  groupMembers,
  groups,
  gyms,
  habitLogs,
  habitRoutines,
  habits,
  importJobs,
  journalDays,
  mealEntries,
  monthlyGoals,
  notificationPreferences,
  nutritionTargets,
  personalRecords,
  profiles,
  readiness,
  recipes,
  restDays,
  routines,
  securityEvents,
  streakChains,
  streakPauses,
  streakRepairs,
  streakWagers,
  trainingBlocks,
  trainingPlans,
  userAchievements,
  users,
  weekReflections,
  weighIns,
  weightGoals,
  workoutSets,
  workouts,
} from "../../db/schema/index.ts";

// ---- export reads -------------------------------------------------------------------------------------------

export const account = (db: Db, userId: string) =>
  db
    .select({
      email: users.email,
      createdAt: users.createdAt,
      isVerified: users.isVerified,
      totpEnabled: users.totpEnabled,
      hashedPassword: users.hashedPassword,
    })
    .from(users)
    .where(eq(users.id, userId));

export const profileRow = (db: Db, userId: string) =>
  db.select().from(profiles).where(eq(profiles.userId, userId));

export const chains = (db: Db, userId: string) =>
  db
    .select()
    .from(streakChains)
    .where(and(eq(streakChains.userId, userId), eq(streakChains.archived, false)))
    .orderBy(asc(streakChains.position), asc(streakChains.createdAt));

// Python read most sections in heap order; each gets a stable order here.
export const repairs = (db: Db, u: string) =>
  db.select().from(streakRepairs).where(eq(streakRepairs.userId, u)).orderBy(asc(streakRepairs.weekStart));
export const pauses = (db: Db, u: string) =>
  db.select().from(streakPauses).where(eq(streakPauses.userId, u)).orderBy(asc(streakPauses.startsOn));
export const customs = (db: Db, u: string) =>
  db
    .select()
    .from(customExercises)
    .where(eq(customExercises.userId, u))
    .orderBy(asc(customExercises.createdAt));

export const liveWorkouts = (db: Db, u: string) =>
  db
    .select()
    .from(workouts)
    .where(and(eq(workouts.userId, u), isNull(workouts.deletedAt)))
    .orderBy(asc(workouts.startedAt));

/** Every set of the user's live workouts, in (workout, position, set) order. */
export const liveSets = (db: Db, u: string) =>
  db
    .select({
      workoutId: workoutSets.workoutId,
      exerciseId: workoutSets.exerciseId,
      position: workoutSets.position,
      setIndex: workoutSets.setIndex,
      superset: workoutSets.superset,
      kind: workoutSets.kind,
      weightKg: workoutSets.weightKg,
      reps: workoutSets.reps,
      rpe: workoutSets.rpe,
      durationSec: workoutSets.durationSec,
      distanceM: workoutSets.distanceM,
      completed: workoutSets.completed,
    })
    .from(workoutSets)
    .where(eq(workoutSets.userId, u))
    .orderBy(asc(workoutSets.workoutId), asc(workoutSets.position), asc(workoutSets.setIndex));

export const monthly = (db: Db, u: string) =>
  db.select().from(monthlyGoals).where(eq(monthlyGoals.userId, u)).orderBy(asc(monthlyGoals.month));
export const rest = (db: Db, u: string) =>
  db.select().from(restDays).where(eq(restDays.userId, u)).orderBy(asc(restDays.day));
export const gearRows = (db: Db, u: string) =>
  db.select().from(gear).where(eq(gear.userId, u)).orderBy(asc(gear.createdAt), asc(gear.id));
export const gymRows = (db: Db, u: string) =>
  db.select().from(gyms).where(eq(gyms.userId, u)).orderBy(asc(gyms.createdAt), asc(gyms.id));
export const notes = (db: Db, u: string) =>
  db.select().from(exerciseNotes).where(eq(exerciseNotes.userId, u)).orderBy(asc(exerciseNotes.exerciseId));
export const weightGoal = (db: Db, u: string) =>
  db.select().from(weightGoals).where(eq(weightGoals.userId, u)).limit(1);
export const habitRows = (db: Db, u: string) =>
  db.select().from(habits).where(eq(habits.userId, u)).orderBy(asc(habits.createdAt), asc(habits.id));
export const habitLogRows = (db: Db, u: string) =>
  db
    .select({
      habitId: habitLogs.habitId,
      day: habitLogs.day,
      amount: habitLogs.amount,
      note: habitLogs.note,
    })
    .from(habitLogs)
    .where(eq(habitLogs.userId, u))
    .orderBy(asc(habitLogs.day));
export const blocksRows = (db: Db, u: string) =>
  db.select().from(trainingBlocks).where(eq(trainingBlocks.userId, u)).orderBy(asc(trainingBlocks.startsOn));
export const readinessRows = (db: Db, u: string) =>
  db.select().from(readiness).where(eq(readiness.userId, u)).orderBy(asc(readiness.day));
export const reflections = (db: Db, u: string) =>
  db
    .select()
    .from(weekReflections)
    .where(eq(weekReflections.userId, u))
    .orderBy(asc(weekReflections.weekStart));
export const wagers = (db: Db, u: string) =>
  db.select().from(streakWagers).where(eq(streakWagers.userId, u)).orderBy(asc(streakWagers.weekStart));
export const plans = (db: Db, u: string) =>
  db.select().from(trainingPlans).where(eq(trainingPlans.userId, u)).orderBy(asc(trainingPlans.startedOn));
export const routineRows = (db: Db, u: string) =>
  db
    .select()
    .from(routines)
    .where(eq(routines.userId, u))
    .orderBy(asc(routines.position), asc(routines.nameFold));
export const metrics = (db: Db, u: string) =>
  db.select().from(bodyMetrics).where(eq(bodyMetrics.userId, u)).orderBy(asc(bodyMetrics.measuredOn));
export const photos = (db: Db, u: string) =>
  db.select().from(bodyPhotos).where(eq(bodyPhotos.userId, u)).orderBy(asc(bodyPhotos.takenOn));
export const weighInRows = (db: Db, u: string) =>
  db.select().from(weighIns).where(eq(weighIns.userId, u)).orderBy(asc(weighIns.weighedAt));
export const meals = (db: Db, u: string) =>
  db
    .select()
    .from(mealEntries)
    .where(eq(mealEntries.userId, u))
    .orderBy(asc(mealEntries.day), asc(mealEntries.createdAt));
export const foodRows = (db: Db, u: string) =>
  db.select().from(foods).where(eq(foods.userId, u)).orderBy(asc(foods.nameFold), asc(foods.name));
export const recipeRows = (db: Db, u: string) =>
  db.select().from(recipes).where(eq(recipes.userId, u)).orderBy(asc(recipes.nameFold), asc(recipes.name));
export const journal = (db: Db, u: string) =>
  db.select().from(journalDays).where(eq(journalDays.userId, u)).orderBy(asc(journalDays.day));
export const habitRoutineRows = (db: Db, u: string) =>
  db.select().from(habitRoutines).where(eq(habitRoutines.userId, u)).orderBy(asc(habitRoutines.createdAt));
export const nutritionTarget = (db: Db, u: string) =>
  db.select().from(nutritionTargets).where(eq(nutritionTargets.userId, u)).limit(1);
export const achievements = (db: Db, u: string) =>
  db
    .select()
    .from(userAchievements)
    .where(eq(userAchievements.userId, u))
    .orderBy(asc(userAchievements.unlockedOn));
export const records = (db: Db, u: string) =>
  db
    .select()
    .from(personalRecords)
    .where(eq(personalRecords.userId, u))
    .orderBy(asc(personalRecords.key), asc(personalRecords.achievedOn));

const other = alias(profiles, "other");

/** Handles of accounts the user follows (accepted). */
export const following = (db: Db, u: string) =>
  db
    .select({ handle: other.handle })
    .from(follows)
    .leftJoin(other, eq(other.userId, follows.followeeId))
    .where(and(eq(follows.followerId, u), eq(follows.status, "accepted")))
    .orderBy(asc(follows.createdAt));

export const followers = (db: Db, u: string) =>
  db
    .select({ handle: other.handle })
    .from(follows)
    .leftJoin(other, eq(other.userId, follows.followerId))
    .where(and(eq(follows.followeeId, u), eq(follows.status, "accepted")))
    .orderBy(asc(follows.createdAt));

export const blockedCount = (db: Db, u: string) =>
  db.select({ n: count() }).from(blocks).where(eq(blocks.blockerId, u));

/** Buddy pairs on either side, with the other person's handle. Two index lookups, unioned in the service. */
export const buddiesAsA = (db: Db, u: string) =>
  db
    .select({
      handle: other.handle,
      status: buddyPairs.status,
      startedAt: buddyPairs.startedAt,
      endedAt: buddyPairs.endedAt,
      createdAt: buddyPairs.createdAt,
    })
    .from(buddyPairs)
    .leftJoin(other, eq(other.userId, buddyPairs.userB))
    .where(eq(buddyPairs.userA, u));

export const buddiesAsB = (db: Db, u: string) =>
  db
    .select({
      handle: other.handle,
      status: buddyPairs.status,
      startedAt: buddyPairs.startedAt,
      endedAt: buddyPairs.endedAt,
      createdAt: buddyPairs.createdAt,
    })
    .from(buddyPairs)
    .leftJoin(other, eq(other.userId, buddyPairs.userA))
    .where(eq(buddyPairs.userB, u));

export const authoredComments = (db: Db, u: string) =>
  db
    .select({
      id: comments.id,
      eventId: comments.eventId,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.authorId, u))
    .orderBy(asc(comments.createdAt));

export const memberships = (db: Db, u: string) =>
  db
    .select({
      name: groups.name,
      role: groupMembers.role,
      joinedAt: groupMembers.createdAt,
      sharesWithCoach: groupMembers.sharesWithCoach,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, u))
    .orderBy(asc(groupMembers.createdAt));

export const challengeRows = (db: Db, u: string) =>
  db
    .select({
      title: challenges.title,
      startsOn: challenges.startsOn,
      endsOn: challenges.endsOn,
      finalScore: challengeParticipants.finalScore,
      finalRank: challengeParticipants.finalRank,
    })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(eq(challengeParticipants.userId, u))
    .orderBy(asc(challengeParticipants.createdAt));

export const prefs = (db: Db, u: string) =>
  db
    .select({ channels: notificationPreferences.channels })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, u));

/** Habit days for the CSV sheet: habit name, kind, unit, then the day. */
export const habitDaysSheet = (db: Db, u: string) =>
  db
    .select({
      name: habits.name,
      kind: habits.kind,
      unit: habits.unit,
      day: habitLogs.day,
      amount: habitLogs.amount,
      note: habitLogs.note,
    })
    .from(habitLogs)
    .innerJoin(habits, eq(habits.id, habitLogs.habitId))
    .where(eq(habitLogs.userId, u))
    .orderBy(asc(habits.name), asc(habitLogs.day));

// ---- import context -----------------------------------------------------------------------------------------

export const customNames = (db: Db, u: string) =>
  db
    .select({ id: customExercises.id, name: customExercises.name })
    .from(customExercises)
    .where(eq(customExercises.userId, u));
export const gearNames = (db: Db, u: string) =>
  db.select({ id: gear.id, name: gear.name }).from(gear).where(eq(gear.userId, u));
export const gymNames = (db: Db, u: string) =>
  db.select({ id: gyms.id, name: gyms.name }).from(gyms).where(eq(gyms.userId, u));
export const pauseSpans = (db: Db, u: string) =>
  db
    .select({ startsOn: streakPauses.startsOn, endsOn: streakPauses.endsOn })
    .from(streakPauses)
    .where(eq(streakPauses.userId, u));
export const weighKeys = (db: Db, u: string) =>
  db
    .select({ localDate: weighIns.localDate, moment: weighIns.moment, weightKg: weighIns.weightKg })
    .from(weighIns)
    .where(eq(weighIns.userId, u));
export const metricDays = (db: Db, u: string) =>
  db.select({ day: bodyMetrics.measuredOn }).from(bodyMetrics).where(eq(bodyMetrics.userId, u));
export const notedExercises = (db: Db, u: string) =>
  db.select({ exerciseId: exerciseNotes.exerciseId }).from(exerciseNotes).where(eq(exerciseNotes.userId, u));
export const habitNames = (db: Db, u: string) =>
  db.select({ id: habits.id, name: habits.name }).from(habits).where(eq(habits.userId, u));
export const habitLogDays = (db: Db, u: string) =>
  db
    .select({ habitId: habitLogs.habitId, day: habitLogs.day })
    .from(habitLogs)
    .where(eq(habitLogs.userId, u));
export const readyDays = (db: Db, u: string) =>
  db.select({ day: readiness.day }).from(readiness).where(eq(readiness.userId, u));
export const reflectionWeeks = (db: Db, u: string) =>
  db.select({ week: weekReflections.weekStart }).from(weekReflections).where(eq(weekReflections.userId, u));

/** Owners of any of `ids` (any user, soft-deleted included). One bound parameter whatever the count. */
// CROSS JOIN keeps json_each as the outer loop, so each id is one primary-key probe.
export const workoutOwnersSql = (ids: readonly string[]) =>
  sql`SELECT w.id AS id, w.user_id AS userId FROM json_each(${JSON.stringify(ids)}) AS j
    CROSS JOIN workouts AS w ON w.id = j.value`;
export const workoutOwners = (db: Db, ids: readonly string[]) =>
  db.all<{ id: string; userId: string }>(workoutOwnersSql(ids));

export const weighInIdsSql = (ids: readonly string[]) =>
  sql`SELECT w.id AS id FROM json_each(${JSON.stringify(ids)}) AS j CROSS JOIN weigh_ins AS w ON w.id = j.value`;
export const weighInIdsTaken = (db: Db, ids: readonly string[]) => db.all<{ id: string }>(weighInIdsSql(ids));

// ---- bulk inserts -------------------------------------------------------------------------------------------

/**
 * Insert columns per table, besides `created_at`, `updated_at` and `user_id`, which every bulk insert sets. Values
 * come from one JSON parameter through `json_each`, so a thousand rows are one statement (D1 binds at most 100
 * parameters, which would allow three workout rows per multi-row INSERT).
 */
export const BULK = {
  custom_exercises: [
    "id",
    "name",
    "name_fold",
    "pattern",
    "equipment",
    "primary",
    "secondary",
    "load_type",
    "rest_sec",
    "unilateral",
    "cue",
  ],
  gear: ["id", "name", "kind", "limit_m", "initial_m", "note", "retired_at"],
  gyms: ["id", "name", "equipment", "plates_kg", "bar_kg"],
  workouts: [
    "id",
    "discipline",
    "title",
    "notes",
    "started_at",
    "local_date",
    "local_hour",
    "duration_sec",
    "distance_m",
    "elevation_m",
    "effort",
    "feel",
    "soreness",
    "pump",
    "avg_hr",
    "max_hr",
    "hr_zones",
    "tags",
    "splits",
    "gear_id",
    "gym_id",
  ],
  workout_sets: [
    "id",
    "workout_id",
    "exercise_id",
    "position",
    "set_index",
    "superset",
    "kind",
    "weight_kg",
    "reps",
    "rpe",
    "duration_sec",
    "distance_m",
    "completed",
  ],
  streak_pauses: ["id", "starts_on", "ends_on", "reason", "note"],
  body_metrics: [
    "id",
    "measured_on",
    "body_fat_pct",
    "resting_hr",
    "sleep_hours",
    "waist_cm",
    "neck_cm",
    "shoulders_cm",
    "chest_cm",
    "arm_cm",
    "forearm_cm",
    "hips_cm",
    "thigh_cm",
    "calf_cm",
    "note",
  ],
  weigh_ins: ["id", "weighed_at", "local_date", "moment", "weight_kg", "note"],
  exercise_notes: ["id", "exercise_id", "note"],
  weight_goals: ["id", "target_kg", "milestone_kg", "start_kg", "set_on"],
  habits: [
    "id",
    "name",
    "name_fold",
    "emoji",
    "category",
    "kind",
    "unit",
    "daily_goal",
    "weekly_target",
    "time_of_day",
    "cue",
    "why",
    "total_goal",
    "remind_hour",
    "days_mask",
    "paused_from",
    "paused_until",
    "started_on",
    "archived_at",
  ],
  habit_logs: ["id", "habit_id", "day", "amount", "note"],
  readiness: ["id", "day", "sleep", "energy", "soreness"],
  week_reflections: ["id", "week_start", "went_well", "change"],
} as const;
export type BulkTable = keyof typeof BULK;

/** JSON text per statement; D1 caps a value at 2 MB, so stay well below. */
const CHUNK_JSON = 512 * 1024;

const encode = (v: unknown) =>
  typeof v === "boolean"
    ? v
      ? 1
      : 0
    : Array.isArray(v) || (typeof v === "object" && v !== null)
      ? JSON.stringify(v)
      : v;

/** Splits rows into chunks whose JSON stays under the cap. */
export function chunkRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[][] {
  const out: Record<string, unknown>[][] = [];
  let part: Record<string, unknown>[] = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (part.length > 0 && size + n > CHUNK_JSON) {
      out.push(part);
      part = [];
      size = 0;
    }
    part.push(r);
    size += n;
  }
  if (part.length > 0) out.push(part);
  return out;
}

/**
 * `INSERT INTO t (...) SELECT ... FROM json_each(?)`. `seq` (workouts only) is `base - n + k` after a `sync_seq` bump
 * of n in the statement before, so every row gets its own strictly increasing value.
 */
export function bulkInsertSql(
  table: BulkTable,
  userId: string,
  now: number,
  rows: readonly Record<string, unknown>[],
  extra: { workouts?: boolean } = {},
): SQL {
  const cols = BULK[table];
  const values = rows.map((r, k) => {
    const o: Record<string, unknown> = { k: k + 1 };
    for (const c of cols) o[c] = encode(r[c] ?? null);
    return o;
  });
  const names = sql.raw(cols.map((c) => `"${c}"`).join(", "));
  const picks = sql.raw(cols.map((c) => `j.value ->> '${c}'`).join(", "));
  if (extra.workouts) {
    const n = rows.length;
    return sql`INSERT INTO workouts (created_at, updated_at, user_id, source, client_updated_at, seq, ${names})
      SELECT ${now}, ${now}, ${userId}, 'import', ${now},
        (SELECT value FROM sync_seq WHERE id = 1) - ${n} + (j.value ->> 'k'), ${picks}
      FROM json_each(${JSON.stringify(values)}) AS j`;
  }
  return sql`INSERT INTO ${sql.raw(table)} (created_at, updated_at, user_id, ${names})
    SELECT ${now}, ${now}, ${userId}, ${picks} FROM json_each(${JSON.stringify(values)}) AS j`;
}

/** Reserves `n` values of the global sync cursor for the next workout insert. */
export const bumpSeqSql = (n: number) =>
  sql`INSERT INTO sync_seq (id, value) VALUES (1, ${n}) ON CONFLICT (id) DO UPDATE SET value = value + ${n}`;

// ---- deletion, security events, calendar --------------------------------------------------------------------

export const scheduleDeletion = (db: Db, u: string, when: number, now: number) =>
  db.update(profiles).set({ deletionScheduledAt: when, updatedAt: now }).where(eq(profiles.userId, u));

/** Clears a scheduled deletion; returns the row only when one was scheduled. */
export const cancelDeletion = (db: Db, u: string, now: number) =>
  db
    .update(profiles)
    .set({ deletionScheduledAt: null, updatedAt: now })
    .where(and(eq(profiles.userId, u), isNotNull(profiles.deletionScheduledAt)))
    .returning({ id: profiles.id });

/** A security-event insert that lands only when `cond` holds (one-trip conditional writes). */
export const eventIfSql = (
  id: string,
  u: string,
  kind: SQL,
  cond: SQL,
  meta: { ip: string | null; userAgent: string | null },
  now: number,
  extra: Record<string, unknown> | null = null,
) =>
  sql`INSERT INTO security_events (id, created_at, updated_at, user_id, kind, ip_address, user_agent, meta)
    SELECT ${id}, ${now}, ${now}, ${u}, ${kind}, ${meta.ip}, ${meta.userAgent},
      ${extra === null ? null : JSON.stringify(extra)} WHERE ${cond}`;

export const scheduled = (u: string) =>
  sql`EXISTS (SELECT 1 FROM profiles WHERE user_id = ${u} AND deletion_scheduled_at IS NOT NULL)`;
export const feedSet = (u: string) =>
  sql`EXISTS (SELECT 1 FROM profiles WHERE user_id = ${u} AND calendar_token_hash IS NOT NULL)`;

export const recentEvents = (db: Db, u: string) =>
  db
    .select()
    .from(securityEvents)
    .where(eq(securityEvents.userId, u))
    .orderBy(desc(securityEvents.createdAt), desc(securityEvents.id))
    .limit(100);

export const calendarState = (db: Db, u: string) =>
  db
    .select({ hash: profiles.calendarTokenHash, createdAt: profiles.calendarTokenCreatedAt })
    .from(profiles)
    .where(eq(profiles.userId, u));

export const setFeed = (db: Db, u: string, hash: string | null, now: number, allowed?: SQL) =>
  db
    .update(profiles)
    .set({ calendarTokenHash: hash, calendarTokenCreatedAt: hash === null ? null : now, updatedAt: now })
    .where(allowed === undefined ? eq(profiles.userId, u) : and(eq(profiles.userId, u), allowed));

/** The feed's owner, if the account may still serve it. */
export const feedOwner = (db: Db, hash: string) =>
  db
    .select({
      userId: profiles.userId,
      timezone: profiles.timezone,
      trainingDays: profiles.trainingDays,
      deletionScheduledAt: profiles.deletionScheduledAt,
      isActive: users.isActive,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.calendarTokenHash, hash));

const ownerOf = (hash: string) => sql`(SELECT user_id FROM profiles WHERE calendar_token_hash = ${hash})`;

/** Workouts in the feed window. `sinceDate` bounds the (user, local_date) index range; `since` is exact. */
export const feedWorkouts = (db: Db, hash: string, since: number, sinceDate: string) =>
  db
    .select({
      id: workouts.id,
      discipline: workouts.discipline,
      title: workouts.title,
      startedAt: workouts.startedAt,
      durationSec: workouts.durationSec,
      distanceM: workouts.distanceM,
    })
    .from(workouts)
    .where(
      and(
        sql`${workouts.userId} = ${ownerOf(hash)}`,
        gte(workouts.localDate, sinceDate),
        gte(workouts.startedAt, since),
        isNull(workouts.deletedAt),
      ),
    )
    .orderBy(asc(workouts.startedAt));

export const feedPauses = (db: Db, hash: string) =>
  db
    .select({ id: streakPauses.id, startsOn: streakPauses.startsOn, endsOn: streakPauses.endsOn })
    .from(streakPauses)
    .where(sql`${streakPauses.userId} = ${ownerOf(hash)}`)
    .orderBy(asc(streakPauses.startsOn));

/** ICS export: the user's own live workouts and pauses. */
export const icsWorkouts = (db: Db, u: string) =>
  db
    .select({
      id: workouts.id,
      discipline: workouts.discipline,
      title: workouts.title,
      startedAt: workouts.startedAt,
      durationSec: workouts.durationSec,
      distanceM: workouts.distanceM,
    })
    .from(workouts)
    .where(and(eq(workouts.userId, u), isNull(workouts.deletedAt)))
    .orderBy(asc(workouts.startedAt));

// ---- queued imports -----------------------------------------------------------------------------------------

export const importJob = (db: Db, id: string) => db.select().from(importJobs).where(eq(importJobs.id, id));

export const updateImportJob = (
  db: Db,
  id: string,
  values: Partial<typeof importJobs.$inferInsert>,
  now: number,
) =>
  db
    .update(importJobs)
    .set({ ...values, updatedAt: now })
    .where(and(eq(importJobs.id, id), or(eq(importJobs.status, "queued"), eq(importJobs.status, "running"))));

const U = "u";
const JSON_IDS = "scans only the json_each list of ids; each id probes the primary key";

export const explain: ExplainCase[] = [
  { name: "account.account", build: (db) => account(db, U) },
  { name: "account.profileRow", build: (db) => profileRow(db, U) },
  { name: "account.chains", build: (db) => chains(db, U) },
  { name: "account.repairs", build: (db) => repairs(db, U) },
  { name: "account.pauses", build: (db) => pauses(db, U) },
  { name: "account.customs", build: (db) => customs(db, U) },
  { name: "account.liveWorkouts", build: (db) => liveWorkouts(db, U) },
  { name: "account.liveSets", build: (db) => liveSets(db, U) },
  { name: "account.monthly", build: (db) => monthly(db, U) },
  { name: "account.rest", build: (db) => rest(db, U) },
  { name: "account.gearRows", build: (db) => gearRows(db, U) },
  { name: "account.gymRows", build: (db) => gymRows(db, U) },
  { name: "account.notes", build: (db) => notes(db, U) },
  { name: "account.weightGoal", build: (db) => weightGoal(db, U) },
  { name: "account.habitRows", build: (db) => habitRows(db, U) },
  { name: "account.habitLogRows", build: (db) => habitLogRows(db, U) },
  { name: "account.blocksRows", build: (db) => blocksRows(db, U) },
  { name: "account.readinessRows", build: (db) => readinessRows(db, U) },
  { name: "account.reflections", build: (db) => reflections(db, U) },
  { name: "account.wagers", build: (db) => wagers(db, U) },
  { name: "account.plans", build: (db) => plans(db, U) },
  { name: "account.routineRows", build: (db) => routineRows(db, U) },
  { name: "account.metrics", build: (db) => metrics(db, U) },
  { name: "account.photos", build: (db) => photos(db, U) },
  { name: "account.weighInRows", build: (db) => weighInRows(db, U) },
  { name: "account.meals", build: (db) => meals(db, U) },
  { name: "account.foodRows", build: (db) => foodRows(db, U) },
  { name: "account.recipeRows", build: (db) => recipeRows(db, U) },
  { name: "account.journal", build: (db) => journal(db, U) },
  { name: "account.habitRoutineRows", build: (db) => habitRoutineRows(db, U) },
  { name: "account.nutritionTarget", build: (db) => nutritionTarget(db, U) },
  { name: "account.achievements", build: (db) => achievements(db, U) },
  { name: "account.records", build: (db) => records(db, U) },
  { name: "account.following", build: (db) => following(db, U) },
  { name: "account.followers", build: (db) => followers(db, U) },
  { name: "account.blockedCount", build: (db) => blockedCount(db, U) },
  { name: "account.buddiesAsA", build: (db) => buddiesAsA(db, U) },
  { name: "account.buddiesAsB", build: (db) => buddiesAsB(db, U) },
  { name: "account.authoredComments", build: (db) => authoredComments(db, U) },
  { name: "account.memberships", build: (db) => memberships(db, U) },
  { name: "account.challengeRows", build: (db) => challengeRows(db, U) },
  { name: "account.prefs", build: (db) => prefs(db, U) },
  { name: "account.habitDaysSheet", build: (db) => habitDaysSheet(db, U) },
  { name: "account.customNames", build: (db) => customNames(db, U) },
  { name: "account.gearNames", build: (db) => gearNames(db, U) },
  { name: "account.gymNames", build: (db) => gymNames(db, U) },
  { name: "account.pauseSpans", build: (db) => pauseSpans(db, U) },
  { name: "account.weighKeys", build: (db) => weighKeys(db, U) },
  { name: "account.metricDays", build: (db) => metricDays(db, U) },
  { name: "account.notedExercises", build: (db) => notedExercises(db, U) },
  { name: "account.habitNames", build: (db) => habitNames(db, U) },
  { name: "account.habitLogDays", build: (db) => habitLogDays(db, U) },
  { name: "account.readyDays", build: (db) => readyDays(db, U) },
  { name: "account.reflectionWeeks", build: (db) => reflectionWeeks(db, U) },
  { name: "account.workoutOwners", build: () => workoutOwnersSql(["a", "b"]), scanOk: JSON_IDS },
  { name: "account.weighInIdsTaken", build: () => weighInIdsSql(["a"]), scanOk: JSON_IDS },
  ...(Object.keys(BULK) as BulkTable[]).map((t) => ({
    name: `account.bulk.${t}`,
    build: () => bulkInsertSql(t, U, 0, [{}], { workouts: t === "workouts" }),
    scanOk: "INSERT ... SELECT from json_each over the caller's own rows",
  })),
  { name: "account.bumpSeq", build: () => bumpSeqSql(1) },
  { name: "account.scheduleDeletion", build: (db) => scheduleDeletion(db, U, 0, 0) },
  { name: "account.cancelDeletion", build: (db) => cancelDeletion(db, U, 0) },
  {
    name: "account.eventIf",
    build: () => eventIfSql("id", U, sql`'k'`, scheduled(U), { ip: null, userAgent: null }, 0),
  },
  {
    name: "account.eventIfFeed",
    build: () => eventIfSql("id", U, sql`'k'`, feedSet(U), { ip: null, userAgent: null }, 0),
  },
  { name: "account.recentEvents", build: (db) => recentEvents(db, U) },
  { name: "account.calendarState", build: (db) => calendarState(db, U) },
  { name: "account.setFeed", build: (db) => setFeed(db, U, "h", 0) },
  { name: "account.feedOwner", build: (db) => feedOwner(db, "h") },
  { name: "account.feedWorkouts", build: (db) => feedWorkouts(db, "h", 0, "2026-01-01") },
  { name: "account.feedPauses", build: (db) => feedPauses(db, "h") },
  { name: "account.icsWorkouts", build: (db) => icsWorkouts(db, U) },
  { name: "account.importJob", build: (db) => importJob(db, "j") },
  { name: "account.updateImportJob", build: (db) => updateImportJob(db, "j", { offset: 1 }, 0) },
];
