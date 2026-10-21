/**
 * Workouts: the sync write path (PUT, DELETE, the outbox batch), the reads (list, one, changes feed) and exercise
 * history (spec/training-a.md §1.2-§1.3).
 *
 * Write path, one shape for all three routes:
 * 1. Read (one round trip): the caller, their profile, every touched row by id (anyone's: a foreign id must 404),
 *    those rows' sets, and the custom exercises, gear and gyms the bodies name.
 * 2. Plan in memory, op by op, exactly as Python applied them one after another: validation, ownership, LWW on
 *    `client_updated_at`, trash and feed bookkeeping. Ops on the same id see each other's effects.
 * 3. One atomic batch (round trip 2): the per-user rate counter and its guard, a guard that every row read is
 *    unchanged (optimistic concurrency; a lost race re-reads), one `sync_seq` bump for all applied ops, the final
 *    rows as one JSON upsert, set replacement, trash, feed events, routine use, the aggregate refresh for the old
 *    and new dates and exercises, and then the snapshot reads of the recompute (`BeforeRead`), which see all of it.
 * 4. The recompute's own write (round trip 3).
 * An op that changes nothing never writes: an outbox retry costs one round trip.
 */
import { CUSTOM_PREFIX, DISCIPLINE_BY_ID, EXERCISE_BY_ID } from "../../catalog/exercises.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, rateLimitGuard, type Stmt } from "../../db/batch.ts";
import type { workoutSets, workouts } from "../../db/schema/index.ts";
import { HttpError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { localParts, toWire, zone } from "../../lib/time.ts";
import { UUID_RE, uuid7 } from "../../lib/uuid7.ts";
import { e1rm, type Outcome, publicOutcome, recompute, statRefresh } from "../game/service.ts";
import * as repo from "./repo.ts";
import type { BatchInput, SetInput, WorkoutInput } from "./schemas.ts";

export type WorkoutRow = typeof workouts.$inferSelect;
export type SetRow = typeof workoutSets.$inferSelect;
export type ProfileRow = Awaited<ReturnType<typeof repo.profile>>[number];

/** Python `get_profile` creates a default profile; reads here fall back to the same defaults instead. */
export const DEFAULT_PROFILE: ProfileRow = {
  timezone: "UTC",
  weekStartsOn: 0,
  weightUnit: "kg",
  maxHr: null,
  birthYear: null,
  visibility: "followers",
  sharingPaused: false,
  socialSuspendedAt: null,
  deletionScheduledAt: null,
  onboardedAt: null,
  photoBackup: false,
};

export const profileOf = (rows: readonly ProfileRow[]): ProfileRow => {
  const p = rows[0] ?? DEFAULT_PROFILE;
  return { ...p, timezone: zone(p.timezone) };
};

/** How far back the app may log a session; older history comes in through import. */
export const MAX_BACKDATE_DAYS = 30;
export const FUTURE_TOLERANCE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const TRASH_DAYS = 30;
const SOCIAL_MIN_AGE = 16;
const ATTEMPTS = 3;

// ---- output ---------------------------------------------------------------------------------------------------

export function setOut(s: SetRow) {
  return {
    exercise_id: s.exerciseId,
    position: s.position,
    set_index: s.setIndex,
    superset: s.superset,
    kind: s.kind,
    weight_kg: s.weightKg,
    reps: s.reps,
    rpe: s.rpe,
    duration_sec: s.durationSec,
    distance_m: s.distanceM,
    completed: s.completed,
  };
}

const bySetOrder = (a: SetRow, b: SetRow) => a.position - b.position || a.setIndex - b.setIndex;

/** Python `WorkoutOut`. Sets in (position, set_index) order. */
export function workoutOut(w: WorkoutRow, sets: readonly SetRow[]) {
  return {
    id: w.id,
    discipline: w.discipline,
    title: w.title,
    notes: w.notes,
    started_at: toWire(w.startedAt),
    local_date: w.localDate,
    duration_sec: w.durationSec,
    distance_m: w.distanceM,
    elevation_m: w.elevationM,
    effort: w.effort,
    feel: w.feel,
    routine_id: w.routineId,
    tags: w.tags,
    gear_id: w.gearId,
    gym_id: w.gymId,
    soreness: w.soreness,
    pump: w.pump,
    avg_hr: w.avgHr,
    max_hr: w.maxHr,
    hr_zones: w.hrZones,
    splits: w.splits,
    source: w.source,
    client_updated_at: toWire(w.clientUpdatedAt),
    deleted_at: toWire(w.deletedAt),
    seq: w.seq,
    sets: [...sets].sort(bySetOrder).map(setOut),
  };
}
export type WorkoutOut = ReturnType<typeof workoutOut>;

export function groupSets(rows: readonly SetRow[]): Map<string, SetRow[]> {
  const out = new Map<string, SetRow[]>();
  for (const s of rows) {
    const list = out.get(s.workoutId);
    if (list === undefined) out.set(s.workoutId, [s]);
    else list.push(s);
  }
  return out;
}

/** Python `str.title()`: upper-case every letter that follows a non-letter, lower-case the rest. */
export function pyTitle(s: string): string {
  let out = "";
  let prev = false;
  for (const ch of s) {
    const letter = ch.toLowerCase() !== ch.toUpperCase();
    out += letter ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prev = letter;
  }
  return out;
}

/** Python `Profile.social_allowed(year)` plus the emit_event visibility rule. */
export function feedVisible(p: ProfileRow, now: number): boolean {
  const year = new Date(now).getUTCFullYear();
  return (
    p.visibility !== "private" &&
    !p.sharingPaused &&
    p.birthYear !== null &&
    year - p.birthYear >= SOCIAL_MIN_AGE &&
    p.socialSuspendedAt === null &&
    p.deletionScheduledAt === null &&
    p.onboardedAt !== null
  );
}

// ---- planning -------------------------------------------------------------------------------------------------

type Op = { op: "put"; id: string; body: WorkoutInput | null } | { op: "delete"; id: string; at: number };

interface Cur {
  /** Null while absent. */
  row: WorkoutRow | null;
  sets: SetRow[];
  foreign: boolean;
  /** The offset (1..n) into the batch's seq bump of the last applied op, or null when untouched. */
  offset: number | null;
  /** True when the read saw the row deleted (or absent). */
  wasLive: boolean;
  revived: boolean;
  newlyDeleted: boolean;
  putApplied: boolean;
}

export type OpResult =
  | { id: string; ok: true; applied: boolean; created: boolean; workout: () => WorkoutOut }
  | { id: string; ok: true; applied: boolean }
  | { id: string; ok: false; status: HttpError["status"]; detail: unknown };

interface Loaded {
  profile: ProfileRow;
  state: Map<string, Cur>;
  customs: Map<string, string>;
  gearOk: Set<string>;
  gymOk: Set<string>;
  /** Exercise ids and dates the read rows had, for the aggregate scope. */
  oldExercises: Set<string>;
  oldDates: Set<string>;
  oldDisciplines: Set<string>;
  /** `id -> seq` of the caller's rows the read saw, and the ids it saw absent. */
  present: Record<string, number>;
  absent: string[];
}

function customIdsOf(ops: readonly Op[]): string[] {
  const ids = new Set<string>();
  let bad = false;
  for (const o of ops) {
    if (o.op !== "put" || o.body === null) continue;
    for (const s of o.body.sets) {
      if (!s.exercise_id.startsWith(CUSTOM_PREFIX)) continue;
      const raw = s.exercise_id.slice(CUSTOM_PREFIX.length);
      if (UUID_RE.test(raw.toLowerCase())) ids.add(raw.toLowerCase());
      else bad = true;
    }
  }
  // Python: one unparseable custom id made `UUID(...)` raise, and then no custom id counted as known.
  return bad ? [] : [...ids];
}

async function load(ctx: Ctx, authed: AuthedBatch, ops: readonly Op[]): Promise<Loaded> {
  const db = ctx.db;
  const ids = [...new Set(ops.map((o) => o.id))];
  const gearIds = new Set<string>();
  const gymIds = new Set<string>();
  for (const o of ops) {
    if (o.op !== "put" || o.body === null) continue;
    if (o.body.gear_id !== null) gearIds.add(o.body.gear_id);
    if (o.body.gym_id !== null) gymIds.add(o.body.gym_id);
  }
  const uid = authed.userId;
  const [, prof, rows, sets, customs, gearRows, gymRows] = await authed.read(
    repo.profile(db, uid),
    repo.workoutsByIds(db, ids),
    repo.setsOf(db, uid, ids),
    repo.customsByIds(db, uid, customIdsOf(ops)),
    repo.gearByIds(db, uid, [...gearIds]),
    repo.gymsByIds(db, uid, [...gymIds]),
  );
  const setsBy = groupSets(sets);
  const state = new Map<string, Cur>();
  const out: Loaded = {
    profile: profileOf(prof),
    state,
    customs: new Map(customs.map((c) => [`${CUSTOM_PREFIX}${c.id}`, c.name])),
    gearOk: new Set(gearRows.map((g) => g.id)),
    gymOk: new Set(gymRows.map((g) => g.id)),
    oldExercises: new Set(),
    oldDates: new Set(),
    oldDisciplines: new Set(),
    present: {},
    absent: [],
  };
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id) ?? null;
    const foreign = row !== null && row.userId !== uid;
    const mine = row !== null && !foreign ? row : null;
    const mySets = mine === null ? [] : (setsBy.get(id) ?? []);
    state.set(id, {
      row: mine,
      sets: mySets,
      foreign,
      offset: null,
      wasLive: mine !== null && mine.deletedAt === null,
      revived: false,
      newlyDeleted: false,
      putApplied: false,
    });
    if (mine !== null) {
      out.present[id] = mine.seq;
      out.oldDates.add(mine.localDate);
      out.oldDisciplines.add(mine.discipline);
      for (const s of mySets) out.oldExercises.add(s.exerciseId);
    } else if (!foreign) {
      out.absent.push(id);
    }
  }
  return out;
}

