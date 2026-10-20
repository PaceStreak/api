/**
 * Query builders for the game module (spec/game.md §3). Every function returns an un-awaited statement.
 *
 * Aggregates (`stat_days`, `stat_exercises`, `record_days`) are rebuilt from source rows with
 * `DELETE` + `INSERT ... SELECT ... GROUP BY`, scoped to the touched dates / exercises / keys by a single JSON
 * parameter (`IN (SELECT value FROM json_each(?))`), so a scope of any size binds one parameter.
 */
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { ENDURANCE } from "../../catalog/exercises.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  customExercises,
  groupMembers,
  personalRecords,
  profiles,
  recordDays,
  restDays,
  statDays,
  statExercises,
  streakChains,
  streakPauses,
  streakRepairs,
  streakWagers,
  userAchievements,
  userStats,
  weighIns,
  workouts,
} from "../../db/schema/index.ts";
import { RUN_BANDS } from "./engine/records.ts";

/** `null` = every row of the user. */
export type Scope = readonly string[] | null;

const inScope = (col: ReturnType<typeof sql.raw>, scope: Scope) =>
  scope === null ? sql`` : sql` AND ${col} IN (SELECT value FROM json_each(${JSON.stringify(scope)}))`;

const W = sql.raw;

// ---- aggregate refresh ----------------------------------------------------------------------------------------

/** A set that counts: completed and not a warm-up. */
const COUNTED_SET = sql`s.completed = 1 AND s.kind <> 'warmup'`;
const LOCAL_HOUR = sql`coalesce(w.local_hour, CAST(strftime('%H', w.started_at / 1000, 'unixepoch') AS INTEGER))`;

export const deleteStatDaysSql = (userId: string, dates: Scope) =>
  sql`DELETE FROM stat_days WHERE user_id = ${userId}${inScope(W("local_date"), dates)}`;

export const insertStatDaysSql = (userId: string, dates: Scope) =>
  sql`INSERT INTO stat_days (user_id, local_date, sessions, detailed, duration_sec, distance_m, heat, short,
      early, late, rpe_sets, disciplines, exercises)
    SELECT w.user_id, w.local_date, count(*),
      sum(CASE WHEN coalesce(w.duration_sec, 0) > 0 OR coalesce(w.distance_m, 0) > 0
                 OR EXISTS (SELECT 1 FROM workout_sets s WHERE s.workout_id = w.id AND ${COUNTED_SET})
               THEN 1 ELSE 0 END),
      sum(coalesce(w.duration_sec, 0)),
      sum(coalesce(w.distance_m, 0)),
      sum((CASE WHEN coalesce(w.duration_sec, 0) > 0 THEN w.duration_sec ELSE 1800 END) / 60.0
          * (1 + ((CASE WHEN coalesce(w.effort, 0) <> 0 THEN w.effort ELSE 5 END) - 5) / 10.0)),
      sum(CASE WHEN w.duration_sec > 0 AND w.duration_sec <= 1200 THEN 1 ELSE 0 END),
      sum(CASE WHEN ${LOCAL_HOUR} < 7 THEN 1 ELSE 0 END),
      sum(CASE WHEN ${LOCAL_HOUR} >= 21 THEN 1 ELSE 0 END),
      (SELECT count(*) FROM workouts w2 JOIN workout_sets s ON s.workout_id = w2.id
        WHERE w2.user_id = w.user_id AND w2.local_date = w.local_date AND w2.deleted_at IS NULL
          AND ${COUNTED_SET} AND s.rpe IS NOT NULL),
      (SELECT json_group_object(discipline, n) FROM (
        SELECT w3.discipline, count(*) AS n FROM workouts w3
         WHERE w3.user_id = w.user_id AND w3.local_date = w.local_date AND w3.deleted_at IS NULL
         GROUP BY w3.discipline ORDER BY w3.discipline)),
      (SELECT json_group_array(exercise_id) FROM (
        SELECT DISTINCT s.exercise_id FROM workouts w2 JOIN workout_sets s ON s.workout_id = w2.id
         WHERE w2.user_id = w.user_id AND w2.local_date = w.local_date AND w2.deleted_at IS NULL AND ${COUNTED_SET}
         ORDER BY s.exercise_id))
    FROM workouts w
    WHERE w.user_id = ${userId} AND w.deleted_at IS NULL${inScope(W("w.local_date"), dates)}
    GROUP BY w.local_date`;

export const deleteStatExercisesSql = (userId: string, exercises: Scope) =>
  sql`DELETE FROM stat_exercises WHERE user_id = ${userId}${inScope(W("exercise_id"), exercises)}`;

export const insertStatExercisesSql = (userId: string, exercises: Scope) =>
  sql`INSERT INTO stat_exercises (user_id, exercise_id, first_seen, sets, rpe_sets, tonnage)
    SELECT s.user_id, s.exercise_id, min(w.local_date), count(*),
      sum(CASE WHEN s.rpe BETWEEN 5 AND 10 THEN 1 ELSE 0 END),
      sum(CASE WHEN s.weight_kg > 0 AND s.reps > 0 THEN s.weight_kg * s.reps ELSE 0 END)
    FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
    WHERE s.user_id = ${userId} AND w.deleted_at IS NULL AND ${COUNTED_SET}${inScope(W("s.exercise_id"), exercises)}
    GROUP BY s.exercise_id`;

