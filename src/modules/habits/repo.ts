/**
 * Query builders for habits and habit routines (spec/habits.md §3). Every function returns an un-awaited
 * statement. A user's habits and all their logs are read together (Python `habit_views`): the streak of a habit
 * depends on its whole history, and the game snapshot folds them into its single read batch.
 */
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { withFold, withFoldPatch } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  habitLogs,
  habitRoutines,
  habits,
  profiles,
  streakPauses,
  type TrashPayload,
  trashItems,
} from "../../db/schema/index.ts";

export type HabitRow = typeof habits.$inferSelect;
export type HabitInsert = Parameters<typeof withFold<typeof habits>>[1];
export type HabitPatch = Parameters<typeof withFoldPatch<typeof habits>>[1];

export interface LogRow {
  id: string;
  habitId: string;
  day: string;
  amount: number;
  note: string | null;
}

const logColumns = {
  id: habitLogs.id,
  habitId: habitLogs.habitId,
  day: habitLogs.day,
  amount: habitLogs.amount,
  note: habitLogs.note,
};

// ---- reads ----------------------------------------------------------------------------------------------------

/** Time zone and week start; a missing profile reads as UTC and Monday. */
export const profileOf = (db: Db, userId: string) =>
  db
    .select({ timezone: profiles.timezone, weekStartsOn: profiles.weekStartsOn })
    .from(profiles)
    .where(eq(profiles.userId, userId));

export const pausesOf = (db: Db, userId: string) =>
  db
    .select({ startsOn: streakPauses.startsOn, endsOn: streakPauses.endsOn })
    .from(streakPauses)
    .where(eq(streakPauses.userId, userId));

/** Every habit of the user, archived ones included, in display order. */
export const habitRows = (db: Db, userId: string) =>
  db
    .select()
    .from(habits)
    .where(eq(habits.userId, userId))
    .orderBy(asc(habits.position), asc(habits.createdAt));

export const oneHabit = (db: Db, userId: string, habitId: string) =>
  db
    .select()
    .from(habits)
    .where(and(eq(habits.id, habitId), eq(habits.userId, userId)));

/** All logs of the user (the streak needs the whole history). */
export const logRows = (db: Db, userId: string) =>
  db.select(logColumns).from(habitLogs).where(eq(habitLogs.userId, userId));

export const logsOfHabit = (db: Db, userId: string, habitId: string) =>
  db
    .select(logColumns)
    .from(habitLogs)
    .where(and(eq(habitLogs.habitId, habitId), eq(habitLogs.userId, userId)));

export const liveHabitIds = (db: Db, userId: string) =>
  db
    .select({ id: habits.id })
    .from(habits)
    .where(and(eq(habits.userId, userId), isNull(habits.archivedAt)));

// ---- habit writes ---------------------------------------------------------------------------------------------

export const insertHabit = (db: Db, values: HabitInsert) =>
  db.insert(habits).values(withFold(habits, values));

export const updateHabit = (db: Db, userId: string, habitId: string, patch: HabitPatch, now: number) =>
  db
    .update(habits)
    .set({ ...withFoldPatch(habits, patch), updatedAt: now })
    .where(and(eq(habits.id, habitId), eq(habits.userId, userId)));

/** Moves a habit's start back to `day` when a day before it is filled in. */
export const startNoLaterThan = (db: Db, habitId: string, day: string, now: number) =>
  db
    .update(habits)
    .set({ startedOn: sql`min(${habits.startedOn}, ${day})`, updatedAt: now })
    .where(eq(habits.id, habitId));

export const deleteHabit = (db: Db, userId: string, habitId: string) =>
  db.delete(habits).where(and(eq(habits.id, habitId), eq(habits.userId, userId)));

/** Snooze or unsnooze one habit; empty result = not the caller's (404). `liveOnly` for the push action. */
export const setSnooze = (
  db: Db,
  userId: string,
  habitId: string,
  until: number | null,
  now: number,
  liveOnly = false,
) =>
  db
    .update(habits)
    .set({ snoozedUntil: until, updatedAt: now })
    .where(
      and(
        eq(habits.id, habitId),
        eq(habits.userId, userId),
        liveOnly ? isNull(habits.archivedAt) : undefined,
      ),
    )
    .returning({ snoozedUntil: habits.snoozedUntil });

export const setPosition = (db: Db, userId: string, habitId: string, position: number, now: number) =>
  db
    .update(habits)
    .set({ position, updatedAt: now })
    .where(and(eq(habits.id, habitId), eq(habits.userId, userId)));

// ---- log writes -----------------------------------------------------------------------------------------------

/** Set a day's amount (and its note when `setNote`), creating the row if needed. Idempotent. */
export const putLog = (
  db: Db,
  row: { id: string; habitId: string; userId: string; day: string; amount: number; note: string | null },
  setNote: boolean,
  now: number,
) =>
  db
    .insert(habitLogs)
    .values({ ...row, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [habitLogs.habitId, habitLogs.day],
      set: setNote
        ? { amount: sql`excluded.amount`, note: sql`excluded.note`, updatedAt: now }
        : { amount: sql`excluded.amount`, updatedAt: now },
    });