function putError(ctx: Ctx, l: Loaded, body: WorkoutInput): HttpError | null {
  const now = ctx.clock.now();
  if (body.started_at > now + FUTURE_TOLERANCE_MS) return new HttpError(422, "Session starts in the future");
  if (body.started_at < now - MAX_BACKDATE_DAYS * DAY_MS)
    return new HttpError(422, `Sessions older than ${MAX_BACKDATE_DAYS} days go through import`);
  const unknown = [...new Set(body.sets.map((s) => s.exercise_id))]
    .filter((e) => !EXERCISE_BY_ID.has(e) && !l.customs.has(e))
    .sort();
  if (unknown.length > 0) return new HttpError(422, `Unknown exercise: ${unknown[0]}`);
  return null;
}

function newSets(ctx: Ctx, userId: string, workoutId: string, sets: readonly SetInput[]): SetRow[] {
  const now = ctx.clock.now();
  return sets.map((s) => ({
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    workoutId,
    userId,
    exerciseId: s.exercise_id,
    position: s.position,
    setIndex: s.set_index,
    superset: s.superset,
    kind: s.kind,
    weightKg: s.weight_kg,
    reps: s.reps,
    rpe: s.rpe,
    durationSec: s.duration_sec,
    distanceM: s.distance_m,
    completed: s.completed,
  }));
}

