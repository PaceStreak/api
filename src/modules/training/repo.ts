/**
 * Query builders for the training module (spec/training-a.md §3, training-b.md §3). Every function returns an
 * un-awaited statement.
 *
 * Bulk writes (workouts, sets, imports) go through `jsonInsert`: one `INSERT ... SELECT ... FROM json_each(?)`
 * per ~512 KiB of rows, so a 200-op outbox flush or a 5,000-session import binds one parameter per statement
 * instead of thousands, and stays far below D1's per-invocation statement limit.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  bodyMetrics,
  bodyPhotos,
  customExercises,
  exerciseNotes,
  gear,
  gyms,
  monthlyGoals,
  personalRecords,
  profiles,
  readiness,
  restDays,
  routines,
  streakChains,
  streakPauses,
  trainingBlocks,
  trainingPlans,
  weekReflections,
  weighIns,
  weightGoals,
  workoutSets,
  workouts,
} from "../../db/schema/index.ts";

const W = sql.raw;
const json = (v: unknown) => JSON.stringify(v);
/** `col IN (SELECT value FROM json_each(?))`: any number of values, one bound parameter. */
const inJson = (col: SQLWrapper, values: readonly unknown[]) =>
  sql`${col} IN (SELECT value FROM json_each(${json(values)}))`;

// ---- bulk JSON inserts ----------------------------------------------------------------------------------------

/** Bytes of JSON per statement: well inside D1's 2 MB value limit. */
const CHUNK_CHARS = 512 * 1024;

/**
 * `INSERT INTO table (cols) SELECT json_extract(j.value, '$.col'), ... FROM json_each(?) j WHERE true <tail>`,
 * chunked by size. Row keys are the snake_case column names; arrays and objects land as JSON text, booleans as
 * 0/1 (`json_extract` semantics). `WHERE true` keeps SQLite's upsert parser happy before `ON CONFLICT`.
 */
export function jsonInsert(
  table: string,
  cols: readonly string[],
  rows: readonly Record<string, unknown>[],
  tail: SQL = sql``,
): SQL[] {
  if (rows.length === 0) return [];
  const into = W(
    `INSERT INTO ${table} (${cols.join(", ")}) SELECT ${cols.map((c) => `json_extract(j.value, '$.${c}')`).join(", ")} FROM json_each(`,
  );
  const out: SQL[] = [];
  let chunk: string[] = [];
  let size = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    out.push(sql`${into}${`[${chunk.join(",")}]`}) j WHERE true ${tail}`);
    chunk = [];
    size = 0;
  };
  for (const r of rows) {
    const s = json(r);
    if (size + s.length > CHUNK_CHARS) flush();
    chunk.push(s);
    size += s.length + 1;
  }
  flush();
  return out;
}

// ---- profile --------------------------------------------------------------------------------------------------

export const profile = (db: Db, userId: string) =>
  db
    .select({
      timezone: profiles.timezone,
      weekStartsOn: profiles.weekStartsOn,
      weightUnit: profiles.weightUnit,
      maxHr: profiles.maxHr,
      birthYear: profiles.birthYear,
      visibility: profiles.visibility,
      sharingPaused: profiles.sharingPaused,
      socialSuspendedAt: profiles.socialSuspendedAt,
      deletionScheduledAt: profiles.deletionScheduledAt,
      onboardedAt: profiles.onboardedAt,
      photoBackup: profiles.photoBackup,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId));

// ---- workouts: reads ------------------------------------------------------------------------------------------

/** Rows by id, whoever owns them (a foreign id must be told apart from a new one). */
export const workoutsByIds = (db: Db, ids: readonly string[]) =>
  db.select().from(workouts).where(inJson(workouts.id, ids));

export const setsOf = (db: Db, userId: string, workoutIds: readonly string[]) =>
  db
    .select()
    .from(workoutSets)
    .where(and(eq(workoutSets.userId, userId), inJson(workoutSets.workoutId, workoutIds)))
    .orderBy(asc(workoutSets.workoutId), asc(workoutSets.position), asc(workoutSets.setIndex));

export const customsByIds = (db: Db, userId: string, ids: readonly string[]) =>
  db
    .select({ id: customExercises.id, name: customExercises.name })
    .from(customExercises)
    .where(and(eq(customExercises.userId, userId), inJson(customExercises.id, ids)));