export const deleteRecordDaysSql = (userId: string, dates: Scope) =>
  sql`DELETE FROM record_days WHERE user_id = ${userId}${inScope(W("local_date"), dates)}`;

const ENDURANCE_LIST = sql.raw([...ENDURANCE].map((d) => `'${d.replace(/'/g, "''")}'`).join(", "));

/** The set-based record families: key prefix and the value a set contributes (NULL when it does not count). */
const SET_FAMILIES = ["e1rm:", "reps:", "repsbw:", "hold:"] as const;

/**
 * One row per raw key and day, in three statements: every set-based family at once (a `json_each` of the family
 * prefixes joined to the sets), endurance distance, and every run pace band at once. D1 caps compound SELECTs, so
 * no UNION ALL, and the Workers Free plan counts each statement against 50 queries per invocation
 * (src/lib/plan.ts), so not one statement per family either. SQLite fills the bare `workout_id` / `rewardable`
 * columns from the row holding the single `max()` / `min()` of each group, which is exactly "the workout that set
 * the day's best"; rows outside a family's filter carry NULL, which max/min skip, and `HAVING` drops a group that
 * has no row at all.
 */
export function insertRecordDaysSql(userId: string, dates: Scope) {
  const into = sql`INSERT INTO record_days (user_id, key, local_date, value, workout_id, rewardable)`;
  const pace = sql`w.duration_sec / (w.distance_m / 1000.0)`;
  const fromRuns = sql`FROM workouts w WHERE w.user_id = ${userId} AND w.deleted_at IS NULL`;
  const bands = JSON.stringify(RUN_BANDS.map(([metres, label]) => [metres, `pace_${label}:run`]));
  return [
    sql`${into} SELECT s.user_id, f.value || s.exercise_id, w.local_date,
        max(CASE f.value
          WHEN 'e1rm:' THEN CASE WHEN s.weight_kg > 0 AND s.reps > 0 THEN
            CASE WHEN s.reps = 1 THEN s.weight_kg WHEN s.reps <= 12 THEN s.weight_kg * (1 + s.reps / 30.0) ELSE 0 END END
          WHEN 'reps:' THEN CASE WHEN s.reps > 0 THEN s.reps END
          WHEN 'repsbw:' THEN CASE WHEN s.reps > 0 AND coalesce(s.weight_kg, 0) <= 0 THEN s.reps END
          WHEN 'hold:' THEN CASE WHEN s.duration_sec > 0 THEN s.duration_sec END
        END) AS best, w.id, w.source <> 'import'
      FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
        JOIN json_each(${JSON.stringify(SET_FAMILIES)}) f
      WHERE s.user_id = ${userId} AND w.deleted_at IS NULL AND ${COUNTED_SET}${inScope(W("w.local_date"), dates)}
      GROUP BY f.value, s.exercise_id, w.local_date
      HAVING best IS NOT NULL`,
    sql`${into} SELECT w.user_id, 'distance:' || w.discipline, w.local_date, max(w.distance_m), w.id,
        w.source <> 'import'
      ${fromRuns} AND w.discipline IN (${ENDURANCE_LIST}) AND w.distance_m > 0${inScope(W("w.local_date"), dates)}
      GROUP BY w.discipline, w.local_date`,
    sql`${into} SELECT w.user_id, b.value ->> 1, w.local_date,
        min(CASE WHEN w.distance_m >= b.value ->> 0 AND ${pace} >= 150 THEN ${pace} END) AS best, w.id,
        w.source <> 'import'
      FROM workouts w JOIN json_each(${bands}) b
      WHERE w.user_id = ${userId} AND w.deleted_at IS NULL AND w.discipline = 'run' AND w.duration_sec > 0
        AND w.distance_m > 0${inScope(W("w.local_date"), dates)}
      GROUP BY b.key, w.local_date
      HAVING best IS NOT NULL`,
  ];
}

// ---- snapshot reads -------------------------------------------------------------------------------------------

export const profile = (db: Db, userId: string) =>
  db.select().from(profiles).where(eq(profiles.userId, userId));

export const chains = (db: Db, userId: string) =>
  db
    .select({
      id: streakChains.id,
      name: streakChains.name,
      disciplines: streakChains.disciplines,
      targetHistory: streakChains.targetHistory,
      requirementsHistory: streakChains.requirementsHistory,
    })
    .from(streakChains)
    .where(and(eq(streakChains.userId, userId), eq(streakChains.archived, false)))
    .orderBy(asc(streakChains.position), asc(streakChains.createdAt));

export const repairs = (db: Db, userId: string) =>
  db
    .select({
      chainId: streakRepairs.chainId,
      weekStart: streakRepairs.weekStart,
      month: streakRepairs.month,
    })
    .from(streakRepairs)
    .where(eq(streakRepairs.userId, userId));

export const pauses = (db: Db, userId: string) =>
  db
    .select({
      id: streakPauses.id,
      startsOn: streakPauses.startsOn,
      endsOn: streakPauses.endsOn,
      reason: streakPauses.reason,
      note: streakPauses.note,
    })
    .from(streakPauses)
    .where(eq(streakPauses.userId, userId))
    .orderBy(asc(streakPauses.startsOn));