interface Planned {
  results: OpResult[];
  /** Applied ops in order; offsets 1..n. */
  applied: number;
  lastPut: string | null;
  puts: number;
}

/** Applies the ops to the in-memory state, in order, as Python's per-op savepoints did. */
function plan(ctx: Ctx, authed: AuthedBatch, l: Loaded, ops: readonly Op[], seqOf: () => number): Planned {
  const now = ctx.clock.now();
  const out: Planned = { results: [], applied: 0, lastPut: null, puts: 0 };
  for (const o of ops) {
    const cur = l.state.get(o.id);
    if (cur === undefined) throw new Error("op id missing from the read");
    if (o.op === "delete") {
      const row = cur.row;
      if (row === null || cur.foreign || row.clientUpdatedAt > o.at) {
        out.results.push({ id: o.id, ok: true, applied: false });
        continue;
      }
      if (row.deletedAt === null) cur.newlyDeleted = true;
      cur.row = { ...row, deletedAt: now, clientUpdatedAt: o.at, updatedAt: now };
      cur.offset = ++out.applied;
      out.results.push({ id: o.id, ok: true, applied: true });
      continue;
    }
    const body = o.body;
    if (body === null) {
      out.results.push({ id: o.id, ok: false, status: 422, detail: "put needs a workout" });
      continue;
    }
    const err = putError(ctx, l, body) ?? (cur.foreign ? notFound("Not found") : null);
    if (err !== null) {
      out.results.push({
        id: o.id,
        ok: false,
        status: err.status,
        detail: "detail" in err.body ? err.body.detail : err.message,
      });
      continue;
    }
    const before = cur.row;
    if (before !== null && before.clientUpdatedAt >= body.client_updated_at) {
      // An older edit arriving late (an offline queue flushing after a newer change): keep the newer one.
      const snap = { row: before, sets: cur.sets, offset: cur.offset };
      out.results.push({
        id: o.id,
        ok: true,
        applied: false,
        created: false,
        workout: () =>
          workoutOut(
            { ...snap.row, seq: snap.offset === null ? snap.row.seq : seqOf() + snap.offset },
            snap.sets,
          ),
      });
      continue;
    }
    if (before !== null && before.deletedAt !== null) cur.revived = true;
    const local = localParts(body.started_at, l.profile.timezone);
    const row: WorkoutRow = {
      id: o.id,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      userId: authed.userId,
      discipline: body.discipline,
      title: body.title,
      notes: body.notes,
      startedAt: body.started_at,
      localDate: local.date,
      localHour: local.hour,
      durationSec: body.duration_sec,
      distanceM: body.distance_m,
      elevationM: body.elevation_m,
      effort: body.effort,
      feel: body.feel,
      soreness: body.soreness,
      pump: body.pump,
      avgHr: body.avg_hr,
      maxHr: body.max_hr,
      hrZones: body.hr_zones.map((z) => Math.max(0, Math.trunc(z))).slice(0, 5),
      routineId: body.routine_id,
      tags: body.tags,
      splits: body.splits.map((s) => ({ m: s.m, sec: s.sec })),
      gearId: body.gear_id !== null && l.gearOk.has(body.gear_id) ? body.gear_id : null,
      gymId: body.gym_id !== null && l.gymOk.has(body.gym_id) ? body.gym_id : null,
      // An imported row edited in the app stays "import".
      source: before?.source ?? "app",
      clientUpdatedAt: body.client_updated_at,
      deletedAt: null,
      seq: 0,
    };
    const sets = newSets(ctx, authed.userId, o.id, body.sets);
    cur.row = row;
    cur.sets = sets;
    cur.putApplied = true;
    const offset = ++out.applied;
    cur.offset = offset;
    out.puts++;
    out.lastPut = o.id;
    out.results.push({
      id: o.id,
      ok: true,
      applied: true,
      created: before === null,
      workout: () => workoutOut({ ...row, seq: seqOf() + offset }, sets),
    });
  }
  return out;
}

