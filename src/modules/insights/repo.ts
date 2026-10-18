/**
 * Query builders for the journal and insights (spec/habits.md §1.3, §2.4). Every function returns an un-awaited
 * statement. Day windows depend on the person's local date, which needs their time zone; the insights read uses a
 * UTC-safe superset of the window (local dates are within a day of UTC) so everything fits one round trip, and
 * the service trims it.
 */
import { and, asc, between, eq, gte, isNotNull, isNull, min, ne, sql, sum } from "drizzle-orm";
import { foldLike, withFold } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  bodyMetrics,
  habitLogs,
  habits,
  journalDays,
  mealEntries,
  profiles,
  readiness,
  type TrashPayload,
  trashItems,
  workouts,
} from "../../db/schema/index.ts";

export const timezoneOf = (db: Db, userId: string) =>
  db.select({ timezone: profiles.timezone }).from(profiles).where(eq(profiles.userId, userId));

// ---- journal --------------------------------------------------------------------------------------------------

const journalColumns = {
  id: journalDays.id,
  day: journalDays.day,
  mood: journalDays.mood,
  note: journalDays.note,
};

export const journalSince = (db: Db, userId: string, since: string, q: string | null) =>
  db
    .select(journalColumns)
    .from(journalDays)
    .where(
      and(
        eq(journalDays.userId, userId),
        gte(journalDays.day, since),
        q === null ? undefined : foldLike(journalDays.noteFold, q, "contains"),
      ),
    )
    .orderBy(asc(journalDays.day));

export const journalDay = (db: Db, userId: string, day: string) =>
  db
    .select(journalColumns)
    .from(journalDays)
    .where(and(eq(journalDays.userId, userId), eq(journalDays.day, day)));

export const upsertJournal = (
  db: Db,
  v: { id: string; userId: string; day: string; mood: number | null; note: string | null },
  now: number,
) =>
  db
    .insert(journalDays)
    .values(withFold(journalDays, { ...v, createdAt: now, updatedAt: now }))
    .onConflictDoUpdate({
      target: [journalDays.userId, journalDays.day],
      set: {
        mood: sql`excluded.mood`,
        note: sql`excluded.note`,
        noteFold: sql`excluded.note_fold`,
        updatedAt: now,
      },
    })
    .returning(journalColumns);

export const deleteJournal = (db: Db, userId: string, day: string) =>
  db.delete(journalDays).where(and(eq(journalDays.userId, userId), eq(journalDays.day, day)));

export const insertTrash = (
  db: Db,
  v: { id: string; userId: string; itemId: string; label: string },
  payload: TrashPayload,
  now: number,
) =>
  db.insert(trashItems).values({
    ...v,
    kind: "journal",
    payload,
    deletedAt: now,
    purgeAfter: now + 30 * 86_400_000,
    createdAt: now,
    updatedAt: now,
  });

// ---- insight series (each bounded to [lo, hi]) ----------------------------------------------------------------

export const readinessIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ day: readiness.day, sleep: readiness.sleep, energy: readiness.energy })
    .from(readiness)
    .where(and(eq(readiness.userId, userId), between(readiness.day, lo, hi)));

export const sleepHoursIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ day: bodyMetrics.measuredOn, hours: bodyMetrics.sleepHours })
    .from(bodyMetrics)
    .where(
      and(
        eq(bodyMetrics.userId, userId),
        between(bodyMetrics.measuredOn, lo, hi),
        isNotNull(bodyMetrics.sleepHours),
      ),
    );

export const moodIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ day: journalDays.day, mood: journalDays.mood })
    .from(journalDays)
    .where(
      and(eq(journalDays.userId, userId), between(journalDays.day, lo, hi), isNotNull(journalDays.mood)),
    );

export const firstWorkoutDay = (db: Db, userId: string) =>
  db
    .select({ first: min(workouts.localDate) })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), isNull(workouts.deletedAt)));

export const workoutDaysIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .selectDistinct({ day: workouts.localDate })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), isNull(workouts.deletedAt), between(workouts.localDate, lo, hi)));

export const liveNonQuitHabits = (db: Db, userId: string) =>
  db
    .select({ id: habits.id, kind: habits.kind, dailyGoal: habits.dailyGoal, startedOn: habits.startedOn })
    .from(habits)
    .where(and(eq(habits.userId, userId), isNull(habits.archivedAt), ne(habits.kind, "quit")));

export const habitLogsIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ habitId: habitLogs.habitId, day: habitLogs.day, amount: habitLogs.amount })
    .from(habitLogs)
    .where(and(eq(habitLogs.userId, userId), between(habitLogs.day, lo, hi)));

export const mealTotalsIn = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({
      day: mealEntries.day,
      kcal: sql<number>`${sum(mealEntries.kcal)}`.mapWith(Number),
      protein: sql<number>`${sum(mealEntries.proteinG)}`.mapWith(Number),
    })
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), between(mealEntries.day, lo, hi)))
    .groupBy(mealEntries.day);

// ---- EXPLAIN lint ---------------------------------------------------------------------------------------------

const U = "u";
const D = "2026-01-01";
export const explain: ExplainCase[] = [
  { name: "insights.timezoneOf", build: (db) => timezoneOf(db, U) },
  { name: "insights.journalSince", build: (db) => journalSince(db, U, D, "walk") },
  { name: "insights.journalDay", build: (db) => journalDay(db, U, D) },
  { name: "insights.deleteJournal", build: (db) => deleteJournal(db, U, D) },
  { name: "insights.readinessIn", build: (db) => readinessIn(db, U, D, D) },
  { name: "insights.sleepHoursIn", build: (db) => sleepHoursIn(db, U, D, D) },
  { name: "insights.moodIn", build: (db) => moodIn(db, U, D, D) },
  { name: "insights.firstWorkoutDay", build: (db) => firstWorkoutDay(db, U) },
  { name: "insights.workoutDaysIn", build: (db) => workoutDaysIn(db, U, D, D) },
  { name: "insights.liveNonQuitHabits", build: (db) => liveNonQuitHabits(db, U) },
  { name: "insights.habitLogsIn", build: (db) => habitLogsIn(db, U, D, D) },
  { name: "insights.mealTotalsIn", build: (db) => mealTotalsIn(db, U, D, D) },
];