export const wagers = (db: Db, userId: string) =>
  db
    .select({ weekStart: streakWagers.weekStart, days: streakWagers.days })
    .from(streakWagers)
    .where(eq(streakWagers.userId, userId))
    .orderBy(asc(streakWagers.weekStart));

export const days = (db: Db, userId: string) =>
  db
    .select({
      localDate: statDays.localDate,
      sessions: statDays.sessions,
      detailed: statDays.detailed,
      durationSec: statDays.durationSec,
      distanceM: statDays.distanceM,
      heat: statDays.heat,
      short: statDays.short,
      early: statDays.early,
      late: statDays.late,
      rpeSets: statDays.rpeSets,
      disciplines: statDays.disciplines,
      exercises: statDays.exercises,
    })
    .from(statDays)
    .where(eq(statDays.userId, userId))
    .orderBy(asc(statDays.localDate));

export const exercises = (db: Db, userId: string) =>
  db
    .select({
      exerciseId: statExercises.exerciseId,
      firstSeen: statExercises.firstSeen,
      sets: statExercises.sets,
      rpeSets: statExercises.rpeSets,
      tonnage: statExercises.tonnage,
    })
    .from(statExercises)
    .where(eq(statExercises.userId, userId));

export const customs = (db: Db, userId: string) =>
  db
    .select({
      id: customExercises.id,
      name: customExercises.name,
      pattern: customExercises.pattern,
      loadType: customExercises.loadType,
      primary: customExercises.primary,
      secondary: customExercises.secondary,
    })
    .from(customExercises)
    .where(eq(customExercises.userId, userId));

export const records = (db: Db, userId: string) =>
  db
    .select({
      key: personalRecords.key,
      value: personalRecords.value,
      previous: personalRecords.previous,
      gainPct: personalRecords.gainPct,
      achievedOn: personalRecords.achievedOn,
      workoutId: personalRecords.workoutId,
      flagged: personalRecords.flagged,
      rewarded: personalRecords.rewarded,
      isCurrent: personalRecords.isCurrent,
    })
    .from(personalRecords)
    .where(eq(personalRecords.userId, userId));

export const achievements = (db: Db, userId: string) =>
  db
    .select({
      achievementId: userAchievements.achievementId,
      tier: userAchievements.tier,
      unlockedOn: userAchievements.unlockedOn,
    })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

/**
 * The small counts the badges look at, plus the first weigh-in day (quests), in one row. A select from a one-row
 * subquery, so it can be fused with the other snapshot reads.
 */
export const counts = (db: Db, userId: string) =>
  db
    .select({
      kudos: sql<number>`(SELECT count(*) FROM kudos WHERE user_id = ${userId})`,
      groups: sql<number>`(SELECT count(*) FROM group_members WHERE user_id = ${userId})`,
      finished: sql<number>`(SELECT count(*) FROM challenge_participants WHERE user_id = ${userId} AND completed = 1)`,
      body_days: sql<number>`(SELECT count(*) FROM (SELECT measured_on FROM body_metrics WHERE user_id = ${userId}
        UNION SELECT local_date FROM weigh_ins WHERE user_id = ${userId}))`,
      first_weigh: sql<string | null>`(SELECT min(local_date) FROM weigh_ins WHERE user_id = ${userId})`,
    })
    .from(sql`(SELECT 1)`);

export const restDayDates = (db: Db, userId: string) =>
  db.select({ day: restDays.day }).from(restDays).where(eq(restDays.userId, userId));

export const wakingDates = (db: Db, userId: string) =>
  db
    .selectDistinct({ day: weighIns.localDate })
    .from(weighIns)
    .where(and(eq(weighIns.userId, userId), eq(weighIns.moment, "waking")));

export const stats = (db: Db, userId: string) =>
  db
    .select({
      rev: userStats.rev,
      totalXp: userStats.totalXp,
      level: userStats.level,
      currentStreak: userStats.currentStreak,
      weeklyDays4w: userStats.weeklyDays4w,
    })
    .from(userStats)
    .where(eq(userStats.userId, userId));

// ---- recompute reads ------------------------------------------------------------------------------------------

export const recordDayRows = (db: Db, userId: string, keys: Scope) =>
  db
    .select({
      key: recordDays.key,
      localDate: recordDays.localDate,
      value: recordDays.value,
      workoutId: recordDays.workoutId,
      rewardable: recordDays.rewardable,
    })
    .from(recordDays)
    .where(
      and(
        eq(recordDays.userId, userId),
        keys === null
          ? undefined
          : inArray(recordDays.key, sql`(SELECT value FROM json_each(${JSON.stringify(keys)}))`),
      ),
    );

/** App-logged start hours since `since` (imports carry a watch's clock, not the person's habit). */
export const recentStartHours = (db: Db, userId: string, sinceDate: string, sinceMs: number) =>
  db
    .select({
      hour: sql<number>`coalesce(${workouts.localHour}, CAST(strftime('%H', ${workouts.startedAt} / 1000, 'unixepoch') AS INTEGER))`,
    })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, userId),
        gte(workouts.localDate, sinceDate),
        gte(workouts.startedAt, sinceMs),
        eq(workouts.source, "app"),
        sql`${workouts.deletedAt} IS NULL`,
      ),
    );