const rowJson = (w: WorkoutRow, offset: number) => ({
  id: w.id,
  created_at: w.createdAt,
  updated_at: w.updatedAt,
  user_id: w.userId,
  discipline: w.discipline,
  title: w.title,
  notes: w.notes,
  started_at: w.startedAt,
  local_date: w.localDate,
  local_hour: w.localHour,
  duration_sec: w.durationSec,
  distance_m: w.distanceM,
  elevation_m: w.elevationM,
  effort: w.effort,
  feel: w.feel,
  soreness: w.soreness,
  pump: w.pump,
  avg_hr: w.avgHr,
  max_hr: w.maxHr,
  hr_zones: w.hrZones,
  routine_id: w.routineId,
  tags: w.tags,
  splits: w.splits,
  gear_id: w.gearId,
  gym_id: w.gymId,
  source: w.source,
  client_updated_at: w.clientUpdatedAt,
  deleted_at: w.deletedAt,
  seq: offset,
});

export const setJson = (s: SetRow) => ({
  id: s.id,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
  workout_id: s.workoutId,
  user_id: s.userId,
  exercise_id: s.exerciseId,
  position: s.position,
  set_index: s.setIndex,
  superset: s.superset,
  kind: s.kind,
  weight_kg: s.weightKg,
  reps: s.reps,
  rpe: s.rpe,
  duration_sec: s.durationSec,
  distance_m: s.distanceM,
  completed: s.completed,
});

