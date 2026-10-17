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
 * Precomputed per-day aggregates, UPSERTed inside the write batch of every workout, habit-log, pause and rest-day
 * write (DESIGN.md §4). `chain_id` is a streak chain id or `""` for the whole-life aggregate, so it is not a
 * foreign key.
 */
export const statDays = sqliteTable(
  "stat_days",
  {
    userId: userFk(),
    chainId: text().notNull(),
    localDate: text().notNull(),
    sessions: integer().notNull().default(0),
    detailed: integer().notNull().default(0),
    minutes: real().notNull().default(0),
    distanceM: real().notNull().default(0),
    xp: integer().notNull().default(0),
  },
  (t) => [primaryKey({ name: "pk_stat_days", columns: [t.userId, t.chainId, t.localDate] })],
);

export const statWeeks = sqliteTable(
  "stat_weeks",
  {
    userId: userFk(),
    chainId: text().notNull(),
    weekStart: text().notNull(),
    /** Bit 0 = first day of the week. */
    daysMask: integer().notNull().default(0),
    sessions: integer().notNull().default(0),
    detailed: integer().notNull().default(0),
    minutes: real().notNull().default(0),
    distanceM: real().notNull().default(0),
  },
  (t) => [primaryKey({ name: "pk_stat_weeks", columns: [t.userId, t.chainId, t.weekStart] })],
);

/** Current best per record key, so old-session edits rescan only the touched keys. */
export const recordsBest = sqliteTable(
  "records_best",
  {
    userId: userFk(),
    key: text().notNull(),
    value: real().notNull(),
    achievedOn: text().notNull(),
    workoutId: text(),
  },
  (t) => [primaryKey({ name: "pk_records_best", columns: [t.userId, t.key] })],
);
