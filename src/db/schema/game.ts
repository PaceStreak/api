import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, bool, json, ms } from "./columns.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const WEEK_STATUSES = ["kept", "frozen", "paused", "missed", "open", "repaired"] as const;
export type WeekStatus = (typeof WEEK_STATUSES)[number];

/**
 * Read model for `/me/*`, feeds and leaderboards. `rev` is the optimistic-concurrency token for recompute
 * (DESIGN.md §4, replaces pg_advisory_xact_lock) and the ETag input for stats reads.
 */
export const userStats = sqliteTable(
  "user_stats",
  {
    ...base(),
    userId: userFk(),
    rev: integer().notNull().default(0),
    computedAt: ms().notNull(),
    /** The user's local date when computed. */
    computedFor: text().notNull(),
    totalXp: integer().notNull().default(0),
    level: integer().notNull().default(1),
    /** `2026-Q4`. */
    seasonId: text().notNull(),
    seasonXp: integer().notNull().default(0),
    currentStreak: integer().notNull().default(0),
    longestStreak: integer().notNull().default(0),
    consistency: integer().notNull().default(0),
    thisWeekDays: integer().notNull().default(0),
    thisWeekTarget: integer().notNull().default(3),
    weeklyDays4w: real().notNull().default(0),
    lifeStreak: integer().notNull().default(0),
    sessions: integer().notNull().default(0),
    activeDays: integer().notNull().default(0),
    seasonPrs: integer().notNull().default(0),
    totalPrs: integer().notNull().default(0),
    lastActive: text(),
    /** Last 26 week statuses. */
    recentWeeks: json<WeekStatus[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("ix_user_stats_user_id").on(t.userId),
    index("ix_user_stats_season_xp").on(t.seasonId, t.seasonXp),
    index("ix_user_stats_computed_at").on(t.computedAt),
  ],
);

export const userAchievements = sqliteTable(
  "user_achievements",
  {
    ...base(),
    userId: userFk(),
    achievementId: text().notNull(),
    /** NULL for single badges. */
    tier: text(),
    unlockedOn: text().notNull(),
    evidence: json<{ value: number }>(),
  },
  (t) => [
    unique("uq_user_achievement_tier").on(t.userId, t.achievementId, t.tier),
    index("ix_user_achievements_achievement").on(t.achievementId),
    uniqueIndex("uq_user_achievement_single").on(t.userId, t.achievementId).where(sql`${t.tier} IS NULL`),
  ],
);

export const personalRecords = sqliteTable(
  "personal_records",
  {
    ...base(),
    userId: userFk(),
    /** `<metric>:<exercise_id>`. */
    key: text().notNull(),
    value: real().notNull(),
    previous: real(),
    gainPct: real(),
    achievedOn: text().notNull(),
    /** Not a foreign key. */
    workoutId: text(),
    flagged: bool().notNull().default(false),
    rewarded: bool().notNull().default(false),
    isCurrent: bool().notNull().default(false),
  },
  (t) => [index("ix_personal_records_user_key").on(t.userId, t.key)],
);

export const streakWagers = sqliteTable(
  "streak_wagers",
  {
    ...base(),
    userId: userFk(),
    weekStart: text().notNull(),
    days: integer().notNull(),
  },
  (t) => [unique("uq_streak_wager_week").on(t.userId, t.weekStart)],
);

/**
 * Game aggregates (DESIGN.md §4 "Precomputed aggregates"). Each is a pure function of `workouts` and
 * `workout_sets`, rebuilt by SQL (`INSERT ... SELECT ... GROUP BY`) for the touched days or exercises inside the
 * write batch that changed them (`statRefresh` in src/modules/game/service.ts), or for everything on a full
 * rebuild. They are recomputed from source rows, never patched with deltas, so an incremental refresh and a full
 * rebuild produce the same rows (property-tested). Habits, pauses and rest days are small and read directly.
 */

/** One row per user and local date with any non-deleted workout (future-dated ones included). */
export const statDays = sqliteTable(
  "stat_days",
  {
    userId: userFk(),
    localDate: text().notNull(),
    sessions: integer().notNull().default(0),
    /** Workouts with sets, a duration or a distance. */
    detailed: integer().notNull().default(0),
    durationSec: real().notNull().default(0),
    distanceM: real().notNull().default(0),
    /** Heatmap score: minutes (30 when unknown) weighted by effort. */
    heat: real().notNull().default(0),
    /** Sessions of 1 s to 20 minutes. */
    short: integer().notNull().default(0),
    /** Sessions started before 07:00 / at or after 21:00 local. */
    early: integer().notNull().default(0),
    late: integer().notNull().default(0),
    /** Completed non-warm-up sets with any RPE (the quest; the badge counts RPE 5-10 per exercise). */
    rpeSets: integer().notNull().default(0),
    /** `{discipline: sessions}`. */
    disciplines: json<Record<string, number>>().notNull().default({}),
    /** Distinct exercise ids of completed non-warm-up sets. */
    exercises: json<string[]>().notNull().default([]),
  },
  (t) => [primaryKey({ name: "pk_stat_days", columns: [t.userId, t.localDate] })],
);

/** Lifetime per-exercise totals over completed non-warm-up sets of non-deleted workouts. */
export const statExercises = sqliteTable(
  "stat_exercises",
  {
    userId: userFk(),
    exerciseId: text().notNull(),
    firstSeen: text().notNull(),
    sets: integer().notNull().default(0),
    /** Sets rated RPE 5-10 (the honest-logger badge). */
    rpeSets: integer().notNull().default(0),
    /** Sum of weight x reps over sets with both positive; the engine applies the load-type filter. */
    tonnage: real().notNull().default(0),
  },
  (t) => [primaryKey({ name: "pk_stat_exercises", columns: [t.userId, t.exerciseId] })],
);

/**
 * The best candidate per raw record key and day: the input to PR detection. Raw keys are `e1rm:<ex>` (sets with
 * weight and reps; value 0 past 12 reps), `reps:<ex>` (any set with reps), `repsbw:<ex>` (reps without load),
 * `hold:<ex>`, `distance:<discipline>` and `pace_<band>:run` (seconds per km, lower is better). The engine maps
 * raw keys to record keys by the exercise's load type, which lives in the bundle, not in SQL.
 */
export const recordDays = sqliteTable(
  "record_days",
  {
    userId: userFk(),
    key: text().notNull(),
    localDate: text().notNull(),
    value: real().notNull(),
    workoutId: text().notNull(),
    rewardable: bool().notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_record_days", columns: [t.userId, t.key, t.localDate] }),
    index("ix_record_days_user_date").on(t.userId, t.localDate),
  ],
);