export const gearByIds = (db: Db, userId: string, ids: readonly string[]) =>
  db
    .select({ id: gear.id })
    .from(gear)
    .where(and(eq(gear.userId, userId), inJson(gear.id, ids)));

export const gymsByIds = (db: Db, userId: string, ids: readonly string[]) =>
  db
    .select({ id: gyms.id })
    .from(gyms)
    .where(and(eq(gyms.userId, userId), inJson(gyms.id, ids)));

export interface ListFilter {
  before?: number | undefined;
  discipline?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  limit: number;
}

function listWhere(userId: string, f: ListFilter): SQL {
  const parts: SQL[] = [sql`w.user_id = ${userId}`, sql`w.deleted_at IS NULL`];
  if (f.before !== undefined) parts.push(sql`w.started_at < ${f.before}`);
  if (f.discipline) parts.push(sql`w.discipline = ${f.discipline}`);
  if (f.start) parts.push(sql`w.local_date >= ${f.start}`);
  if (f.end) parts.push(sql`w.local_date <= ${f.end}`);
  return sql.join(parts, sql` AND `);
}

const listIds = (userId: string, f: ListFilter) =>
  sql`SELECT w.id FROM workouts w WHERE ${listWhere(userId, f)} ORDER BY w.started_at DESC LIMIT ${f.limit}`;

export const listWorkouts = (db: Db, userId: string, f: ListFilter) =>
  db
    .select()
    .from(workouts)
    .where(sql`${workouts.id} IN (${listIds(userId, f)})`)
    .orderBy(desc(workouts.startedAt));

export const listSets = (db: Db, userId: string, f: ListFilter) =>
  db
    .select()
    .from(workoutSets)
    .where(and(eq(workoutSets.userId, userId), sql`${workoutSets.workoutId} IN (${listIds(userId, f)})`))
    .orderBy(asc(workoutSets.workoutId), asc(workoutSets.position), asc(workoutSets.setIndex));

/** The changes feed: rows with `seq > since`, tombstones included, one extra row to tell `more`. */
const changeIds = (userId: string, since: number, limit: number) =>
  sql`SELECT w.id FROM workouts w WHERE w.user_id = ${userId} AND w.seq > ${since} ORDER BY w.seq LIMIT ${limit + 1}`;

export const changes = (db: Db, userId: string, since: number, limit: number) =>
  db
    .select()
    .from(workouts)
    .where(and(eq(workouts.userId, userId), sql`${workouts.seq} > ${since}`))
    .orderBy(asc(workouts.seq))
    .limit(limit + 1);

export const changeSets = (db: Db, userId: string, since: number, limit: number) =>
  db
    .select()
    .from(workoutSets)
    .where(
      and(
        eq(workoutSets.userId, userId),
        sql`${workoutSets.workoutId} IN (${changeIds(userId, since, limit)})`,
      ),
    )
    .orderBy(asc(workoutSets.workoutId), asc(workoutSets.position), asc(workoutSets.setIndex));

/** The newest `seq` among the user's rows: the changes feed's ETag input. */
export const maxSeq = (db: Db, userId: string) =>
  db.all<{ seq: number | null }>(sql`SELECT max(seq) AS seq FROM workouts WHERE user_id = ${userId}`);

export const oneWorkout = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, id), eq(workouts.userId, userId), isNull(workouts.deletedAt)));

export const oneWorkoutSets = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(workoutSets)
    .where(and(eq(workoutSets.workoutId, id), eq(workoutSets.userId, userId)))
    .orderBy(asc(workoutSets.position), asc(workoutSets.setIndex));

// ---- workouts: writes -----------------------------------------------------------------------------------------

/** Moves the global cursor by `n` and returns the new value; row i of the batch takes `value - n + i`. */
export const bumpSeq = (db: Db, n: number) =>
  db.all<{ value: number }>(
    sql`INSERT INTO sync_seq (id, value) VALUES (1, ${n}) ON CONFLICT (id) DO UPDATE SET value = value + ${n} RETURNING value`,
  );

export const WORKOUT_COLS = [
  "id",
  "created_at",
  "updated_at",
  "user_id",
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
  "routine_id",
  "tags",
  "splits",
  "gear_id",
  "gym_id",
  "source",
  "client_updated_at",
  "deleted_at",
  "seq",
] as const;

