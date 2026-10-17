import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, enumCheck, json, ms, nullableCheck } from "./columns.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const HABIT_KINDS = ["check", "duration", "count", "quit"] as const;
export const ROUTINE_TIMES = ["morning", "afternoon", "evening", "anytime"] as const;

/** Private by construction: no habit field ever reaches a feed, profile, group or leaderboard. */
export const habits = sqliteTable(
  "habits",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    nameFold: text().notNull(),
    emoji: text().notNull().default("✨"),
    category: text().notNull().default("other"),
    kind: text({ enum: HABIT_KINDS }).notNull().default("check"),
    unit: text(),
    dailyGoal: real(),
    weeklyTarget: integer().notNull().default(7),
    timeOfDay: text().notNull().default("anytime"),
    cue: text(),
    why: text(),
    totalGoal: real(),
    remindHour: integer(),
    templateId: text(),
    startedOn: text().notNull(),
    position: integer().notNull().default(0),
    archivedAt: ms(),
    snoozedUntil: ms(),
    /** Bit 0 = Monday; NULL = any day. */
    daysMask: integer(),
    pausedFrom: text(),
    pausedUntil: text(),
  },
  (t) => [
    index("ix_habits_user_name").on(t.userId, t.nameFold),
    index("ix_habits_remind_hour")
      .on(t.remindHour)
      .where(sql`${t.remindHour} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    index("ix_habits_snoozed_until").on(t.snoozedUntil).where(sql`${t.snoozedUntil} IS NOT NULL`),
    enumCheck("ck_habit_kind", t.kind, HABIT_KINDS),
    check("ck_habit_weekly_target", sql`${t.weeklyTarget} BETWEEN 1 AND 7`),
    nullableCheck("ck_habit_remind_hour", t.remindHour, sql`${t.remindHour} BETWEEN 0 AND 23`),
  ],
);

export const habitLogs = sqliteTable(
  "habit_logs",
  {
    ...base(),
    habitId: text()
      .notNull()
      .references(() => habits.id, { onDelete: "cascade" }),
    userId: userFk(),
    day: text().notNull(),
    /** 1 for check, minutes, count, or slips for quit. */
    amount: real().notNull(),
    note: text(),
  },
  (t) => [
    unique("uq_habit_log_day").on(t.habitId, t.day),
    index("ix_habit_logs_user_day").on(t.userId, t.day),
  ],
);

export const habitRoutines = sqliteTable(
  "habit_routines",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    emoji: text().notNull().default("🌅"),
    timeOfDay: text({ enum: ROUTINE_TIMES }).notNull().default("morning"),
    habitIds: json<string[]>().notNull(),
  },
  (t) => [
    index("ix_habit_routines_user_id").on(t.userId),
    enumCheck("ck_habit_routine_time", t.timeOfDay, ROUTINE_TIMES),
  ],
);
