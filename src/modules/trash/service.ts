/**
 * The trash: deleted things, restorable for 30 days (spec/account.md §15-18, Python `app/trash`).
 *
 * The writers live with the things they delete and store camelCase drizzle rows: `{ row, children }` for habits
 * (children `habit_logs`), meals, foods, recipes, journal days and habit routines; an empty payload for workouts,
 * which are soft-deleted in place. A restore puts the row back with its original id.
 *
 * Cost model (D1 round trips, auth included):
 * - list, forget, empty: 1.
 * - restore of a meal, food, recipe, journal day or habit routine: 2 (read, write).
 * - restore of a habit or a workout: 3 (read; the write rides in the game recompute's read; its write), because
 *   both move streaks and records, and the recompute runs in the same request as in Python.
 */
import { getTableColumns, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, type Stmt, withFold } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import {
  foods,
  habitLogs,
  habitRoutines,
  habits,
  journalDays,
  mealEntries,
  recipes,
  type TrashPayload,
} from "../../db/schema/index.ts";
import { conflict, HttpError, isConstraintError, notFound } from "../../lib/errors.ts";
import { toWire } from "../../lib/time.ts";
import { recompute, statRefresh } from "../game/service.ts";
import { restoreHabit } from "../habits/service.ts";
import * as repo from "./repo.ts";

export { purgeExpired } from "./repo.ts";

const CLASH = "Something already exists in its place";
const GONE = "That can no longer be restored";
const WORKOUT_GONE = "That session can no longer be restored";

/** Rows per multi-row insert: D1 binds at most 100 parameters per statement. */
const rowsPerInsert = (table: SQLiteTable) =>
  Math.max(1, Math.floor(100 / Object.keys(getTableColumns(table)).length));

/** GET /v1/trash: what can still be restored, newest first. One round trip. */
export async function list(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listTrash(ctx.db, authed.userId, ctx.clock.now()));
  return rows.map((t) => ({
    id: t.id,
    kind: t.kind,
    item_id: t.itemId,
    label: t.label,
    deleted_at: toWire(t.deletedAt),
    purge_after: toWire(t.purgeAfter),
  }));
}

/** DELETE /v1/trash/{id}: one round trip; 404 unless it is the caller's. */
export async function forget(ctx: Ctx, authed: AuthedBatch, trashId: string) {
  const [gone] = await authed.write(repo.deleteOne(ctx.db, authed.userId, trashId.toLowerCase()));
  if (gone.length === 0) throw notFound("Not found");
}

/** DELETE /v1/trash: everything, expired entries included. One round trip. */
export async function empty(ctx: Ctx, authed: AuthedBatch) {
  await authed.write(repo.deleteAll(ctx.db, authed.userId));
}

/**
 * A row from a payload as insert values for `table`: only the table's current columns (a column dropped since is
 * ignored, a column added since takes its default, as Python's `rebuild` did), never a fold column (recomputed from
 * its source), always the caller as owner.
 */
function rebuild<T extends SQLiteTable>(
  table: T,
  data: Record<string, unknown>,
  userId: string,
  now: number,
): T["$inferInsert"] {
  const out: Record<string, unknown> = {};
  const cols = getTableColumns(table);
  for (const key of Object.keys(cols)) {
    if (!key.endsWith("Fold") && key in data) out[key] = data[key];
  }
  if ("userId" in cols) out.userId = userId;
  out.createdAt ??= now;
  out.updatedAt ??= now;
  // Library boundary: the shape is checked column by column above, not by the type system.
  return withFold(table, out as never);
}

function inserts<T extends SQLiteTable>(db: Db, table: T, rows: readonly T["$inferInsert"][]): Stmt[] {
  const per = rowsPerInsert(table);
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += per) out.push(db.insert(table).values(rows.slice(i, i + per)));
  return out;
}