const UPDATABLE = WORKOUT_COLS.filter((c) => c !== "id" && c !== "created_at" && c !== "user_id");

/**
 * Upserts final workout rows. `seq` in each row is an offset 1..n into the bump of the same batch. The update
 * never crosses owners (defence in depth: the read already 404'd foreign ids and the batch guard pins them).
 */
export function upsertWorkouts(db: Db, rows: readonly Record<string, unknown>[], n: number) {
  const cols = WORKOUT_COLS.filter((c) => c !== "seq");
  const into = W(
    `INSERT INTO workouts (${WORKOUT_COLS.join(", ")}) SELECT ${cols.map((c) => `json_extract(j.value, '$.${c}')`).join(", ")}, `,
  );
  const set = W(UPDATABLE.map((c) => `${c} = excluded.${c}`).join(", "));
  const out: ReturnType<Db["run"]>[] = [];
  let chunk: string[] = [];
  let size = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    out.push(
      db.run(sql`${into}(SELECT value FROM sync_seq WHERE id = 1) - ${n} + json_extract(j.value, '$.seq')
        FROM json_each(${`[${chunk.join(",")}]`}) j WHERE true
        ON CONFLICT (id) DO UPDATE SET ${set} WHERE workouts.user_id = excluded.user_id`),
    );
    chunk = [];
    size = 0;
  };
  for (const r of rows) {
    const s = json(r);
    if (size + s.length > CHUNK_CHARS) flush();
    chunk.push(s);
    size += s.length + 1;
  }
  flush();
  return out;
}

export const SET_COLS = [
  "id",
  "created_at",
  "updated_at",
  "workout_id",
  "user_id",
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
] as const;

export const insertSets = (db: Db, rows: readonly Record<string, unknown>[]) =>
  jsonInsert("workout_sets", SET_COLS, rows).map((q) => db.run(q));

export const deleteSetsOf = (db: Db, userId: string, workoutIds: readonly string[]) =>
  db
    .delete(workoutSets)
    .where(and(eq(workoutSets.userId, userId), inJson(workoutSets.workoutId, workoutIds)));

/**
 * The batch guard: every id the read saw as the caller's still has the `seq` it had, and every id it saw as absent
 * is still absent. A concurrent writer makes the batch abort and the service re-read.
 */
export function unchangedSince(present: Readonly<Record<string, number>>, absent: readonly string[]): SQL {
  const n = Object.keys(present).length;
  const presentOk =
    n === 0
      ? sql`1`
      : sql`(SELECT count(*) FROM json_each(${json(present)}) j JOIN workouts w ON w.id = j.key AND w.seq = j.value) = ${n}`;
  const absentOk =
    absent.length === 0
      ? sql`1`
      : sql`NOT EXISTS (SELECT 1 FROM workouts w WHERE ${inJson(W("w.id"), absent)})`;
  return sql`${presentOk} AND ${absentOk}`;
}

export const TRASH_COLS = [
  "id",
  "created_at",
  "updated_at",
  "user_id",
  "kind",
  "item_id",
  "label",
  "payload",
  "deleted_at",
  "purge_after",
] as const;

export const insertTrash = (db: Db, rows: readonly Record<string, unknown>[]) =>
  jsonInsert("trash_items", TRASH_COLS, rows).map((q) => db.run(q));

export const deleteTrash = (db: Db, userId: string, kind: string, itemIds: readonly string[]) =>
  db.run(
    sql`DELETE FROM trash_items WHERE user_id = ${userId} AND kind = ${kind} AND ${inJson(W("item_id"), itemIds)}`,
  );

export const deleteEventsOf = (db: Db, workoutIds: readonly string[]) =>
  db.run(sql`DELETE FROM activity_events WHERE ${inJson(W("workout_id"), workoutIds)}`);

const EVENT_COLS = [
  "id",
  "created_at",
  "updated_at",
  "user_id",
  "kind",
  "ref_key",
  "data",
  "occurred_on",
  "workout_id",
] as const;