// ---- writes ---------------------------------------------------------------------------------------------------

/** Creates the profile on first use (Python `get_profile`); a concurrent creator wins harmlessly. */
export const ensureProfile = (db: Db, userId: string, id: string, hue: number, now: number) =>
  db
    .insert(profiles)
    .values({ id, userId, avatarHue: hue, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: profiles.userId });

/** The chain everyone starts with ("Everything", three days a week); `ensureChain` writes it on first use. */
export const DEFAULT_CHAIN = {
  name: "Everything",
  disciplines: [] as string[],
  targetHistory: [{ from: "2000-01-03", target: 3 }],
  requirementsHistory: [] as never[],
};

/** The default all-disciplines chain, only while the user has no active chain (Python `get_chains`). */
export const ensureChain = (db: Db, userId: string, id: string, now: number) =>
  db.run(sql`INSERT INTO streak_chains (id, created_at, updated_at, user_id, name, disciplines, target_history,
      requirements_history, position, archived)
    SELECT ${id}, ${now}, ${now}, ${userId}, ${DEFAULT_CHAIN.name}, '[]', ${JSON.stringify(DEFAULT_CHAIN.targetHistory)},
      '[]', 0, 0
    WHERE NOT EXISTS (SELECT 1 FROM streak_chains WHERE user_id = ${userId} AND archived = 0)`);

export interface StatsValues {
  computedAt: number;
  computedFor: string;
  totalXp: number;
  level: number;
  seasonId: string;
  seasonXp: number;
  currentStreak: number;
  longestStreak: number;
  consistency: number;
  thisWeekDays: number;
  thisWeekTarget: number;
  weeklyDays4w: number;
  lifeStreak: number;
  sessions: number;
  activeDays: number;
  seasonPrs: number;
  totalPrs: number;
  lastActive: string | null;
  recentWeeks: (typeof userStats.$inferInsert)["recentWeeks"];
}

/** The read-model upsert; `rev` moves on by one. Guarded by `abortUnless(revIs(...))` earlier in the batch. */
export const upsertStats = (db: Db, userId: string, id: string, v: StatsValues, now: number) =>
  db
    .insert(userStats)
    .values({ id, userId, createdAt: now, updatedAt: now, rev: 1, ...v })
    .onConflictDoUpdate({
      target: userStats.userId,
      set: { ...v, updatedAt: now, rev: sql`${userStats.rev} + 1` },
    });

/** The optimistic-concurrency predicate: nobody recomputed since we read `rev` (null = no row yet). */
export const revIs = (userId: string, rev: number | null) =>
  rev === null
    ? sql`NOT EXISTS (SELECT 1 FROM user_stats WHERE user_id = ${userId})`
    : sql`EXISTS (SELECT 1 FROM user_stats WHERE user_id = ${userId} AND rev = ${rev})`;

export const deleteRecordsSql = (userId: string, keys: Scope) =>
  sql`DELETE FROM personal_records WHERE user_id = ${userId}${inScope(W("key"), keys)}`;

export interface RecordRow {
  id: string;
  key: string;
  value: number;
  previous: number | null;
  gain_pct: number | null;
  achieved_on: string;
  workout_id: string | null;
  flagged: boolean;
  rewarded: boolean;
  is_current: boolean;
}

/** Any number of record rows in one statement and one bound parameter. */
export const insertRecords = (db: Db, userId: string, rows: readonly RecordRow[], now: number) =>
  db.run(sql`INSERT INTO personal_records (id, created_at, updated_at, user_id, key, value, previous, gain_pct,
      achieved_on, workout_id, flagged, rewarded, is_current)
    SELECT j.value ->> 'id', ${now}, ${now}, ${userId}, j.value ->> 'key', j.value ->> 'value', j.value ->> 'previous',
      j.value ->> 'gain_pct', j.value ->> 'achieved_on', j.value ->> 'workout_id', j.value ->> 'flagged',
      j.value ->> 'rewarded', j.value ->> 'is_current'
    FROM json_each(${JSON.stringify(rows.map((r) => ({ ...r, flagged: r.flagged ? 1 : 0, rewarded: r.rewarded ? 1 : 0, is_current: r.is_current ? 1 : 0 })))}) AS j`);

export const setLearnedHour = (db: Db, userId: string, hour: number | null, now: number) =>
  db.update(profiles).set({ learnedReminderHour: hour, updatedAt: now }).where(eq(profiles.userId, userId));

export interface AchievementRow {
  id: string;
  achievementId: string;
  tier: string | null;
  unlockedOn: string;
  value: number;
}

/** New badges in ONE statement and one bound parameter; a badge already held is skipped (both unique keys). */
export const insertAchievementsSql = (userId: string, rows: readonly AchievementRow[], now: number) =>
  sql`INSERT INTO user_achievements (id, created_at, updated_at, user_id, achievement_id, tier, unlocked_on,
      evidence)
    SELECT j.value ->> 'id', ${now}, ${now}, ${userId}, j.value ->> 'achievementId', j.value ->> 'tier',
      j.value ->> 'unlockedOn', json_object('value', j.value -> 'value')
    FROM json_each(${JSON.stringify(rows)}) AS j
    WHERE true
    ON CONFLICT DO NOTHING`;