/** Add to a day, capped at 100,000; a new row starts from `amount` (already capped). */
export const addToLog = (
  db: Db,
  row: { id: string; habitId: string; userId: string; day: string },
  amount: number,
  now: number,
) =>
  db
    .insert(habitLogs)
    .values({ ...row, amount: Math.min(100_000, amount), note: null, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [habitLogs.habitId, habitLogs.day],
      set: { amount: sql`min(100000, ${habitLogs.amount} + ${amount})`, updatedAt: now },
    });

export const deleteLog = (db: Db, habitId: string, day: string) =>
  db.delete(habitLogs).where(and(eq(habitLogs.habitId, habitId), eq(habitLogs.day, day)));

/**
 * Many new logs in one statement: `rows` is a JSON array of `[id, habit_id, day, amount]`, so any number of rows
 * binds three parameters. Days already logged are left alone (an import never overwrites).
 */
export const insertLogsJson = (userId: string, rowsJson: string, now: number) =>
  sql`INSERT INTO habit_logs (id, habit_id, user_id, day, amount, note, created_at, updated_at)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ${userId}, json_extract(value, '$[2]'),
      json_extract(value, '$[3]'), NULL, ${now}, ${now}
    FROM json_each(${rowsJson}) WHERE true
    ON CONFLICT (habit_id, day) DO NOTHING`;

// ---- trash ----------------------------------------------------------------------------------------------------

export const RETENTION_DAYS = 30;

/** `label` is cut to 160 code points, as Python did. The payload holds drizzle-shaped rows (camelCase). */
export const insertTrash = (
  db: Db,
  v: { id: string; userId: string; kind: "habit" | "habit_routine"; itemId: string; label: string },
  payload: TrashPayload,
  now: number,
) =>
  db.insert(trashItems).values({
    ...v,
    label: Array.from(v.label).slice(0, 160).join(""),
    payload,
    deletedAt: now,
    purgeAfter: now + RETENTION_DAYS * 86_400_000,
    createdAt: now,
    updatedAt: now,
  });

// ---- routines -------------------------------------------------------------------------------------------------

export type RoutineRow = typeof habitRoutines.$inferSelect;

export const routinesOf = (db: Db, userId: string) =>
  db
    .select()
    .from(habitRoutines)
    .where(eq(habitRoutines.userId, userId))
    .orderBy(asc(habitRoutines.createdAt));

export const oneRoutine = (db: Db, userId: string, routineId: string) =>
  db
    .select()
    .from(habitRoutines)
    .where(and(eq(habitRoutines.id, routineId), eq(habitRoutines.userId, userId)));

export const routineCount = (db: Db, userId: string) =>
  db.select({ n: count() }).from(habitRoutines).where(eq(habitRoutines.userId, userId));

export const insertRoutine = (db: Db, row: typeof habitRoutines.$inferInsert) =>
  db.insert(habitRoutines).values(row);

export const updateRoutine = (
  db: Db,
  userId: string,
  routineId: string,
  v: { name: string; emoji: string; timeOfDay: RoutineRow["timeOfDay"]; habitIds: string[] },
  now: number,
) =>
  db
    .update(habitRoutines)
    .set({ ...v, updatedAt: now })
    .where(and(eq(habitRoutines.id, routineId), eq(habitRoutines.userId, userId)));

export const deleteRoutine = (db: Db, userId: string, routineId: string) =>
  db.delete(habitRoutines).where(and(eq(habitRoutines.id, routineId), eq(habitRoutines.userId, userId)));

// ---- EXPLAIN lint ---------------------------------------------------------------------------------------------

const U = "u";
const H = "h";
export const explain: ExplainCase[] = [
  { name: "habits.profileOf", build: (db) => profileOf(db, U) },
  { name: "habits.pausesOf", build: (db) => pausesOf(db, U) },
  { name: "habits.habitRows", build: (db) => habitRows(db, U) },
  { name: "habits.oneHabit", build: (db) => oneHabit(db, U, H) },
  { name: "habits.logRows", build: (db) => logRows(db, U) },
  { name: "habits.logsOfHabit", build: (db) => logsOfHabit(db, U, H) },
  { name: "habits.liveHabitIds", build: (db) => liveHabitIds(db, U) },
  { name: "habits.updateHabit", build: (db) => updateHabit(db, U, H, { cue: null }, 0) },
  { name: "habits.startNoLaterThan", build: (db) => startNoLaterThan(db, H, "2026-01-01", 0) },
  { name: "habits.deleteHabit", build: (db) => deleteHabit(db, U, H) },
  { name: "habits.setSnooze", build: (db) => setSnooze(db, U, H, 1, 0, true) },
  { name: "habits.setPosition", build: (db) => setPosition(db, U, H, 1, 0) },
  { name: "habits.deleteLog", build: (db) => deleteLog(db, H, "2026-01-01") },
  { name: "habits.routinesOf", build: (db) => routinesOf(db, U) },
  { name: "habits.oneRoutine", build: (db) => oneRoutine(db, U, H) },
  { name: "habits.routineCount", build: (db) => routineCount(db, U) },
  { name: "habits.deleteRoutine", build: (db) => deleteRoutine(db, U, H) },
];
