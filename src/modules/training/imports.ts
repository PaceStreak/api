/**
 * POST /v1/workouts/import (spec/training-a.md §2): GPX, FIT, CSV, and Strong/Hevy/FitNotes set exports.
 *
 * Inline on the Paid plan (the whole 15 MiB file is parsed in the request; DESIGN §13's queued path is for the Free
 * plan's CPU limit and is not needed). Three round trips whatever the file size: the caller, profile and rate
 * counter; the duplicate check (ids and the ±3 minute window, all sessions at once); one write of every imported
 * row as JSON. Imports never post to the feed and earn nothing, so the aggregates and records are rebuilt by a
 * queued full rebuild (`enqueueRebuild`) instead of an inline recompute.
 */
import { CUSTOM_PREFIX, DISCIPLINE_BY_ID, EXERCISES } from "../../catalog/exercises.ts";
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch, Stmt } from "../../db/batch.ts";
import { collectMultipart } from "../../heavy/multipart.ts";
import { conflict, HttpError } from "../../lib/errors.ts";
import { fold } from "../../lib/fold.ts";
import { pyRound } from "../../lib/format.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { localParts } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { enqueueRebuild } from "../game/service.ts";
import {
  check,
  ImportFormatError,
  MAX_BYTES,
  MAX_SESSIONS,
  type ParsedSession,
  parse,
  problemFor,
  zoneSeconds,
} from "./importers.ts";
import {
  guessPattern,
  isLiftingCsv,
  LiftingFormatError,
  type LiftingSession,
  matchExercise,
  parseLifting,
} from "./lifting.ts";
import * as repo from "./repo.ts";
import { profileOf, type setJson, type WorkoutRow } from "./workouts.ts";

const NAMESPACE = "6f1c2a52-6b8e-4c0e-9d7e-3a1f5b8c9e01";
const WINDOW_MS = 3 * 60_000;
const MAX_CUSTOMS = 300;

/** Python `started_at.astimezone(UTC).isoformat()`: microseconds only when non-zero. */
export function pyIsoUtc(ms: number): string {
  const frac = ((ms % 1000) + 1000) % 1000;
  return `${new Date(ms).toISOString().slice(0, 19)}${frac ? `.${String(frac).padStart(3, "0")}000` : ""}+00:00`;
}