export const insertAchievements = (db: Db, userId: string, rows: readonly AchievementRow[], now: number) =>
  db.run(insertAchievementsSql(userId, rows, now));

export interface EventRow {
  id: string;
  kind: string;
  refKey: string;
  data: Record<string, unknown>;
  workoutId: string | null;
}

/** `emitEvent` for many events of one user and day in ONE statement: each upserts on (user, kind, ref_key). */
export const emitEventsSql = (userId: string, day: string, rows: readonly EventRow[], now: number) =>
  sql`INSERT INTO activity_events (id, created_at, updated_at, user_id, kind, ref_key, data, occurred_on,
      workout_id)
    SELECT j.value ->> 'id', ${now}, ${now}, ${userId}, j.value ->> 'kind', substr(j.value ->> 'refKey', 1, 120),
      j.value -> 'data', ${day}, j.value ->> 'workoutId'
    FROM json_each(${JSON.stringify(rows)}) AS j
    WHERE true
    ON CONFLICT (user_id, kind, ref_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`;

export const emitEvents = (db: Db, userId: string, day: string, rows: readonly EventRow[], now: number) =>
  db.run(emitEventsSql(userId, day, rows, now));

export const insertWager = (
  db: Db,
  id: string,
  userId: string,
  weekStart: string,
  days: number,
  now: number,
) => db.insert(streakWagers).values({ id, userId, weekStart, days, createdAt: now, updatedAt: now });

export const deleteWager = (db: Db, userId: string, weekStart: string) =>
  db.delete(streakWagers).where(and(eq(streakWagers.userId, userId), eq(streakWagers.weekStart, weekStart)));

// ---- route reads ----------------------------------------------------------------------------------------------

/** Rarity: onboarded people, and holders per (achievement, tier) across everyone. */
export const onboardedCount = (db: Db) =>
  db.select({ n: sql<number>`count(*)` }).from(profiles).where(isNotNull(profiles.onboardedAt));

export const achievementCounts = (db: Db) =>
  db
    .select({
      achievementId: userAchievements.achievementId,
      tier: userAchievements.tier,
      n: sql<number>`count(*)`,
    })
    .from(userAchievements)
    .groupBy(userAchievements.achievementId, userAchievements.tier);

/** The e1rm candidates of a month, and the best before it per exercise of that month (monthly recap). */
export const monthLifts = (db: Db, userId: string, first: string, last: string) =>
  db
    .select({ key: recordDays.key, localDate: recordDays.localDate, value: recordDays.value })
    .from(recordDays)
    .where(
      and(
        eq(recordDays.userId, userId),
        sql`${recordDays.localDate} BETWEEN ${first} AND ${last}`,
        sql`${recordDays.key} LIKE 'e1rm:%'`,
      ),
    );

export const liftsBeforeSql = (userId: string, first: string, last: string) =>
  sql`SELECT r.key AS key, max(r.value) AS best FROM record_days r
    WHERE r.user_id = ${userId} AND r.local_date < ${first}
      AND r.key IN (SELECT DISTINCT m.key FROM record_days m
                     WHERE m.user_id = ${userId} AND m.local_date BETWEEN ${first} AND ${last} AND m.key LIKE 'e1rm:%')
    GROUP BY r.key`;

export const liftsBefore = (db: Db, userId: string, first: string, last: string) =>
  db.all<{ key: string; best: number }>(liftsBeforeSql(userId, first, last));

/** Progress charts: per day and discipline, then per day and exercise, from `since` on (spec/game.md §1.11). */
export const progressWorkoutsSql = (userId: string, since: string) =>
  sql`SELECT local_date AS d, discipline, count(*) AS n,
      sum(coalesce(duration_sec, 0) / 60) AS minutes, sum(coalesce(distance_m, 0)) AS distance_m,
      sum(CASE WHEN feel > 0 THEN feel ELSE 0 END) AS feel_sum, sum(CASE WHEN feel > 0 THEN 1 ELSE 0 END) AS feel_n,
      sum(CASE WHEN effort > 0 THEN effort ELSE 0 END) AS effort_sum,
      sum(CASE WHEN effort > 0 THEN 1 ELSE 0 END) AS effort_n
    FROM workouts WHERE user_id = ${userId} AND deleted_at IS NULL AND local_date >= ${since}
    GROUP BY local_date, discipline`;

export const progressWorkouts = (db: Db, userId: string, since: string) =>
  db.all<{
    d: string;
    discipline: string;
    n: number;
    minutes: number;
    distance_m: number;
    feel_sum: number;
    feel_n: number;
    effort_sum: number;
    effort_n: number;
  }>(progressWorkoutsSql(userId, since));