/** Feed event data (Python `_workout_event_data`): the session's shape, never set-level detail. */
function eventData(w: WorkoutRow, sets: readonly SetRow[], names: ReadonlyMap<string, string>) {
  const exercises: string[] = [];
  for (const s of [...sets].sort(bySetOrder)) {
    if (s.kind !== "warmup" && !exercises.includes(s.exerciseId)) exercises.push(s.exerciseId);
  }
  return {
    discipline: w.discipline,
    verb: DISCIPLINE_BY_ID.get(w.discipline)?.verb ?? "Trained",
    title: w.title,
    duration_sec: w.durationSec,
    distance_m: w.distanceM,
    elevation_m: w.elevationM,
    set_count: sets.filter((s) => s.completed && s.kind !== "warmup").length,
    exercises: exercises.slice(0, 4).map((e) => EXERCISE_BY_ID.get(e)?.name ?? names.get(e) ?? e),
    exercise_count: exercises.length,
    feel: w.feel,
  };
}

interface WriteResult {
  results: OpResult[];
  outcome: Outcome | null;
}

/**
 * Runs `ops` for the caller: read, plan, one write batch carrying the recompute's reads, the recompute's write.
 * `rateLimited` adds the `workout-write` counter (PUT and batch; DELETE has none in Python).
 */
async function run(
  ctx: Ctx,
  authed: AuthedBatch,
  ops: readonly Op[],
  opts: { rateLimited: boolean; notify: boolean },
): Promise<WriteResult> {
  for (let attempt = 1; ; attempt++) {
    const l = await load(ctx, authed, ops);
    let base = 0;
    const p = plan(ctx, authed, l, ops, () => base);
    if (p.applied === 0) return { results: p.results, outcome: null };
    const db = ctx.db;
    const now = ctx.clock.now();
    const uid = authed.userId;
    const stmts: Stmt[] = [];
    if (opts.rateLimited) {
      const limit = perUser(db, BUCKETS.workoutWrite, uid, now);
      stmts.push(limit.counter, db.run(rateLimitGuard(limit.key, BUCKETS.workoutWrite.limit)));
    }
    stmts.push(abortUnless(db, repo.unchangedSince(l.present, l.absent)));
    const bumpAt = stmts.length;
    stmts.push(repo.bumpSeq(db, p.applied));
    const written = [...l.state.values()].filter((c) => c.offset !== null && c.row !== null);
    stmts.push(
      ...repo.upsertWorkouts(
        db,
        written.map((c) => rowJson(c.row as WorkoutRow, c.offset ?? 0)),
        p.applied,
      ),
    );
    const putIds = written.filter((c) => c.putApplied).map((c) => (c.row as WorkoutRow).id);
    if (putIds.length > 0) {
      stmts.push(repo.deleteSetsOf(db, uid, putIds));
      const sets = written.filter((c) => c.putApplied).flatMap((c) => c.sets.map(setJson));
      stmts.push(...repo.insertSets(db, sets));
    }
    const finalDeleted = written.filter((c) => (c.row as WorkoutRow).deletedAt !== null);
    const finalLive = written.filter((c) => (c.row as WorkoutRow).deletedAt === null);
    // Trash: a revive clears the entry; a delete that took a live row adds one (after clearing any older one).
    const clearTrash = written
      .filter((c) => c.revived || c.newlyDeleted)
      .map((c) => (c.row as WorkoutRow).id);
    if (clearTrash.length > 0) stmts.push(repo.deleteTrash(db, uid, "workout", clearTrash));
    const trashRows = finalDeleted
      .filter((c) => c.newlyDeleted)
      .map((c) => {
        const w = c.row as WorkoutRow;
        return {
          id: uuid7(now),
          created_at: now,
          updated_at: now,
          user_id: uid,
          kind: "workout",
          item_id: w.id,
          label: `${w.title || pyTitle(w.discipline)}, ${w.localDate}`.slice(0, 160),
          payload: { row: null, children: {} },
          deleted_at: now,
          purge_after: now + TRASH_DAYS * DAY_MS,
        };
      });
    stmts.push(...repo.insertTrash(db, trashRows));
    const deletedIds = finalDeleted.map((c) => (c.row as WorkoutRow).id);
    if (deletedIds.length > 0) stmts.push(repo.deleteEventsOf(db, deletedIds));
    // The feed hears about every saved session that is still live (Python also posted one deleted later in the
    // same batch).
    if (feedVisible(l.profile, now)) {
      const events = finalLive
        .filter((c) => c.putApplied)
        .map((c) => {
          const w = c.row as WorkoutRow;
          return {
            id: uuid7(now),
            created_at: now,
            updated_at: now,
            user_id: uid,
            kind: "workout",
            ref_key: w.id,
            data: eventData(w, c.sets, l.customs),
            occurred_on: w.localDate,
            workout_id: w.id,
          };
        });
      stmts.push(...repo.upsertEvents(db, events));
    }
    const routineIds = [
      ...new Set(ops.flatMap((o) => (o.op === "put" && o.body?.routine_id ? [o.body.routine_id] : []))),
    ].filter((r) => written.some((c) => c.putApplied && (c.row as WorkoutRow).routineId === r));
    if (routineIds.length > 0) stmts.push(repo.touchRoutines(db, uid, routineIds, now));
    const dates = new Set(l.oldDates);
    const exercises = new Set(l.oldExercises);
    const disciplines = new Set(l.oldDisciplines);
    for (const c of written) {
      const w = c.row as WorkoutRow;
      dates.add(w.localDate);
      disciplines.add(w.discipline);
      for (const s of c.sets) exercises.add(s.exerciseId);
    }
    stmts.push(...statRefresh(ctx, uid, { dates: [...dates], exercises: [...exercises] }));

    let before: readonly unknown[] = [];
    try {
      const res = await recompute(
        ctx,
        uid,
        {
          notify: opts.notify,
          workoutId: p.puts === 1 ? p.lastPut : null,
          scope: { exercises: [...exercises], disciplines: [...disciplines] },
        },
        {
          authed,
          before: {
            stmts: stmts as [Stmt, ...Stmt[]],
            done: (r) => {
              before = r;
            },
          },
        },
      );
      const bumped = (before[bumpAt] ?? []) as { value: number }[];
      base = (bumped[0]?.value ?? p.applied) - p.applied;
      return { results: p.results, outcome: publicOutcome(res) };
    } catch (err) {
      // Another writer touched one of these rows between the read and the write: read again.
      if (isCondAbort(err) && attempt < ATTEMPTS) continue;
      throw err;
    }
  }
}

