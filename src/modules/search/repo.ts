/**
 * Search across everything someone has logged, and everything on one day (spec/social.md §5). Owner-private: every
 * statement is bounded by the caller's user id and its index, then filters a short text column. Name columns with
 * a fold twin match folded (case- and accent-insensitive); free-text columns use LIKE, which SQLite folds for
 * ASCII. `%`, `_` and `\` in the term are literal.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import { likePattern } from "../../lib/fold.ts";

export const PER_KIND = 8;

/** `%term%`, escaped, not folded (for columns without a fold twin). */
const plain = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const like = (col: SQL, pattern: string) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;

export const habits = (db: Db, uid: string, q: string) =>
  db.all<{
    id: string;
    name: string;
    emoji: string;
    cue: string | null;
    why: string | null;
    archived_at: number | null;
  }>(
    sql`SELECT id, name, emoji, cue, why, archived_at FROM habits
      WHERE user_id = ${uid} AND (${like(sql`name_fold`, likePattern(q, "contains"))}
        OR ${like(sql`cue`, plain(q))} OR ${like(sql`why`, plain(q))})
      ORDER BY archived_at IS NOT NULL, position, id LIMIT ${PER_KIND}`,
  );

export const habitNotes = (db: Db, uid: string, q: string) =>
  db.all<{ id: string; habit_id: string; day: string; note: string; name: string; emoji: string }>(
    sql`SELECT l.id, l.habit_id, l.day, l.note, h.name, h.emoji
      FROM habit_logs l JOIN habits h ON h.id = l.habit_id
      WHERE l.user_id = ${uid} AND ${like(sql`l.note`, plain(q))}
      ORDER BY l.day DESC, l.id LIMIT ${PER_KIND}`,
  );

export const workouts = (db: Db, uid: string, q: string) =>
  db.all<{ id: string; title: string | null; notes: string | null; discipline: string; local_date: string }>(
    sql`SELECT id, title, notes, discipline, local_date FROM workouts
      WHERE user_id = ${uid} AND deleted_at IS NULL AND (${like(sql`title`, plain(q))} OR ${like(sql`notes`, plain(q))})
      ORDER BY started_at DESC, id LIMIT ${PER_KIND}`,
  );

export const journal = (db: Db, uid: string, q: string) =>
  db.all<{ id: string; day: string; note: string }>(
    sql`SELECT id, day, note FROM journal_days
      WHERE user_id = ${uid} AND ${like(sql`note_fold`, likePattern(q, "contains"))}
      ORDER BY day DESC LIMIT ${PER_KIND}`,
  );

export const foods = (db: Db, uid: string, q: string) =>
  db.all<{ id: string; name: string; brand: string | null; kcal: number }>(
    sql`SELECT id, name, brand, kcal FROM foods
      WHERE user_id = ${uid} AND (${like(sql`name_fold`, likePattern(q, "contains"))} OR ${like(sql`brand`, plain(q))})
      ORDER BY name_fold, name LIMIT ${PER_KIND}`,
  );

export const recipes = (db: Db, uid: string, q: string) =>
  db.all<{ id: string; name: string; kcal: number }>(
    sql`SELECT id, name, kcal FROM recipes
      WHERE user_id = ${uid} AND ${like(sql`name_fold`, likePattern(q, "contains"))}
      ORDER BY name_fold, name LIMIT ${PER_KIND}`,
  );

// ---- one day --------------------------------------------------------------------------------------------------

export const dayWorkouts = (db: Db, uid: string, day: string) =>
  db.all<{
    id: string;
    title: string | null;
    discipline: string;
    duration_sec: number | null;
    distance_m: number | null;
  }>(
    sql`SELECT id, title, discipline, duration_sec, distance_m FROM workouts
      WHERE user_id = ${uid} AND local_date = ${day} AND deleted_at IS NULL ORDER BY started_at, id`,
  );

/** Live habits started by `day`, with that day's log (archived habits are left out even for past days). */
export const dayHabits = (db: Db, uid: string, day: string) =>
  db.all<{
    id: string;
    name: string;
    emoji: string;
    kind: string;
    unit: string | null;
    daily_goal: number | null;
    amount: number | null;
    note: string | null;
  }>(
    sql`SELECT h.id, h.name, h.emoji, h.kind, h.unit, h.daily_goal, l.amount, l.note
      FROM habits h LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.day = ${day}
      WHERE h.user_id = ${uid} AND h.started_on <= ${day} AND h.archived_at IS NULL
      ORDER BY h.position, h.id`,
  );

export const dayMeals = (db: Db, uid: string, day: string) =>
  db.all<{ meal: string; n: number; kcal: number | null; protein_g: number | null }>(
    sql`SELECT meal, count(*) AS n, sum(kcal) AS kcal, sum(protein_g) AS protein_g FROM meal_entries
      WHERE user_id = ${uid} AND day = ${day} GROUP BY meal`,
  );

export const dayJournal = (db: Db, uid: string, day: string) =>
  db.all<{ mood: number | null; note: string | null }>(
    sql`SELECT mood, note FROM journal_days WHERE user_id = ${uid} AND day = ${day}`,
  );

export const dayReadiness = (db: Db, uid: string, day: string) =>
  db.all<{ sleep: number; energy: number; soreness: number }>(
    sql`SELECT sleep, energy, soreness FROM readiness WHERE user_id = ${uid} AND day = ${day}`,
  );

export const dayRest = (db: Db, uid: string, day: string) =>
  db.all<{ kind: string; note: string | null }>(
    sql`SELECT kind, note FROM rest_days WHERE user_id = ${uid} AND day = ${day}`,
  );

export const dayWeighIns = (db: Db, uid: string, day: string) =>
  db.all<{ weight_kg: number; moment: string }>(
    sql`SELECT weight_kg, moment FROM weigh_ins WHERE user_id = ${uid} AND local_date = ${day}
      ORDER BY weighed_at, id`,
  );

// ---- EXPLAIN registry -----------------------------------------------------------------------------------------

const U = "00000000-0000-7000-8000-000000000001";
const D = "2026-01-01";

type Case = { name: string; build: (db: Db) => SQLWrapper; scanOk?: string };

const cases: Case[] = [
  { name: "search.habits", build: (db) => habits(db, U, "gui") },
  { name: "search.habitNotes", build: (db) => habitNotes(db, U, "gui") },
  { name: "search.workouts", build: (db) => workouts(db, U, "gui") },
  { name: "search.journal", build: (db) => journal(db, U, "gui") },
  { name: "search.foods", build: (db) => foods(db, U, "gui") },
  { name: "search.recipes", build: (db) => recipes(db, U, "gui") },
  { name: "search.dayWorkouts", build: (db) => dayWorkouts(db, U, D) },
  { name: "search.dayHabits", build: (db) => dayHabits(db, U, D) },
  { name: "search.dayMeals", build: (db) => dayMeals(db, U, D) },
  { name: "search.dayJournal", build: (db) => dayJournal(db, U, D) },
  { name: "search.dayReadiness", build: (db) => dayReadiness(db, U, D) },
  { name: "search.dayRest", build: (db) => dayRest(db, U, D) },
  { name: "search.dayWeighIns", build: (db) => dayWeighIns(db, U, D) },
];

export const explain: ExplainCase[] = cases.map((c) => ({
  ...c,
  build: (db: Db) => c.build(db).getSQL(),
}));