export const progressSetsSql = (userId: string, since: string) =>
  sql`SELECT w.local_date AS d,
      s.exercise_id AS exercise_id, count(*) AS sets,
      sum(CASE WHEN s.weight_kg <> 0 AND s.reps <> 0 THEN s.weight_kg * s.reps ELSE 0 END) AS tonnage
    FROM workouts w JOIN workout_sets s ON s.workout_id = w.id
    WHERE w.user_id = ${userId} AND w.deleted_at IS NULL AND w.local_date >= ${since} AND ${COUNTED_SET}
    GROUP BY w.local_date, s.exercise_id`;

export const progressSets = (db: Db, userId: string, since: string) =>
  db.all<{ d: string; exercise_id: string; sets: number; tonnage: number }>(progressSetsSql(userId, since));

export const progressBodySql = (userId: string, since: string) =>
  sql`SELECT d, max(weight_kg) AS weight_kg, max(body_fat_pct) AS body_fat_pct, max(waist_cm) AS waist_cm,
      max(resting_hr) AS resting_hr, max(sleep_hours) AS sleep_hours, max(has_metric) AS has_metric,
      max(has_weight) AS has_weight
    FROM (
      SELECT measured_on AS d, NULL AS weight_kg, body_fat_pct, waist_cm, resting_hr, sleep_hours,
             1 AS has_metric, 0 AS has_weight
        FROM body_metrics WHERE user_id = ${userId} AND measured_on >= ${since}
      UNION ALL
      SELECT local_date, avg(weight_kg), NULL, NULL, NULL, NULL, 0, 1
        FROM weigh_ins WHERE user_id = ${userId} AND local_date >= ${since} GROUP BY local_date
    ) GROUP BY d ORDER BY d`;

export const progressBody = (db: Db, userId: string, since: string) =>
  db.all<{
    d: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    waist_cm: number | null;
    resting_hr: number | null;
    sleep_hours: number | null;
    has_metric: number;
    has_weight: number;
  }>(progressBodySql(userId, since));

// ---- leaderboards ---------------------------------------------------------------------------------------------

export const BOARDS = {
  consistency: "consistency",
  streak: "current_streak",
  season_xp: "season_xp",
  season_prs: "season_prs",
  life_streak: "life_streak",
} as const;
export type Board = keyof typeof BOARDS;
export type BoardScope = "global" | "following" | "group" | "similar";

export const SOCIAL_MIN_AGE = 16;
export const SIMILAR_BAND = 1.0;

/** SQL twin of `socialAllowed` for profile alias `p`. */
const socialOk = (year: number) =>
  sql`p.birth_year IS NOT NULL AND p.birth_year <= ${year - SOCIAL_MIN_AGE} AND p.social_suspended_at IS NULL
      AND p.deletion_scheduled_at IS NULL AND p.onboarded_at IS NOT NULL`;