/** Feed events, `ON CONFLICT (user, kind, ref) DO UPDATE SET data` like Python `emit_event`. */
export const upsertEvents = (db: Db, rows: readonly Record<string, unknown>[]) =>
  jsonInsert(
    "activity_events",
    EVENT_COLS,
    rows,
    sql`ON CONFLICT (user_id, kind, ref_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).map((q) => db.run(q));

export const touchRoutines = (db: Db, userId: string, ids: readonly string[], now: number) =>
  db
    .update(routines)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(and(eq(routines.userId, userId), inJson(routines.id, ids)));

// ---- imports --------------------------------------------------------------------------------------------------

/** Live workouts in a time window (the ±3 minute duplicate check of every imported session). */
export const workoutsBetween = (db: Db, userId: string, from: number, to: number) =>
  db
    .select({ id: workouts.id, startedAt: workouts.startedAt, discipline: workouts.discipline })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, userId),
        isNull(workouts.deletedAt),
        sql`${workouts.startedAt} BETWEEN ${from} AND ${to}`,
      ),
    );

export const allCustoms = (db: Db, userId: string) =>
  db
    .select({ id: customExercises.id, name: customExercises.name })
    .from(customExercises)
    .where(eq(customExercises.userId, userId));

export const CUSTOM_COLS = [
  "id",
  "created_at",
  "updated_at",
  "user_id",
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
  "archived",
] as const;

export const insertCustoms = (db: Db, rows: readonly Record<string, unknown>[]) =>
  jsonInsert(
    "custom_exercises",
    CUSTOM_COLS.map((c) => (c === "primary" ? '"primary"' : c)),
    rows,
  ).map((q) => db.run(q));

// ---- exercise history -----------------------------------------------------------------------------------------

/** The newest workout per exercise with a completed set of it, and all that workout's sets of it (`/exercises/last`). */
export const lastSets = (db: Db, userId: string, ids: readonly string[]) =>
  db.all<{
    ex: string;
    d: string;
    kind: string;
    weight_kg: number | null;
    reps: number | null;
    rpe: number | null;
    duration_sec: number | null;
  }>(sql`WITH latest AS (
      SELECT s.exercise_id AS ex, w.id AS wid, w.local_date AS d,
        row_number() OVER (PARTITION BY s.exercise_id ORDER BY w.started_at DESC, w.id DESC) AS rn
      FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
      WHERE s.user_id = ${userId} AND ${inJson(W("s.exercise_id"), ids)} AND s.completed = 1
        AND w.deleted_at IS NULL)
    SELECT l.ex, l.d, s2.kind, s2.weight_kg, s2.reps, s2.rpe, s2.duration_sec
    FROM latest l JOIN workout_sets s2 ON s2.workout_id = l.wid AND s2.exercise_id = l.ex
    WHERE l.rn = 1 ORDER BY l.ex, s2.set_index`);

/** Completed sets of one exercise in the newest `limit` workouts that have one, newest first. */
export const historySets = (db: Db, userId: string, exerciseId: string, limit: number) =>
  db.all<{
    wid: string;
    d: string;
    kind: string;
    weight_kg: number | null;
    reps: number | null;
    rpe: number | null;
    duration_sec: number | null;
  }>(sql`WITH picked AS (
      SELECT w.id, w.started_at FROM workouts w
      WHERE w.user_id = ${userId} AND w.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM workout_sets s WHERE s.workout_id = w.id AND s.exercise_id = ${exerciseId} AND s.completed = 1)
      ORDER BY w.started_at DESC LIMIT ${limit})
    SELECT w.id AS wid, w.local_date AS d, s.kind, s.weight_kg, s.reps, s.rpe, s.duration_sec
    FROM picked p JOIN workouts w ON w.id = p.id
      JOIN workout_sets s ON s.workout_id = w.id AND s.exercise_id = ${exerciseId} AND s.completed = 1
      AND s.user_id = ${userId}
    ORDER BY p.started_at DESC, s.set_index`);

/** Records of one exercise: its set-derived keys, exactly (Python's `LIKE '%:id'` also matched wildcards). */
export const exerciseRecords = (db: Db, userId: string, exerciseId: string) =>
  db
    .select()
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        inArray(
          personalRecords.key,
          ["e1rm", "reps", "repsbw", "hold"].map((p) => `${p}:${exerciseId}`),
        ),
      ),
    )
    .orderBy(desc(personalRecords.achievedOn));

// ---- custom exercises and routines ----------------------------------------------------------------------------

export const listCustoms = (db: Db, userId: string) =>
  db
    .select()
    .from(customExercises)
    .where(eq(customExercises.userId, userId))
    .orderBy(asc(customExercises.nameFold), asc(customExercises.name));

export const countCustoms = (db: Db, userId: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM custom_exercises WHERE user_id = ${userId}`);