function single(r: OpResult) {
  if (!r.ok) throw new HttpError(r.status, r.detail);
  return r;
}

/** PUT /v1/workouts/{id}. */
export async function putWorkout(ctx: Ctx, authed: AuthedBatch, id: string, body: WorkoutInput) {
  const { results, outcome } = await run(ctx, authed, [{ op: "put", id, body }], {
    rateLimited: true,
    notify: true,
  });
  const r = single(results[0] as OpResult);
  if (!("workout" in r)) throw new Error("put result without a workout");
  return { workout: r.workout(), created: r.created, applied: r.applied, outcome };
}

/** DELETE /v1/workouts/{id}: never 404s; someone else's or a missing id is just not applied. */
export async function deleteWorkout(ctx: Ctx, authed: AuthedBatch, id: string, at: number | undefined) {
  const { results, outcome } = await run(ctx, authed, [{ op: "delete", id, at: at ?? ctx.clock.now() }], {
    rateLimited: false,
    notify: false,
  });
  const r = single(results[0] as OpResult);
  return { applied: r.applied, outcome };
}

/** POST /v1/workouts/batch: every op succeeds or fails on its own; one write, one recompute. */
export async function batch(ctx: Ctx, authed: AuthedBatch, body: BatchInput) {
  const ops: Op[] = body.ops.map((o) =>
    o.op === "put"
      ? { op: "put", id: o.id, body: o.workout }
      : { op: "delete", id: o.id, at: o.client_updated_at },
  );
  const { results, outcome } = await run(ctx, authed, ops, { rateLimited: true, notify: true });
  return {
    results: results.map((r) => ("workout" in r ? { ...r, workout: r.workout() } : r)),
    outcome,
  };
}

// ---- reads ----------------------------------------------------------------------------------------------------