const notBlocked = (viewer: string) =>
  sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${viewer} AND b.blocked_id = p.user_id)
                                         OR (b.blocker_id = p.user_id AND b.blocked_id = ${viewer}))`;

export interface BoardRow {
  part: 0 | 1 | 2;
  user_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_hue: number;
  visibility: string;
  is_official: number;
  gamification_enabled: number;
  level: number;
  current_streak: number;
  value: number;
  rank: number;
  participants: number;
}

/**
 * The ranked board (spec/game.md §1.12): the top 50 by rank then handle, plus the caller's own row, each carrying
 * the participant count. Ranks attendance-style numbers only; habits never reach a board.
 */
export function boardQuery(
  viewer: string,
  b: Board,
  scope: BoardScope,
  opts: { year: number; season: string; groupId: string | null },
) {
  const col = sql.raw(`s.${BOARDS[b]}`);
  const conds = [socialOk(opts.year), sql`p.gamification_enabled = 1`, notBlocked(viewer)];
  if (b.startsWith("season")) conds.push(sql`s.season_id = ${opts.season}`);
  if (scope === "global") conds.push(sql`p.leaderboard_opt_in = 1`);
  else if (scope === "similar") {
    const mine = sql`coalesce((SELECT weekly_days4w FROM user_stats WHERE user_id = ${viewer}), 0.0)`;
    conds.push(
      sql`p.leaderboard_opt_in = 1`,
      sql`s.weekly_days4w BETWEEN ${mine} - ${SIMILAR_BAND} AND ${mine} + ${SIMILAR_BAND}`,
    );
  } else if (scope === "following") {
    conds.push(
      sql`(p.user_id = ${viewer} OR p.user_id IN (SELECT followee_id FROM follows
            WHERE follower_id = ${viewer} AND status = 'accepted'))`,
      sql`(p.user_id = ${viewer} OR (${socialOk(opts.year)} AND ${notBlocked(viewer)} AND (p.visibility = 'public'
            OR (p.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${viewer}
                AND f.followee_id = p.user_id AND f.status = 'accepted')))))`,
    );
  } else {
    conds.push(
      sql`p.user_id IN (SELECT user_id FROM group_members WHERE group_id = ${opts.groupId ?? ""})`,
      sql`p.visibility <> 'private'`,
    );
  }
  return boardSql(viewer, col, conds);
}

export const board = (
  db: Db,
  viewer: string,
  b: Board,
  scope: BoardScope,
  opts: { year: number; season: string; groupId: string | null },
) => db.all<BoardRow>(boardQuery(viewer, b, scope, opts));

/** `part` 0 = the top 50, 1 = the caller's own row, 2 = one row carrying only the participant count. */
const boardSql = (viewer: string, col: ReturnType<typeof sql.raw>, conds: ReturnType<typeof sql>[]) =>
  sql`WITH ranked AS (
      SELECT p.user_id, p.handle, p.display_name, p.avatar_hue, p.visibility, p.is_official, p.gamification_enabled,
             s.level, s.current_streak, ${col} AS value, RANK() OVER (ORDER BY ${col} DESC) AS rank
        FROM profiles p JOIN user_stats s ON s.user_id = p.user_id
       WHERE ${sql.join(conds, sql` AND `)}
    ), total AS (SELECT count(*) AS participants FROM ranked)
    SELECT * FROM (SELECT 0 AS part, ranked.*, total.participants FROM ranked, total ORDER BY rank, handle IS NULL, handle LIMIT 50)
    UNION ALL
    SELECT 1, ranked.*, total.participants FROM ranked, total WHERE ranked.user_id = ${viewer}
    UNION ALL
    SELECT 2, NULL, NULL, NULL, 0, '', 0, 0, 0, 0, 0, 0, total.participants FROM total`;

export const groupMembership = (db: Db, groupId: string, userId: string) =>
  db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

// ---- refresh --------------------------------------------------------------------------------------------------

export interface RefreshScope {
  /** Local dates whose workouts changed (old and new dates of a moved workout). `null` = everything. */
  dates: Scope;
  /** Exercise ids whose sets changed (before and after an edit). `null` = everything. */
  exercises: Scope;
}

/** The aggregate rebuild for a scope, for the caller's write batch, after the statements that changed the rows. */
export function refreshStatements(db: Db, userId: string, scope: RefreshScope) {
  const out = [];
  if (scope.dates === null || scope.dates.length > 0) {
    out.push(
      db.run(deleteStatDaysSql(userId, scope.dates)),
      db.run(insertStatDaysSql(userId, scope.dates)),
      db.run(deleteRecordDaysSql(userId, scope.dates)),
      ...insertRecordDaysSql(userId, scope.dates).map((q) => db.run(q)),
    );
  }
  if (scope.exercises === null || scope.exercises.length > 0) {
    out.push(
      db.run(deleteStatExercisesSql(userId, scope.exercises)),
      db.run(insertStatExercisesSql(userId, scope.exercises)),
    );
  }
  return out;
}

// ---- many users at once (a coach's view of a group) ------------------------------------------------------------

/**
 * `user_id IN (...)` over one JSON parameter: any number of users in one statement, each probing the table's
 * user index. D1 counts every statement of a batch against its queries-per-invocation limit (src/lib/plan.ts), so reads that
 * cover a whole group must be per table, not per member.
 */
export const usersIn = (col: SQLiteColumn, userIds: readonly string[]) =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(userIds)}))`;

export const profilesOf = (db: Db, userIds: readonly string[]) =>
  db.select().from(profiles).where(usersIn(profiles.userId, userIds));

/** Every live chain, in each user's chain order; the first per user is the main chain. */
export const chainsOf = (db: Db, userIds: readonly string[]) =>
  db
    .select({
      userId: streakChains.userId,
      id: streakChains.id,
      name: streakChains.name,
      disciplines: streakChains.disciplines,
      targetHistory: streakChains.targetHistory,
      requirementsHistory: streakChains.requirementsHistory,
    })
    .from(streakChains)
    .where(and(usersIn(streakChains.userId, userIds), eq(streakChains.archived, false)))
    .orderBy(asc(streakChains.userId), asc(streakChains.position), asc(streakChains.createdAt));

export const repairsOf = (db: Db, userIds: readonly string[]) =>
  db
    .select({
      userId: streakRepairs.userId,
      chainId: streakRepairs.chainId,
      weekStart: streakRepairs.weekStart,
      month: streakRepairs.month,
    })
    .from(streakRepairs)
    .where(usersIn(streakRepairs.userId, userIds));

export const pausesOf = (db: Db, userIds: readonly string[]) =>
  db
    .select({ userId: streakPauses.userId, startsOn: streakPauses.startsOn, endsOn: streakPauses.endsOn })
    .from(streakPauses)
    .where(usersIn(streakPauses.userId, userIds));

export const wagersOf = (db: Db, userIds: readonly string[]) =>
  db
    .select({ userId: streakWagers.userId, weekStart: streakWagers.weekStart, days: streakWagers.days })
    .from(streakWagers)
    .where(usersIn(streakWagers.userId, userIds));

/** Only what a chain and a plan's progress need from each active day. */
export const dayDisciplinesOf = (db: Db, userIds: readonly string[]) =>
  db
    .select({ userId: statDays.userId, localDate: statDays.localDate, disciplines: statDays.disciplines })
    .from(statDays)
    .where(usersIn(statDays.userId, userIds))
    .orderBy(asc(statDays.userId), asc(statDays.localDate));

// ---- EXPLAIN registry -----------------------------------------------------------------------------------------

const JSON_SCOPE = "scoped by json_each over the touched values; each value probes the user's primary key";
const D = ["2026-01-01"];
const EX = ["back-squat"];
const opts = { year: 2026, season: "2026-Q4", groupId: "g" };
const RANKS = "a leaderboard ranks every eligible profile by design; the filters bound it to opted-in people";