/** RFC 4122 UUIDv5 (SHA-1), as Python's `uuid5`. */
export async function uuid5(namespace: string, name: string): Promise<string> {
  const ns = Uint8Array.from(namespace.replaceAll("-", "").match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const bytes = new Uint8Array([...ns, ...new TextEncoder().encode(name)]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(0, 16);
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const missingFile = () =>
  new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);

export async function importFile(ctx: Ctx, authed: AuthedBatch, req: Request) {
  const db = ctx.db;
  const uid = authed.userId;
  const now = ctx.clock.now();
  const limit = perUser(db, BUCKETS.importFile, uid, now);
  const [, counter, prof, customs] = await authed.read(
    limit.counter,
    repo.profile(db, uid),
    repo.allCustoms(db, uid),
  );
  limit.check(counter);
  const form = await collectMultipart(req.body, req.headers.get("Content-Type"), {
    maxFileBytes: MAX_BYTES,
    tooLarge: () => new HttpError(422, "That file is larger than 15 MB."),
  });
  const discipline = form.fields.get("discipline") ?? null;
  if (discipline !== null && !DISCIPLINE_BY_ID.has(discipline))
    throw new HttpError(422, "Unknown discipline");
  const file = form.files.get("file");
  if (file === undefined) throw missingFile();
  const p = profileOf(prof);
  const unit = form.fields.get("unit") ?? null;
  if (unit !== null && unit !== "kg" && unit !== "lb") throw new HttpError(422, "Unit is kg or lb");
  if (file.filename.toLowerCase().endsWith(".csv") && isLiftingCsv(file.bytes)) {
    let parsed: ReturnType<typeof parseLifting>;
    try {
      parsed = parseLifting(file.bytes, p.timezone, unit ?? p.weightUnit);
    } catch (err) {
      if (err instanceof LiftingFormatError) throw new HttpError(422, err.message);
      throw err;
    }
    if (parsed.sessions.length > MAX_SESSIONS)
      throw new HttpError(422, `One upload can hold at most ${MAX_SESSIONS} sessions.`);
    return importLifting(ctx, authed, p.timezone, parsed, customs);
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(file.filename, file.bytes, p.timezone, discipline);
  } catch (err) {
    if (err instanceof ImportFormatError) throw new HttpError(422, err.message);
    throw err;
  }
  const year = new Date(now).getUTCFullYear();
  const maxHr = p.maxHr || (p.birthYear ? 220 - (year - p.birthYear) : null);
  const problems = [...parsed.problems];
  const candidates: { s: ParsedSession; id: string }[] = [];
  for (const s of [...parsed.sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    const reason = check(s, now);
    if (reason !== null) {
      problems.push(problemFor(s, reason));
      continue;
    }
    candidates.push({ s, id: await uuid5(NAMESPACE, `${uid}:${s.discipline}:${pyIsoUtc(s.startedAt)}`) });
  }
  const res = await write(
    ctx,
    authed,
    p.timezone,
    candidates.map(({ s, id }) => ({
      id,
      startedAt: s.startedAt,
      anyDiscipline: true,
      fields: {
        discipline: s.discipline,
        title: s.title,
        notes: s.notes,
        durationSec: s.durationSec,
        distanceM: s.distanceM,
        elevationM: s.elevationM,
        effort: s.effort,
        feel: s.feel,
        splits: s.splits,
        avgHr: s.avgHr,
        maxHr: s.maxHr,
        hrZones: maxHr && s.hrSamples.length > 0 ? zoneSeconds(s.hrSamples, maxHr) : [],
      },
      sets: [],
    })),
    [],
  );
  return {
    format: parsed.format,
    found: parsed.sessions.length,
    imported: res.imported,
    duplicates: res.duplicates,
    problems: problems.slice(0, 50),
    more_problems: Math.max(0, problems.length - 50),
  };
}

interface Candidate {
  id: string;
  startedAt: number;
  /** Activity imports clash with any discipline; lifting imports only with strength. */
  anyDiscipline: boolean;
  fields: Partial<WorkoutRow> & { discipline: string };
  sets: Omit<ReturnType<typeof setJson>, "workout_id" | "id" | "created_at" | "updated_at" | "user_id">[];
}

/** Duplicate check and one write for every imported session; then a queued rebuild. */
async function write(
  ctx: Ctx,
  authed: AuthedBatch,
  tz: string,
  candidates: readonly Candidate[],
  pre: readonly Stmt[],
): Promise<{ imported: number; duplicates: number; sets: number; importedIds: Set<string> }> {
  const db = ctx.db;
  const uid = authed.userId;
  const now = ctx.clock.now();
  const out = { imported: 0, duplicates: 0, sets: 0, importedIds: new Set<string>() };
  if (candidates.length === 0) {
    if (pre.length > 0) await authed.write(...(pre as [Stmt, ...Stmt[]]));
    return out;
  }
  const times = candidates.map((c) => c.startedAt);
  const [, existing, window] = await authed.read(
    repo.workoutsByIds(
      db,
      candidates.map((c) => c.id),
    ),
    repo.workoutsBetween(db, uid, Math.min(...times) - WINDOW_MS, Math.max(...times) + WINDOW_MS),
  );
  const byId = new Map(existing.filter((w) => w.userId === uid).map((w) => [w.id, w]));
  const live = window.map((w) => ({ startedAt: w.startedAt, discipline: w.discipline }));
  const rows: Record<string, unknown>[] = [];
  const setRows: ReturnType<typeof setJson>[] = [];
  const revived: string[] = [];
  for (const c of candidates) {
    const old = byId.get(c.id);
    const clash = live.some(
      (w) =>
        (c.anyDiscipline || w.discipline === "strength") &&
        w.startedAt >= c.startedAt - WINDOW_MS &&
        w.startedAt <= c.startedAt + WINDOW_MS,
    );
    // Someone else's row under this id (only possible by a forged collision) is never touched.
    const foreign = existing.some((w) => w.id === c.id && w.userId !== uid);
    if (clash || foreign || (old !== undefined && old.deletedAt === null)) {
      out.duplicates++;
      continue;
    }
    const local = localParts(c.startedAt, tz);
    const w: WorkoutRow = {
      ...(old ?? {
        id: c.id,
        createdAt: now,
        userId: uid,
        title: null,
        notes: null,
        durationSec: null,
        distanceM: null,
        elevationM: null,
        effort: null,
        feel: null,
        soreness: null,
        pump: null,
        avgHr: null,
        maxHr: null,
        hrZones: [],
        routineId: null,
        tags: [],
        splits: [],
        gearId: null,
        gymId: null,
        seq: 0,
      }),
      ...c.fields,
      startedAt: c.startedAt,
      localDate: local.date,
      localHour: local.hour,
      source: "import",
      clientUpdatedAt: now,
      deletedAt: null,
      updatedAt: now,
    } as WorkoutRow;
    if (old !== undefined) revived.push(c.id);
    out.imported++;
    out.importedIds.add(c.id);
    live.push({ startedAt: c.startedAt, discipline: c.fields.discipline });
    rows.push({ ...rowOf(w), seq: out.imported });
    for (const s of c.sets) {
      setRows.push({
        ...s,
        id: uuid7(now),
        created_at: now,
        updated_at: now,
        workout_id: c.id,
        user_id: uid,
      });
      out.sets++;
    }
  }
  const stmts: Stmt[] = [...pre];
  if (rows.length > 0) {
    stmts.push(repo.bumpSeq(db, rows.length), ...repo.upsertWorkouts(db, rows, rows.length));
    if (revived.length > 0) stmts.push(repo.deleteSetsOf(db, uid, revived));
    stmts.push(...repo.insertSets(db, setRows));
  }
  if (stmts.length > 0) await authed.write(...(stmts as [Stmt, ...Stmt[]]));
  if (rows.length > 0) await enqueueRebuild(ctx, uid);
  return out;
}

const rowOf = (w: WorkoutRow) => ({
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
});

async function importLifting(
  ctx: Ctx,
  authed: AuthedBatch,
  tz: string,
  parsed: ReturnType<typeof parseLifting>,
  customs: readonly { id: string; name: string }[],
) {
  const now = ctx.clock.now();
  const uid = authed.userId;
  const byName = new Map(customs.map((c) => [c.name.trim().toLowerCase(), `${CUSTOM_PREFIX}${c.id}`]));
  const resolved = new Map<string, string>();
  const created: { id: string; name: string; pattern: string; equipment: string; primary: string[] }[] = [];
  const exerciseId = (name: string) => {
    const known = resolved.get(name);
    if (known !== undefined) return known;
    let found = matchExercise(name, EXERCISES) ?? byName.get(name.trim().toLowerCase().slice(0, 60)) ?? null;
    if (found === null) {
      if (customs.length + created.length >= MAX_CUSTOMS)
        throw conflict(`This file has more new exercises than your custom-exercise limit (${MAX_CUSTOMS}).`);
      const [pattern, equipment, primary] = guessPattern(name);
      const id = uuid7(now);
      created.push({ id, name: name.trim().slice(0, 60), pattern, equipment, primary });
      found = `${CUSTOM_PREFIX}${id}`;
      byName.set(name.trim().toLowerCase().slice(0, 60), found);
    }
    resolved.set(name, found);
    return found;
  };
  const problems = [...parsed.problems];
  const candidates: Candidate[] = [];
  // Python resolved names only for sessions that were not duplicates; resolving all of them here can create a
  // custom exercise for a name seen only in a duplicate session, so names are resolved after the check below.
  const sessions: { s: LiftingSession; id: string }[] = [];
  for (const s of parsed.sessions) {
    const year = Number(new Date(s.startedAt + s.offsetMin * 60_000).toISOString().slice(0, 4));
    if (s.startedAt > now + 10 * 60_000 || year < 1990) {
      problems.push(
        `Session on ${new Date(s.startedAt + s.offsetMin * 60_000).toISOString().slice(0, 10)} has an impossible date.`,
      );
      continue;
    }
    sessions.push({ s, id: await uuid5(NAMESPACE, `${uid}:strength:${pyIsoUtc(s.startedAt)}`) });
  }
  // Duplicate check first (one read), then names for the sessions that will be written.
  const db = ctx.db;
  let res = { imported: 0, duplicates: 0, sets: 0 };
  if (sessions.length > 0) {
    const times = sessions.map((x) => x.s.startedAt);
    const [, existing, window] = await authed.read(
      repo.workoutsByIds(
        db,
        sessions.map((x) => x.id),
      ),
      repo.workoutsBetween(db, uid, Math.min(...times) - WINDOW_MS, Math.max(...times) + WINDOW_MS),
    );
    const live = window.filter((w) => w.discipline === "strength").map((w) => w.startedAt);
    const byId = new Map(existing.map((w) => [w.id, w]));
    const fresh: typeof sessions = [];
    for (const x of sessions) {
      const old = byId.get(x.id);
      const clash = live.some((t) => t >= x.s.startedAt - WINDOW_MS && t <= x.s.startedAt + WINDOW_MS);
      if (clash || (old !== undefined && (old.deletedAt === null || old.userId !== uid))) continue;
      live.push(x.s.startedAt);
      fresh.push(x);
    }
    for (const { s, id } of fresh) {
      const positions = new Map<string, number>();
      candidates.push({
        id,
        startedAt: s.startedAt,
        anyDiscipline: false,
        fields: {
          discipline: "strength",
          title: s.title,
          notes: s.notes,
          durationSec: s.durationSec,
          distanceM: null,
          elevationM: null,
        },
        sets: s.sets.map((st) => {
          const ex = exerciseId(st.exercise);
          if (!positions.has(ex)) positions.set(ex, positions.size);
          return {
            exercise_id: ex,
            position: positions.get(ex) ?? 0,
            set_index: st.setIndex,
            superset: st.superset,
            kind: (["work", "warmup", "drop", "failure"].includes(st.kind) ? st.kind : "work") as "work",
            weight_kg: st.weightKg === null ? null : pyRound(st.weightKg, 3),
            reps: st.reps,
            rpe: st.rpe,
            duration_sec: st.durationSec,
            distance_m: st.distanceM,
            completed: true,
          };
        }),
      });
    }
    const pre = repo.insertCustoms(
      db,
      created.map((c) => ({
        id: c.id,
        created_at: now,
        updated_at: now,
        user_id: uid,
        name: c.name,
        name_fold: fold(c.name),
        pattern: c.pattern,
        equipment: c.equipment,
        primary: c.primary,
        secondary: [],
        load_type: "weight",
        rest_sec: 90,
        unilateral: false,
        cue: "Imported - edit it to set the muscles and cue.",
        archived: false,
      })),
    );
    const w = await write(ctx, authed, tz, candidates, pre);
    res = { imported: w.imported, duplicates: sessions.length - w.imported, sets: w.sets };
  }
  return {
    format: parsed.format,
    found: parsed.sessions.length,
    imported: res.imported,
    duplicates: res.duplicates,
    sets: res.sets,
    new_exercises: created.map((c) => c.name).slice(0, 50),
    problems: problems.slice(0, 50),
    more_problems: Math.max(0, problems.length - 50),
  };
}