export const customById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(customExercises)
    .where(and(eq(customExercises.id, id), eq(customExercises.userId, userId)));

/**
 * Any set still naming the exercise (archive rather than delete). Only its owner can log a custom exercise, so the
 * owner's sets are all there is to check (Python scanned everyone's).
 */
export const customUsed = (db: Db, userId: string, exerciseId: string) =>
  db.all<{ one: number }>(
    sql`SELECT 1 AS one FROM workout_sets WHERE user_id = ${userId} AND exercise_id = ${exerciseId} LIMIT 1`,
  );

export const listRoutines = (db: Db, userId: string) =>
  db
    .select()
    .from(routines)
    .where(eq(routines.userId, userId))
    .orderBy(asc(routines.position), asc(routines.nameFold), asc(routines.name));

export const countRoutines = (db: Db, userId: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM routines WHERE user_id = ${userId}`);

export const routineById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.userId, userId)));

export const routinesByIds = (db: Db, userId: string, ids: readonly string[]) =>
  db
    .select()
    .from(routines)
    .where(and(eq(routines.userId, userId), inJson(routines.id, ids)));

/** The user's routines by name (for plan templates and imports, which reuse a same-named routine). */
export const routineNames = (db: Db, userId: string) =>
  db
    .select({ id: routines.id, name: routines.name, createdAt: routines.createdAt })
    .from(routines)
    .where(eq(routines.userId, userId))
    .orderBy(asc(routines.createdAt), asc(routines.id));

// ---- body ------------------------------------------------------------------------------------------------------

export const metricsSince = (db: Db, userId: string, since: string) =>
  db
    .select()
    .from(bodyMetrics)
    .where(and(eq(bodyMetrics.userId, userId), sql`${bodyMetrics.measuredOn} >= ${since}`))
    .orderBy(asc(bodyMetrics.measuredOn));

export const weighInsSince = (db: Db, userId: string, since: string) =>
  db
    .select()
    .from(weighIns)
    .where(and(eq(weighIns.userId, userId), sql`${weighIns.localDate} >= ${since}`))
    .orderBy(asc(weighIns.weighedAt));

export const weighInOwner = (db: Db, id: string) =>
  db.select({ userId: weighIns.userId }).from(weighIns).where(eq(weighIns.id, id));

export const photos = (db: Db, userId: string) =>
  db
    .select()
    .from(bodyPhotos)
    .where(eq(bodyPhotos.userId, userId))
    .orderBy(desc(bodyPhotos.takenOn), desc(bodyPhotos.createdAt));

export const photoById = (db: Db, id: string) => db.select().from(bodyPhotos).where(eq(bodyPhotos.id, id));

export const countPhotos = (db: Db, userId: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM body_photos WHERE user_id = ${userId}`);

/** Every backed-up photo row of the user, gone; the object keys come back for R2. */
export const deleteAllPhotos = (db: Db, userId: string) =>
  db.delete(bodyPhotos).where(eq(bodyPhotos.userId, userId)).returning({ key: bodyPhotos.objectKey });

/**
 * Undoes an upload's row in the same batch that wrote it when the account's backup is off by then (it was turned
 * off on another device between the upload's read and its write). Returns the key when it did.
 */