export const explain: ExplainCase[] = [
  { name: "game.deleteStatDays", build: () => deleteStatDaysSql("u", null) },
  { name: "game.deleteStatDaysScoped", build: () => deleteStatDaysSql("u", D), scanOk: JSON_SCOPE },
  { name: "game.insertStatDays", build: () => insertStatDaysSql("u", null) },
  { name: "game.insertStatDaysScoped", build: () => insertStatDaysSql("u", D), scanOk: JSON_SCOPE },
  { name: "game.deleteStatExercises", build: () => deleteStatExercisesSql("u", null) },
  { name: "game.insertStatExercises", build: () => insertStatExercisesSql("u", null) },
  {
    name: "game.insertStatExercisesScoped",
    build: () => insertStatExercisesSql("u", EX),
    scanOk: JSON_SCOPE,
  },
  { name: "game.deleteRecordDays", build: () => deleteRecordDaysSql("u", null) },
  ...insertRecordDaysSql("u", null).map((q, i) => ({ name: `game.insertRecordDays.${i}`, build: () => q })),
  ...insertRecordDaysSql("u", D).map((q, i) => ({
    name: `game.insertRecordDaysScoped.${i}`,
    build: () => q,
    scanOk: JSON_SCOPE,
  })),
  {
    name: "game.insertAchievements",
    build: () => insertAchievementsSql("u", [], 0),
    scanOk: "json_each over the bound rows; the conflict check probes the unique keys",
  },
  {
    name: "game.emitEvents",
    build: () => emitEventsSql("u", "2026-01-01", [], 0),
    scanOk: "json_each over the bound rows; the upsert probes uq_activity_ref",
  },
  { name: "game.profile", build: (db) => profile(db, "u") },
  { name: "game.chains", build: (db) => chains(db, "u") },
  { name: "game.repairs", build: (db) => repairs(db, "u") },
  { name: "game.pauses", build: (db) => pauses(db, "u") },
  { name: "game.wagers", build: (db) => wagers(db, "u") },
  { name: "game.days", build: (db) => days(db, "u") },
  { name: "game.exercises", build: (db) => exercises(db, "u") },
  { name: "game.customs", build: (db) => customs(db, "u") },
  { name: "game.records", build: (db) => records(db, "u") },
  { name: "game.achievements", build: (db) => achievements(db, "u") },
  { name: "game.counts", build: (db) => counts(db, "u") },
  { name: "game.restDayDates", build: (db) => restDayDates(db, "u") },
  { name: "game.wakingDates", build: (db) => wakingDates(db, "u") },
  { name: "game.stats", build: (db) => stats(db, "u") },
  ...(
    [
      ["profilesOf", profilesOf],
      ["chainsOf", chainsOf],
      ["repairsOf", repairsOf],
      ["pausesOf", pausesOf],
      ["wagersOf", wagersOf],
      ["dayDisciplinesOf", dayDisciplinesOf],
    ] as const
  ).map(([name, q]) => ({
    name: `game.${name}`,
    build: (db: Db) => q(db, ["u", "v"]),
    scanOk: "walks the JSON id list; each id probes the table's user index",
  })),
  { name: "game.recordDayRows", build: (db) => recordDayRows(db, "u", null) },
  { name: "game.recordDayRowsScoped", build: (db) => recordDayRows(db, "u", ["e1rm:x"]), scanOk: JSON_SCOPE },
  { name: "game.recentStartHours", build: (db) => recentStartHours(db, "u", "2026-01-01", 0) },
  { name: "game.deleteRecords", build: () => deleteRecordsSql("u", null) },
  { name: "game.deleteRecordsScoped", build: () => deleteRecordsSql("u", ["e1rm:x"]), scanOk: JSON_SCOPE },
  { name: "game.setLearnedHour", build: (db) => setLearnedHour(db, "u", 7, 0) },
  { name: "game.deleteWager", build: (db) => deleteWager(db, "u", "2026-01-05") },
  {
    name: "game.onboardedCount",
    build: (db) => onboardedCount(db),
    scanOk: "rarity denominator, one count per page",
  },
  {
    name: "game.achievementCounts",
    build: (db) => achievementCounts(db),
    scanOk: "rarity across everyone (spec)",
  },
  { name: "game.monthLifts", build: (db) => monthLifts(db, "u", "2026-01-01", "2026-01-31") },
  { name: "game.liftsBefore", build: () => liftsBeforeSql("u", "2026-01-01", "2026-01-31") },
  { name: "game.progressWorkouts", build: () => progressWorkoutsSql("u", "2026-01-01") },
  { name: "game.progressSets", build: () => progressSetsSql("u", "2026-01-01") },
  { name: "game.progressBody", build: () => progressBodySql("u", "2026-01-01") },
  { name: "game.groupMembership", build: (db) => groupMembership(db, "g", "u") },
  ...(["global", "similar", "following", "group"] as const).map((scope) => ({
    name: `game.board.${scope}`,
    build: () => boardQuery("u", "season_xp", scope, opts),
    scanOk: RANKS,
  })),
];