export async function list(ctx: Ctx, authed: AuthedBatch, f: repo.ListFilter) {
  const [, rows, sets] = await authed.read(
    repo.listWorkouts(ctx.db, authed.userId, f),
    repo.listSets(ctx.db, authed.userId, f),
  );
  const by = groupSets(sets);
  return rows.map((w) => workoutOut(w, by.get(w.id) ?? []));
}

export async function getOne(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows, sets] = await authed.read(
    repo.oneWorkout(ctx.db, authed.userId, id),
    repo.oneWorkoutSets(ctx.db, authed.userId, id),
  );
  const w = rows[0];
  if (w === undefined) throw notFound("Not found");
  return workoutOut(w, sets);
}

/**
 * GET /v1/workouts/changes: one round trip. The weak ETag is the caller, the page and the newest `seq` they own,
 * so an unchanged feed answers 304 without serialising anything.
 */
export async function changes(ctx: Ctx, authed: AuthedBatch, since: number, limit: number) {
  const uid = authed.userId;
  const [, top, rows, sets] = await authed.read(
    repo.maxSeq(ctx.db, uid),
    repo.changes(ctx.db, uid, since, limit),
    repo.changeSets(ctx.db, uid, since, limit),
  );
  const etag = `W/"wc.${uid}.${since}.${limit}.${top[0]?.seq ?? 0}"`;
  return {
    etag,
    body: () => {
      const by = groupSets(sets);
      const page = rows.slice(0, limit);
      return {
        workouts: page.map((w) => workoutOut(w, by.get(w.id) ?? [])),
        cursor: page.length > 0 ? (page[page.length - 1] as WorkoutRow).seq : since,
        more: rows.length > limit,
      };
    },
  };
}

// ---- exercise history -----------------------------------------------------------------------------------------

/** GET /v1/exercises/last: one statement for all ids (Python ran two queries per id). */
export async function last(ctx: Ctx, authed: AuthedBatch, ids: string) {
  const wanted = ids
    .split(",")
    .filter((i) => i !== "")
    .slice(0, 40);
  const [, rows] = await authed.read(repo.lastSets(ctx.db, authed.userId, wanted));
  const out: Record<string, { date: string; sets: unknown[] }> = {};
  for (const id of wanted) {
    const mine = rows.filter((r) => r.ex === id);
    const first = mine[0];
    if (first === undefined) continue;
    out[id] = {
      date: first.d,
      sets: mine.map((r) => ({
        kind: r.kind,
        weight_kg: r.weight_kg,
        reps: r.reps,
        rpe: r.rpe,
        duration_sec: r.duration_sec,
      })),
    };
  }
  return out;
}

export async function history(ctx: Ctx, authed: AuthedBatch, exerciseId: string, limit: number) {
  const [, rows, records] = await authed.read(
    repo.historySets(ctx.db, authed.userId, exerciseId, limit),
    repo.exerciseRecords(ctx.db, authed.userId, exerciseId),
  );
  const sessions = new Map<
    string,
    {
      workout_id: string;
      date: string;
      sets: unknown[];
      best_e1rm: number;
      volume_kg: number;
      top_weight_kg: number;
    }
  >();
  for (const s of rows) {
    let e = sessions.get(s.wid);
    if (e === undefined) {
      e = { workout_id: s.wid, date: s.d, sets: [], best_e1rm: 0, volume_kg: 0, top_weight_kg: 0 };
      sessions.set(s.wid, e);
    }
    e.sets.push({
      kind: s.kind,
      weight_kg: s.weight_kg,
      reps: s.reps,
      rpe: s.rpe,
      duration_sec: s.duration_sec,
    });
    if (s.kind !== "warmup" && s.weight_kg && s.reps) {
      e.volume_kg += s.weight_kg * s.reps;
      e.top_weight_kg = Math.max(e.top_weight_kg, s.weight_kg);
      e.best_e1rm = Math.max(e.best_e1rm, pyRound(e1rm(s.weight_kg, s.reps), 1));
    }
  }
  return {
    exercise_id: exerciseId,
    sessions: [...sessions.values()].slice(0, limit),
    records: records.map((r) => ({
      key: r.key,
      value: r.value,
      previous: r.previous,
      gain_pct: r.gainPct,
      date: r.achievedOn,
      current: r.isCurrent,
      flagged: r.flagged,
    })),
  };
}