export const dropPhotoIfBackupOff = (db: Db, userId: string, id: string) =>
  db
    .delete(bodyPhotos)
    .where(
      and(
        eq(bodyPhotos.id, id),
        eq(bodyPhotos.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = ${userId} AND photo_backup = 1)`,
      ),
    )
    .returning({ key: bodyPhotos.objectKey });

// ---- chains and pauses -----------------------------------------------------------------------------------------

export const liveChains = (db: Db, userId: string) =>
  db
    .select()
    .from(streakChains)
    .where(and(eq(streakChains.userId, userId), eq(streakChains.archived, false)))
    .orderBy(asc(streakChains.position), asc(streakChains.createdAt));

export const pauseById = (db: Db, id: string) =>
  db.select().from(streakPauses).where(eq(streakPauses.id, id));

// ---- gear -----------------------------------------------------------------------------------------------------

export const listGear = (db: Db, userId: string) =>
  db
    .select()
    .from(gear)
    .where(eq(gear.userId, userId))
    .orderBy(sql`${gear.retiredAt} IS NOT NULL`, asc(gear.createdAt));

export const gearUsage = (db: Db, userId: string) =>
  db.all<{ gear_id: string; dist: number; n: number; last: string | null }>(
    sql`SELECT gear_id, coalesce(sum(distance_m), 0.0) AS dist, count(*) AS n, max(local_date) AS last
      FROM workouts WHERE user_id = ${userId} AND deleted_at IS NULL AND gear_id IS NOT NULL GROUP BY gear_id`,
  );

// ---- personal -------------------------------------------------------------------------------------------------

export const listGyms = (db: Db, userId: string) =>
  db.select().from(gyms).where(eq(gyms.userId, userId)).orderBy(desc(gyms.isDefault), asc(gyms.createdAt));

export const clearOtherDefaults = (db: Db, userId: string, keep: string, now: number) =>
  db
    .update(gyms)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(gyms.userId, userId), ne(gyms.id, keep), eq(gyms.isDefault, true)));

export const notes = (db: Db, userId: string) =>
  db
    .select({ exerciseId: exerciseNotes.exerciseId, note: exerciseNotes.note })
    .from(exerciseNotes)
    .where(eq(exerciseNotes.userId, userId));

export const goal = (db: Db, userId: string) =>
  db.select().from(weightGoals).where(eq(weightGoals.userId, userId));

export const weighInAverage = (db: Db, userId: string, after: string) =>
  db.all<{ avg: number | null }>(
    sql`SELECT avg(weight_kg) AS avg FROM weigh_ins WHERE user_id = ${userId} AND local_date > ${after}`,
  );

export const liveBlocks = (db: Db, userId: string) =>
  db
    .select()
    .from(trainingBlocks)
    .where(and(eq(trainingBlocks.userId, userId), isNull(trainingBlocks.endedAt)))
    .orderBy(desc(trainingBlocks.startsOn));

export const blockById = (db: Db, id: string) =>
  db.select().from(trainingBlocks).where(eq(trainingBlocks.id, id));

export const readinessSince = (db: Db, userId: string, since: string) =>
  db
    .select()
    .from(readiness)
    .where(and(eq(readiness.userId, userId), sql`${readiness.day} >= ${since}`))
    .orderBy(asc(readiness.day));

export const reflections = (db: Db, userId: string) =>
  db
    .select()
    .from(weekReflections)
    .where(eq(weekReflections.userId, userId))
    .orderBy(desc(weekReflections.weekStart));

// ---- monthly goals and rest days ------------------------------------------------------------------------------

export const monthGoal = (db: Db, userId: string, month: string) =>
  db
    .select({ days: monthlyGoals.days })
    .from(monthlyGoals)
    .where(and(eq(monthlyGoals.userId, userId), eq(monthlyGoals.month, month)));

export const activeDays = (db: Db, userId: string, first: string, last: string) =>
  db.all<{ n: number }>(
    sql`SELECT count(DISTINCT local_date) AS n FROM workouts
      WHERE user_id = ${userId} AND deleted_at IS NULL AND local_date >= ${first} AND local_date <= ${last}`,
  );

export const restDaysSince = (db: Db, userId: string, since: string) =>
  db
    .select({ day: restDays.day, kind: restDays.kind, note: restDays.note })
    .from(restDays)
    .where(and(eq(restDays.userId, userId), sql`${restDays.day} >= ${since}`))
    .orderBy(asc(restDays.day));

// ---- plans ----------------------------------------------------------------------------------------------------

export const listPlans = (db: Db, userId: string) =>
  db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.userId, userId))
    .orderBy(desc(trainingPlans.createdAt));

export const countPlans = (db: Db, userId: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM training_plans WHERE user_id = ${userId}`);

export const activePlan = (db: Db, userId: string) =>
  db
    .select()
    .from(trainingPlans)
    .where(
      and(
        eq(trainingPlans.userId, userId),
        isNotNull(trainingPlans.startedOn),
        isNull(trainingPlans.finishedAt),
      ),
    )
    .orderBy(desc(trainingPlans.startedOn), desc(trainingPlans.id))
    .limit(1);

export const planById = (db: Db, id: string) =>
  db.select().from(trainingPlans).where(eq(trainingPlans.id, id));

/** Stops every other running plan (Python `run_only`). */
export const stopOtherPlans = (db: Db, userId: string, keep: string, now: number) =>
  db
    .update(trainingPlans)
    .set({ startedOn: null, updatedAt: now })
    .where(
      and(
        eq(trainingPlans.userId, userId),
        ne(trainingPlans.id, keep),
        isNotNull(trainingPlans.startedOn),
        isNull(trainingPlans.finishedAt),
      ),
    );

/** (local_date, discipline) of logged sessions in a date range, for plan matching. */
export const logged = (db: Db, userId: string, start: string, end: string, appOnly: boolean) =>
  db.all<{ d: string; discipline: string }>(
    sql`SELECT local_date AS d, discipline FROM workouts
      WHERE user_id = ${userId} AND deleted_at IS NULL AND local_date >= ${start} AND local_date <= ${end}
      ${appOnly ? sql`AND source = 'app'` : sql``}`,
  );

// ---- EXPLAIN registry -----------------------------------------------------------------------------------------

const JSON_ROWS = "json_each over the request's own rows; each one probes a primary key or unique index";
const IDS = ["00000000-0000-7000-8000-000000000000"];
const ROW = { id: "x" };

type Case = {
  name: string;
  build: (db: Db) => SQLWrapper | { toSQL(): { sql: string; params: unknown[] } };
  scanOk?: string;
};

const cases: Case[] = [
  { name: "training.profile", build: (db) => profile(db, "u") },
  { name: "training.workoutsByIds", build: (db) => workoutsByIds(db, IDS), scanOk: JSON_ROWS },
  { name: "training.setsOf", build: (db) => setsOf(db, "u", IDS), scanOk: JSON_ROWS },
  { name: "training.customsByIds", build: (db) => customsByIds(db, "u", IDS), scanOk: JSON_ROWS },
  { name: "training.gearByIds", build: (db) => gearByIds(db, "u", IDS), scanOk: JSON_ROWS },
  { name: "training.gymsByIds", build: (db) => gymsByIds(db, "u", IDS), scanOk: JSON_ROWS },
  {
    name: "training.listWorkouts",
    build: (db) => listWorkouts(db, "u", { limit: 30, before: 1, discipline: "run", start: "a", end: "b" }),
  },
  { name: "training.listSets", build: (db) => listSets(db, "u", { limit: 30 }) },
  { name: "training.changes", build: (db) => changes(db, "u", 0, 200) },
  { name: "training.changeSets", build: (db) => changeSets(db, "u", 0, 200) },
  { name: "training.maxSeq", build: (db) => maxSeq(db, "u") },
  { name: "training.oneWorkout", build: (db) => oneWorkout(db, "u", "w") },
  { name: "training.oneWorkoutSets", build: (db) => oneWorkoutSets(db, "u", "w") },
  { name: "training.bumpSeq", build: (db) => bumpSeq(db, 2) },
  {
    name: "training.upsertWorkouts",
    build: (db) => upsertWorkouts(db, [ROW], 1)[0] ?? sql`SELECT 1`,
    scanOk: JSON_ROWS,
  },
  { name: "training.insertSets", build: (db) => insertSets(db, [ROW])[0] ?? sql``, scanOk: JSON_ROWS },
  { name: "training.deleteSetsOf", build: (db) => deleteSetsOf(db, "u", IDS), scanOk: JSON_ROWS },
  {
    name: "training.unchangedSince",
    build: () => sql`SELECT ${unchangedSince({ a: 1 }, IDS)}`,
    scanOk: JSON_ROWS,
  },
  { name: "training.insertTrash", build: (db) => insertTrash(db, [ROW])[0] ?? sql``, scanOk: JSON_ROWS },
  { name: "training.deleteTrash", build: (db) => deleteTrash(db, "u", "workout", IDS), scanOk: JSON_ROWS },
  { name: "training.deleteEventsOf", build: (db) => deleteEventsOf(db, IDS), scanOk: JSON_ROWS },
  { name: "training.upsertEvents", build: (db) => upsertEvents(db, [ROW])[0] ?? sql``, scanOk: JSON_ROWS },
  { name: "training.touchRoutines", build: (db) => touchRoutines(db, "u", IDS, 1), scanOk: JSON_ROWS },
  { name: "training.workoutsBetween", build: (db) => workoutsBetween(db, "u", 1, 2) },
  { name: "training.allCustoms", build: (db) => allCustoms(db, "u") },
  { name: "training.insertCustoms", build: (db) => insertCustoms(db, [ROW])[0] ?? sql``, scanOk: JSON_ROWS },
  {
    name: "training.lastSets",
    build: (db) => lastSets(db, "u", ["bench-press"]),
    scanOk: "window over the caller's sets of at most 40 exercises (user_id, exercise_id index)",
  },
  {
    name: "training.historySets",
    build: (db) => historySets(db, "u", "bench-press", 30),
    scanOk: "scans the CTE of at most `limit` picked workouts",
  },
  { name: "training.exerciseRecords", build: (db) => exerciseRecords(db, "u", "bench-press") },
  { name: "training.listCustoms", build: (db) => listCustoms(db, "u") },
  { name: "training.countCustoms", build: (db) => countCustoms(db, "u") },
  { name: "training.customById", build: (db) => customById(db, "u", "c") },
  { name: "training.customUsed", build: (db) => customUsed(db, "u", "custom-x") },
  { name: "training.listRoutines", build: (db) => listRoutines(db, "u") },
  { name: "training.countRoutines", build: (db) => countRoutines(db, "u") },
  { name: "training.routineById", build: (db) => routineById(db, "u", "r") },
  { name: "training.routinesByIds", build: (db) => routinesByIds(db, "u", IDS), scanOk: JSON_ROWS },
  { name: "training.routineNames", build: (db) => routineNames(db, "u") },
  { name: "training.metricsSince", build: (db) => metricsSince(db, "u", "2026-01-01") },
  { name: "training.weighInsSince", build: (db) => weighInsSince(db, "u", "2026-01-01") },
  { name: "training.weighInOwner", build: (db) => weighInOwner(db, "w") },
  { name: "training.photos", build: (db) => photos(db, "u") },
  { name: "training.photoById", build: (db) => photoById(db, "p") },
  { name: "training.countPhotos", build: (db) => countPhotos(db, "u") },
  { name: "training.deleteAllPhotos", build: (db) => deleteAllPhotos(db, "u") },
  { name: "training.dropPhotoIfBackupOff", build: (db) => dropPhotoIfBackupOff(db, "u", "p") },
  { name: "training.liveChains", build: (db) => liveChains(db, "u") },
  { name: "training.pauseById", build: (db) => pauseById(db, "p") },
  { name: "training.listGear", build: (db) => listGear(db, "u") },
  { name: "training.gearUsage", build: (db) => gearUsage(db, "u") },
  { name: "training.listGyms", build: (db) => listGyms(db, "u") },
  { name: "training.clearOtherDefaults", build: (db) => clearOtherDefaults(db, "u", "g", 1) },
  { name: "training.notes", build: (db) => notes(db, "u") },
  { name: "training.goal", build: (db) => goal(db, "u") },
  { name: "training.weighInAverage", build: (db) => weighInAverage(db, "u", "2026-01-01") },
  { name: "training.liveBlocks", build: (db) => liveBlocks(db, "u") },
  { name: "training.blockById", build: (db) => blockById(db, "b") },
  { name: "training.readinessSince", build: (db) => readinessSince(db, "u", "2026-01-01") },
  { name: "training.reflections", build: (db) => reflections(db, "u") },
  { name: "training.monthGoal", build: (db) => monthGoal(db, "u", "2026-01") },
  { name: "training.activeDays", build: (db) => activeDays(db, "u", "2026-01-01", "2026-01-31") },
  { name: "training.restDaysSince", build: (db) => restDaysSince(db, "u", "2026-01-01") },
  { name: "training.listPlans", build: (db) => listPlans(db, "u") },
  { name: "training.countPlans", build: (db) => countPlans(db, "u") },
  { name: "training.activePlan", build: (db) => activePlan(db, "u") },
  { name: "training.planById", build: (db) => planById(db, "p") },
  { name: "training.stopOtherPlans", build: (db) => stopOtherPlans(db, "u", "p", 1) },
  { name: "training.logged", build: (db) => logged(db, "u", "2026-01-01", "2026-01-31", true) },
];

/** Raw statements (`db.all`, `db.run`) are planned through their SQL. */
export const explain: ExplainCase[] = cases.map((c) => ({
  ...c,
  build: (db: Db) => {
    const b = c.build(db);
    return "toSQL" in b ? b : b.getSQL();
  },
}));
