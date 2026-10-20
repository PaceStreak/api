/**
 * Query builders for the trash (spec/account.md §15-18). Every function returns an un-awaited statement. The
 * writers live in the modules that delete things (habits, insights, nutrition, training); this module reads,
 * restores and forgets.
 */
import { and, desc, eq, gt, lt, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import { trashItems, workoutSets, workouts } from "../../db/schema/index.ts";

export type TrashRow = typeof trashItems.$inferSelect;

const LIST_LIMIT = 500;

const listColumns = {
  id: trashItems.id,
  kind: trashItems.kind,
  itemId: trashItems.itemId,
  label: trashItems.label,
  deletedAt: trashItems.deletedAt,
  purgeAfter: trashItems.purgeAfter,
};

/** What can still be restored, newest first (ix_trash_user_deleted, walked backwards). */
export const listTrash = (db: Db, userId: string, now: number) =>
  db
    .select(listColumns)
    .from(trashItems)
    .where(and(eq(trashItems.userId, userId), gt(trashItems.purgeAfter, now)))
    .orderBy(desc(trashItems.deletedAt))
    .limit(LIST_LIMIT);

export const trashById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(trashItems)
    .where(and(eq(trashItems.id, id), eq(trashItems.userId, userId)));

/** The workout a `workout` trash entry names, resolved in the same statement so the restore read is one trip. */
const trashedWorkoutId = (userId: string, trashId: string) =>
  sql`(SELECT ${trashItems.itemId} FROM ${trashItems}
    WHERE ${trashItems.id} = ${trashId} AND ${trashItems.userId} = ${userId} AND ${trashItems.kind} = 'workout')`;

export const trashedWorkout = (db: Db, userId: string, trashId: string) =>
  db
    .select({
      id: workouts.id,
      localDate: workouts.localDate,
      discipline: workouts.discipline,
      deletedAt: workouts.deletedAt,
    })
    .from(workouts)
    .where(and(eq(workouts.id, trashedWorkoutId(userId, trashId)), eq(workouts.userId, userId)));

/** The exercises of that workout's sets: the aggregates and records a restore can move. */
export const trashedWorkoutExercises = (db: Db, userId: string, trashId: string) =>
  db
    .selectDistinct({ exerciseId: workoutSets.exerciseId })
    .from(workoutSets)
    .where(and(eq(workoutSets.workoutId, trashedWorkoutId(userId, trashId)), eq(workoutSets.userId, userId)));

/** For `abortUnless`: the entry is still there (a concurrent restore or delete has not taken it). */
export const stillTrashed = (userId: string, id: string) =>
  sql`EXISTS (SELECT 1 FROM ${trashItems} WHERE ${trashItems.id} = ${id} AND ${trashItems.userId} = ${userId})`;

export const deleteOne = (db: Db, userId: string, id: string) =>
  db
    .delete(trashItems)
    .where(and(eq(trashItems.id, id), eq(trashItems.userId, userId)))
    .returning({ id: trashItems.id });

/** Expired entries too, as in Python. */
export const deleteAll = (db: Db, userId: string) =>
  db.delete(trashItems).where(eq(trashItems.userId, userId));

/** The daily housekeeping sweep (JOBS-12): everything past its 30 days (ix_trash_purge_after). */
export const purgeExpired = (db: Db, now: number) =>
  db.delete(trashItems).where(lt(trashItems.purgeAfter, now));

/** One bump of the global sync cursor; the revive below reads it in the same batch. */
export const bumpSeq = (db: Db) =>
  db.run(
    sql`INSERT INTO sync_seq (id, value) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1`,
  );

/** Un-deletes a workout with a fresh `seq`, so every device's `/workouts/changes` picks it up. */
export const reviveWorkout = (db: Db, userId: string, id: string, now: number) =>
  db
    .update(workouts)
    .set({
      deletedAt: null,
      clientUpdatedAt: now,
      updatedAt: now,
      seq: sql`(SELECT value FROM sync_seq WHERE id = 1)`,
    })
    .where(and(eq(workouts.id, id), eq(workouts.userId, userId)));

// ---- EXPLAIN lint ---------------------------------------------------------------------------------------------

const U = "u";
const T = "t";

export interface RestoredLog {
  id: string;
  habitId: string;
  day: string;
  amount: number;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/** JSON text per restore insert: D1 caps a value at 2 MB. */
const LOGS_JSON = 512 * 1024;

/**
 * A restored habit's logs as `INSERT ... SELECT ... FROM json_each(?)`, one statement per 512 KB of rows (about
 * 5,000 logs): one parameter each, so a habit with years of logs costs one or two of the Free plan's 50 D1 queries
 * per invocation instead of one per eleven rows.
 */
export function insertLogsSql(userId: string, rows: readonly RestoredLog[]): SQL[] {
  const out: SQL[] = [];
  let part: RestoredLog[] = [];
  let size = 0;
  const flush = () => {
    if (part.length === 0) return;
    out.push(sql`INSERT INTO habit_logs (id, created_at, updated_at, user_id, habit_id, day, amount, note)
      SELECT j.value ->> 'id', j.value ->> 'createdAt', j.value ->> 'updatedAt', ${userId}, j.value ->> 'habitId', j.value ->> 'day',
        j.value ->> 'amount', j.value ->> 'note'
      FROM json_each(${JSON.stringify(part)}) AS j`);
    part = [];
    size = 0;
  };
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (size + n > LOGS_JSON) flush();
    part.push(r);
    size += n;
  }
  flush();
  return out;
}

export const explain: ExplainCase[] = [
  {
    name: "trash.insertLogs",
    build: () =>
      insertLogsSql("u", [
        { id: "l", habitId: "h", day: "2026-01-01", amount: 1, note: null, createdAt: 0, updatedAt: 0 },
      ])[0] ?? sql`SELECT 1`,
  },
  { name: "trash.listTrash", build: (db) => listTrash(db, U, 0) },
  { name: "trash.trashById", build: (db) => trashById(db, U, T) },
  { name: "trash.trashedWorkout", build: (db) => trashedWorkout(db, U, T) },
  { name: "trash.trashedWorkoutExercises", build: (db) => trashedWorkoutExercises(db, U, T) },
  { name: "trash.stillTrashed", build: () => sql`SELECT ${stillTrashed(U, T)}` },
  { name: "trash.deleteOne", build: (db) => deleteOne(db, U, T) },
  { name: "trash.deleteAll", build: (db) => deleteAll(db, U) },
  { name: "trash.purgeExpired", build: (db) => purgeExpired(db, 0) },
  { name: "trash.reviveWorkout", build: (db) => reviveWorkout(db, U, T, 0) },
];