/** POST /v1/trash/{id}/restore. */
export async function restore(ctx: Ctx, authed: AuthedBatch, rawId: string) {
  const trashId = rawId.toLowerCase();
  const db = ctx.db;
  const uid = authed.userId;
  const now = ctx.clock.now();
  const [, items, workoutRows, exerciseRows] = await authed.read(
    repo.trashById(db, uid, trashId),
    repo.trashedWorkout(db, uid, trashId),
    repo.trashedWorkoutExercises(db, uid, trashId),
  );
  const item = items[0];
  // An expired entry is gone from the list; it cannot be restored either (Python restored it until the sweep).
  if (item === undefined || item.purgeAfter <= now) throw notFound("Not found");
  const done = { kind: item.kind, item_id: item.itemId };
  const forgetIt = repo.deleteOne(db, uid, trashId);

  try {
    if (item.kind === "workout") {
      const w = workoutRows[0];
      if (w === undefined) throw new HttpError(410, WORKOUT_GONE);
      const exercises = exerciseRows.map((r) => r.exerciseId);
      await recompute(
        ctx,
        uid,
        { notify: false, scope: { exercises, disciplines: [w.discipline] } },
        {
          authed,
          before: {
            stmts: [
              abortUnless(db, repo.stillTrashed(uid, trashId)),
              repo.bumpSeq(db),
              repo.reviveWorkout(db, uid, w.id, now),
              forgetIt,
              ...statRefresh(ctx, uid, { dates: [w.localDate], exercises }),
            ],
            done: () => {},
          },
        },
      );
      return done;
    }

    const payload: TrashPayload = item.payload ?? {};
    const row = payload.row;
    if (row === undefined || row === null) throw new HttpError(410, GONE);

    if (item.kind === "habit") {
      const habit = rebuild(habits, row, uid, now);
      const habitId = habit.id ?? item.itemId;
      const logs = (payload.children?.habit_logs ?? []).map((l) =>
        rebuild(habitLogs, { ...l, habitId }, uid, now),
      );
      const full = { ...(row as typeof habits.$inferSelect), ...habit, id: habitId };
      await restoreHabit(
        ctx,
        authed,
        full as typeof habits.$inferSelect,
        logs.map((l) => ({
          id: l.id ?? "",
          habitId,
          day: l.day,
          amount: l.amount,
          note: l.note ?? null,
        })),
        [db.insert(habits).values({ ...habit, id: habitId }), ...inserts(db, habitLogs, logs), forgetIt],
      );
      return done;
    }

    let insert: Stmt;
    switch (item.kind) {
      case "meal": {
        const v = rebuild(mealEntries, row, uid, now);
        // The food may be gone for good; the entry keeps its numbers, as when a food is deleted.
        const foodId =
          typeof v.foodId === "string"
            ? sql`(SELECT ${foods.id} FROM ${foods} WHERE ${foods.id} = ${v.foodId} AND ${foods.userId} = ${uid})`
            : null;
        insert = db.insert(mealEntries).values({ ...v, foodId });
        break;
      }
      case "food":
        insert = db.insert(foods).values(rebuild(foods, row, uid, now));
        break;
      case "recipe":
        insert = db.insert(recipes).values(rebuild(recipes, row, uid, now));
        break;
      case "journal":
        insert = db.insert(journalDays).values(rebuild(journalDays, row, uid, now));
        break;
      case "habit_routine":
        insert = db.insert(habitRoutines).values(rebuild(habitRoutines, row, uid, now));
        break;
      default:
        throw new HttpError(410, GONE);
    }
    await authed.write(abortUnless(db, repo.stillTrashed(uid, trashId)), insert, forgetIt);
    return done;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Restored or forgotten by a concurrent request since the read.
    if (isCondAbort(err)) throw notFound("Not found");
    // A journal day written since, a barcode saved again, the same id restored twice: nothing changed.
    if (isConstraintError(err)) throw conflict(CLASH);
    throw err;
  }
}
