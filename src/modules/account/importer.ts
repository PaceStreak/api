/**
 * Account import planning (Python `import_data`, spec/account.md §2 "Import algorithm"): idempotent, fills gaps and
 * never overwrites. Pure: given the sections of an export, what the account already holds (`Existing`, read in one
 * batch) and the id maps carried between slices, it returns the rows to insert. The service turns the rows into
 * a few `json_each` bulk inserts, so even a large file is a handful of statements.
 *
 * Sections are planned in Python's order (custom exercises, gear and gyms first, because sessions refer to them).
 * A queued import runs two passes over the file: everything but `workouts` first, then `workouts` with the maps.
 */
import * as z from "zod";
import {
  CUSTOM_PREFIX,
  DISCIPLINE_IDS,
  EQUIPMENT,
  EXERCISE_BY_ID,
  LOAD_TYPES,
  MUSCLES,
  PATTERNS,
} from "../../catalog/exercises.ts";
import { HABIT_CATEGORIES } from "../../catalog/habit-templates.ts";
import { pyRound } from "../../lib/format.ts";
import { addDays, isIsoDate, localParts, parseInstant } from "../../lib/time.ts";
import { UUID_RE, uuid7 } from "../../lib/uuid7.ts";

export const EXPORT_FORMAT = "pacestreak-export";
export const MAX_IMPORT_WORKOUTS = 25_000;
const PAUSE_MAX_DAYS = 84;
const PAUSE_REASONS = new Set(["injury", "illness", "travel", "life", "other"]);

/** The order Python reads sections in; `workouts` needs the three maps built before it. */
export const SECTION_ORDER = [
  "custom_exercises",
  "gear",
  "gyms",
  "workouts",
  "pauses",
  "body_metrics",
  "weigh_ins",
  "exercise_notes",
  "weight_goal",
  "habits",
  "readiness",
  "reflections",
] as const;
export type Section = (typeof SECTION_ORDER)[number];
export const SECTIONS: ReadonlySet<string> = new Set(SECTION_ORDER);

// ---- validators (the Python request schemas the importer re-uses) ------------------------------------------

/** pydantic counts code points; zod's `.max()` counts UTF-16 units. */
const cpString = (min: number, max: number) =>
  z.string().refine((s) => {
    const n = Array.from(s).length;
    return n >= min && n <= max;
  });
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();

const SetIn = z.object({
  exercise_id: cpString(1, 80),
  position: z.int().min(0).max(200),
  set_index: z.int().min(0).max(100),
  superset: opt(z.int().min(0).max(50)),
  kind: z.enum(["work", "warmup", "drop", "failure"]).default("work"),
  weight_kg: opt(z.number().min(0).max(2000)),
  reps: opt(z.int().min(0).max(1000)),
  rpe: opt(z.number().min(1).max(10)),
  duration_sec: opt(z.int().min(0).max(86_400)),
  distance_m: opt(z.number().min(0).max(1_000_000)),
  completed: z.boolean().default(true),
});

const SplitIn = z.object({ m: z.int().min(1).max(1000), sec: z.int().min(0).max(86_400) });

const has = (o: Readonly<Record<string, unknown>> | readonly string[], k: string) =>
  Array.isArray(o) ? o.includes(k) : Object.hasOwn(o, k);

const CustomExerciseIn = z.object({
  name: cpString(1, 60),
  pattern: z.string().refine((v) => has(PATTERNS, v)),
  equipment: z.string().refine((v) => has(EQUIPMENT, v)),
  primary: z
    .array(z.string())
    .max(6)
    .default([])
    .refine((v) => v.every((m) => has(MUSCLES, m))),
  secondary: z
    .array(z.string())
    .max(6)
    .default([])
    .refine((v) => v.every((m) => has(MUSCLES, m))),
  load_type: z
    .string()
    .default("weight")
    .refine((v) => has(LOAD_TYPES, v)),
  rest_sec: z.int().min(0).max(900).default(90),
  unilateral: z.boolean().default(false),
  cue: opt(cpString(0, 200)),
});

const GearIn = z.object({
  name: cpString(1, 60),
  kind: z.enum(["shoes", "bike", "other"]).default("shoes"),
  default_for: z.array(z.string()).max(11).default([]),
  limit_km: opt(z.number().gt(0).max(100_000)),
  initial_km: z.number().min(0).max(100_000).default(0),
  note: opt(cpString(0, 200)),
});

const GymIn = z.object({
  name: cpString(1, 60),
  equipment: z
    .array(z.string())
    .max(20)
    .default([])
    .refine((v) => v.every((e) => has(EQUIPMENT, e))),
  plates_kg: z
    .array(z.number())
    .max(20)
    .default([])
    .refine((v) => v.every((p) => p > 0 && p <= 50)),
  bar_kg: z.number().min(0).max(50).default(20),
});

const cm = opt(z.number().gt(0).max(400));
export const METRIC_FIELDS = [
  "body_fat_pct",
  "resting_hr",
  "sleep_hours",
  "waist_cm",
  "neck_cm",
  "shoulders_cm",
  "chest_cm",
  "arm_cm",
  "forearm_cm",
  "hips_cm",
  "thigh_cm",
  "calf_cm",
  "note",
] as const;
const BodyMetricIn = z.object({
  body_fat_pct: opt(z.number().min(1).max(75)),
  waist_cm: cm,
  resting_hr: opt(z.int().min(20).max(250)),
  sleep_hours: opt(z.number().min(0).max(24)),
  note: opt(cpString(0, 200)),
  neck_cm: cm,
  shoulders_cm: cm,
  chest_cm: cm,
  arm_cm: cm,
  forearm_cm: cm,
  hips_cm: cm,
  thigh_cm: cm,
  calf_cm: cm,
});

const MOMENTS = ["waking", "pre_workout", "post_workout", "bedtime", "other"] as const;
const WeighInIn = z.object({
  weighed_at: z.string(),
  moment: z.enum(MOMENTS),
  weight_kg: z.number().gt(0).max(700),
  note: opt(cpString(0, 200)),
});

const WeightGoalIn = z.object({
  target_kg: z.number().gt(20).max(400),
  milestone_kg: z.number().min(0.5).max(20).default(2),
});

const KINDS = ["check", "duration", "count", "quit"] as const;
const TIMES = ["morning", "afternoon", "evening", "anytime"] as const;
const HabitIn = z.object({
  name: opt(cpString(1, 60)),
  emoji: opt(cpString(1, 8)),
  category: opt(z.string().refine((v) => has(HABIT_CATEGORIES, v))),
  kind: opt(z.enum(KINDS)),
  unit: opt(cpString(0, 20)),
  daily_goal: opt(z.number().gt(0).max(100_000)),
  weekly_target: opt(z.int().min(1).max(7)),
  time_of_day: opt(z.enum(TIMES)),
  cue: opt(cpString(0, 120)),
  why: opt(cpString(0, 200)),
  total_goal: opt(z.number().gt(0).max(10_000_000)),
  remind_hour: opt(z.int().min(0).max(23)),
  days_mask: opt(z.int().min(1).max(127)),
});

const ReadinessIn = z.object({
  sleep: z.int().min(1).max(5),
  energy: z.int().min(1).max(5),
  soreness: z.int().min(1).max(5),
});

const ReflectionIn = z.object({ went_well: opt(cpString(0, 500)), change: opt(cpString(0, 500)) });

// ---- helpers ------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
/** Python `str(x)` for the JSON scalars an export can hold. */
const pyStrOf = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "boolean" ? (v ? "True" : "False") : String(v);
const isoDate = (v: unknown): string | null => (typeof v === "string" && isIsoDate(v) ? v : null);
const int = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
/** Python `float(x)`: numbers and numeric strings. */
function pyFloat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const uuidOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return UUID_RE.test(s) ? s : null;
};
const knownExercise = (id: unknown) =>
  typeof id === "string" && (EXERCISE_BY_ID.has(id) || id.startsWith(CUSTOM_PREFIX));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Python `clean_tags`: lowercase slugs, deduplicated in order, at most 8 of 24 characters. */
export function cleanTags(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const tag = raw
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 8);
}

function validSplits(raw: unknown): { m: number; sec: number }[] {
  if (!Array.isArray(raw) || raw.length > 500) return [];
  const out: { m: number; sec: number }[] = [];
  for (const x of raw) {
    const r = SplitIn.safeParse(x);
    if (!r.success) return [];
    out.push(r.data);
  }
  return out;
}

/** Epoch ms of `date` at 12:00 local time in `tz` (legacy daily weights land at local midday). */
export function localNoon(date: string, tz: string): number {
  const target = Date.parse(`${date}T12:00:00Z`);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const shown = Date.parse(
      `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`,
    );
    guess += target - shown;
  }
  return guess;
}

function effectiveEnd(startsOn: string, endsOn: string | null): string {
  const cap = addDays(startsOn, PAUSE_MAX_DAYS - 1);
  return endsOn === null || endsOn > cap ? cap : endsOn;
}

// ---- state --------------------------------------------------------------------------------------------------

/** Carried between slices of a queued import (old id -> new id). */
export interface ImportMaps {
  ex: Record<string, string>;
  gear: Record<string, string>;
  gym: Record<string, string>;
}

export interface ImportCounts {
  imported: number;
  skipped: number;
}

/** What the account already holds, read in one batch before planning. Planning updates it as rows are added. */
export interface Existing {
  tz: string;
  customs: Map<string, string>;
  gear: Map<string, string>;
  gyms: Map<string, string>;
  pauses: { startsOn: string; endsOn: string | null }[];
  weighKeys: Set<string>;
  metricDays: Set<string>;
  noted: Set<string>;
  hasGoal: boolean;
  habits: Map<string, string>;
  habitDays: Map<string, Set<string>>;
  readyDays: Set<string>;
  reflectionWeeks: Set<string>;
  /** Owners of the workout ids this plan looks at (any user). */
  workoutOwners: Map<string, string>;
  /** Weigh-in ids already in use by anyone. */
  weighInIds: Set<string>;
}

export const weighKey = (localDate: string, moment: string, kg: number) =>
  `${localDate}|${moment}|${pyRound(kg, 2)}`;

type Row = Record<string, unknown>;

/** Rows to insert, per table, in the column names of `BULK` in repo.ts. */
export interface Rows {
  custom_exercises: Row[];
  gear: Row[];
  gyms: Row[];
  workouts: Row[];
  workout_sets: Row[];
  streak_pauses: Row[];
  body_metrics: Row[];
  weigh_ins: Row[];
  exercise_notes: Row[];
  weight_goals: Row[];
  habits: Row[];
  habit_logs: Row[];
  readiness: Row[];
  week_reflections: Row[];
}

export const emptyRows = (): Rows => ({
  custom_exercises: [],
  gear: [],
  gyms: [],
  workouts: [],
  workout_sets: [],
  streak_pauses: [],
  body_metrics: [],
  weigh_ins: [],
  exercise_notes: [],
  weight_goals: [],
  habits: [],
  habit_logs: [],
  readiness: [],
  week_reflections: [],
});

/** Workout and weigh-in ids an export mentions, so `Existing` can answer who owns them in the same read. */
export function idsToCheck(sections: Partial<Record<Section, unknown>>): {
  workouts: string[];
  weighIns: string[];
} {
  const ids = (v: unknown) =>
    list(v)
      .map((x) => (isObj(x) ? uuidOf(x.id) : null))
      .filter((x): x is string => x !== null);
  return { workouts: ids(sections.workouts), weighIns: ids(sections.weigh_ins) };
}

export interface Planner {
  userId: string;
  now: number;
  ex: Existing;
  maps: ImportMaps;
  counts: ImportCounts;
  rows: Rows;
}

// ---- sections -----------------------------------------------------------------------------------------------

function customExercises(pl: Planner, items: unknown[]) {
  for (const item of items) {
    const r = CustomExerciseIn.safeParse(item);
    if (!r.success) continue;
    const spec = r.data;
    const key = spec.name.toLowerCase();
    let exerciseId = pl.ex.customs.get(key);
    if (exerciseId === undefined) {
      const id = uuid7(pl.now);
      exerciseId = `${CUSTOM_PREFIX}${id}`;
      pl.rows.custom_exercises.push({
        id,
        name: spec.name,
        pattern: spec.pattern,
        equipment: spec.equipment,
        primary: [...new Set(spec.primary)],
        secondary: [...new Set(spec.secondary)],
        load_type: spec.load_type,
        rest_sec: spec.rest_sec,
        unilateral: spec.unilateral,
        cue: spec.cue ?? null,
      });
      pl.ex.customs.set(key, exerciseId);
    }
    pl.maps.ex[pyStrOf((item as Obj).id ?? null)] = exerciseId;
  }
}

function gearSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    const r = GearIn.safeParse(item);
    if (!r.success) continue;
    const spec = r.data;
    const key = spec.name.toLowerCase();
    let id = pl.ex.gear.get(key);
    if (id === undefined) {
      id = uuid7(pl.now);
      pl.rows.gear.push({
        id,
        name: spec.name,
        kind: spec.kind,
        limit_m: spec.limit_km ? spec.limit_km * 1000 : null,
        initial_m: spec.initial_km * 1000,
        note: spec.note ?? null,
        retired_at: (item as Obj).retired_at ? pl.now : null,
      });
      pl.ex.gear.set(key, id);
    }
    pl.maps.gear[pyStrOf((item as Obj).id ?? null)] = id;
  }
}

function gymSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    const r = GymIn.safeParse(item);
    if (!r.success) continue;
    const spec = r.data;
    const key = spec.name.toLowerCase();
    let id = pl.ex.gyms.get(key);
    if (id === undefined) {
      id = uuid7(pl.now);
      pl.rows.gyms.push({
        id,
        name: spec.name,
        equipment: [...new Set(spec.equipment)],
        plates_kg: [...new Set(spec.plates_kg.map((p) => pyRound(p, 3)))].sort((a, b) => b - a),
        bar_kg: spec.bar_kg,
      });
      pl.ex.gyms.set(key, id);
    }
    pl.maps.gym[pyStrOf((item as Obj).id ?? null)] = id;
  }
}

/** Range-checked so a hand-edited file cannot trip a CHECK constraint (Python stored these raw and answered 500). */
function extras(item: Obj) {
  const zones = item.hr_zones;
  return {
    duration_sec: int(item.duration_sec, 0, Number.MAX_SAFE_INTEGER),
    distance_m: num(item.distance_m, 0, Number.MAX_VALUE),
    elevation_m: num(item.elevation_m, -Number.MAX_VALUE, Number.MAX_VALUE),
    effort: int(item.effort, 1, 10),
    feel: int(item.feel, 1, 5),
    soreness: int(item.soreness, 0, 3),
    pump: int(item.pump, 0, 2),
    avg_hr: int(item.avg_hr, 30, 240),
    max_hr: int(item.max_hr, 30, 240),
    hr_zones: Array.isArray(zones)
      ? zones.filter((z): z is number => typeof z === "number" && Number.isInteger(z) && z >= 0).slice(0, 5)
      : [],
  };
}

function workoutSection(pl: Planner, items: unknown[]) {
  for (const raw of items) {
    if (!isObj(raw)) {
      pl.counts.skipped++;
      continue;
    }
    let id = uuidOf(raw.id);
    const started = typeof raw.started_at === "string" ? parseInstant(raw.started_at) : null;
    if (
      id === null ||
      typeof raw.discipline !== "string" ||
      !DISCIPLINE_IDS.has(raw.discipline) ||
      started === null
    ) {
      pl.counts.skipped++;
      continue;
    }
    const sets: z.infer<typeof SetIn>[] = [];
    let bad = false;
    for (const s of list(raw.sets)) {
      const copy: Obj = isObj(s) ? { ...s } : {};
      const exId = copy.exercise_id;
      copy.exercise_id = (typeof exId === "string" ? pl.maps.ex[exId] : undefined) ?? exId;
      if (!knownExercise(copy.exercise_id)) continue;
      const r = SetIn.safeParse(copy);
      if (!r.success) {
        bad = true;
        break;
      }
      sets.push(r.data);
    }
    if (bad) {
      pl.counts.skipped++;
      continue;
    }
    const owner = pl.ex.workoutOwners.get(id);
    if (owner !== undefined && owner !== pl.userId) id = uuid7(pl.now);
    else if (owner === pl.userId) {
      pl.counts.skipped++;
      continue;
    }
    pl.ex.workoutOwners.set(id, pl.userId);
    const local = localParts(started, pl.ex.tz);
    const ref = (map: Record<string, string>, v: unknown) => map[pyStrOf(v ?? null)] ?? null;
    pl.rows.workouts.push({
      id,
      discipline: raw.discipline,
      title: raw.title ? cut(pyStrOf(raw.title), 80) : null,
      notes: raw.notes ? cut(pyStrOf(raw.notes), 1000) : null,
      started_at: started,
      local_date: local.date,
      local_hour: local.hour,
      ...extras(raw),
      tags: cleanTags(list(raw.tags).filter((t): t is string => typeof t === "string")),
      splits: validSplits(raw.splits),
      gear_id: ref(pl.maps.gear, raw.gear_id),
      gym_id: ref(pl.maps.gym, raw.gym_id),
    });
    for (const s of sets) {
      pl.rows.workout_sets.push({
        id: uuid7(pl.now),
        workout_id: id,
        exercise_id: s.exercise_id,
        position: s.position,
        set_index: s.set_index,
        superset: s.superset ?? null,
        kind: s.kind,
        weight_kg: s.weight_kg ?? null,
        reps: s.reps ?? null,
        rpe: s.rpe ?? null,
        duration_sec: s.duration_sec ?? null,
        distance_m: s.distance_m ?? null,
        completed: s.completed,
      });
    }
    pl.counts.imported++;
  }
}

function pauseSection(pl: Planner, items: unknown[]) {
  for (const p of items) {
    if (!isObj(p)) continue;
    const startsOn = isoDate(p.starts_on);
    if (startsOn === null) continue;
    let endsOn: string | null = null;
    if (p.ends_on) {
      endsOn = isoDate(p.ends_on);
      if (endsOn === null) continue;
    }
    if (endsOn !== null && endsOn < startsOn) continue;
    const end = effectiveEnd(startsOn, endsOn);
    if (pl.ex.pauses.some((h) => startsOn <= effectiveEnd(h.startsOn, h.endsOn) && h.startsOn <= end))
      continue;
    pl.ex.pauses.push({ startsOn, endsOn });
    const note = cut(pyStrOf(p.note || ""), 280);
    pl.rows.streak_pauses.push({
      id: uuid7(pl.now),
      starts_on: startsOn,
      ends_on: endsOn ?? end,
      reason: typeof p.reason === "string" && PAUSE_REASONS.has(p.reason) ? p.reason : "other",
      note: note || null,
    });
  }
}

function addWeighIn(
  pl: Planner,
  at: number,
  moment: string,
  kg: number,
  note: string | null,
  id: string | null,
) {
  const day = localParts(at, pl.ex.tz).date;
  const key = weighKey(day, moment, kg);
  if (pl.ex.weighKeys.has(key)) return;
  pl.ex.weighKeys.add(key);
  const wanted = id ?? uuid7(pl.now);
  pl.ex.weighInIds.add(wanted);
  pl.rows.weigh_ins.push({
    id: wanted,
    weighed_at: at,
    local_date: day,
    moment,
    weight_kg: pyRound(kg, 2),
    note,
  });
}

function bodyMetricSection(pl: Planner, items: unknown[]) {
  for (const m of items) {
    if (!isObj(m)) continue;
    const day = isoDate(m.date);
    if (day === null) continue;
    const { date: _, ...rest } = m;
    const r = BodyMetricIn.safeParse(rest);
    if (!r.success) continue;
    // Exports before version 3 kept one weight per day on this row: it becomes a weigh-in at local midday.
    const legacy = m.weight_kg;
    if (legacy !== null && legacy !== undefined && typeof legacy === "number" && legacy > 0 && legacy <= 700)
      addWeighIn(pl, localNoon(day, pl.ex.tz), "other", legacy, null, null);
    const values = METRIC_FIELDS.map((f) => r.data[f] ?? null);
    if (values.every((v) => v === null)) continue;
    if (pl.ex.metricDays.has(day)) continue;
    pl.ex.metricDays.add(day);
    pl.rows.body_metrics.push({
      id: uuid7(pl.now),
      measured_on: day,
      ...Object.fromEntries(METRIC_FIELDS.map((f, i) => [f, values[i]])),
    });
  }
}

function weighInSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    const r = WeighInIn.safeParse(item);
    if (!r.success) continue;
    // A weigh-in without a zone is skipped, as in Python.
    const at = parseInstant(r.data.weighed_at);
    if (at === null) continue;
    let wanted = uuidOf((item as Obj).id);
    if (wanted !== null && pl.ex.weighInIds.has(wanted)) wanted = null;
    addWeighIn(pl, at, r.data.moment, r.data.weight_kg, r.data.note ?? null, wanted);
  }
}

function noteSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    if (!isObj(item)) continue;
    const raw = item.exercise_id;
    const exerciseId = (typeof raw === "string" ? pl.maps.ex[raw] : undefined) ?? raw;
    const text = cut(pyStrOf(item.note || "").trim(), 500);
    if (!knownExercise(exerciseId) || !text || pl.ex.noted.has(exerciseId as string)) continue;
    pl.ex.noted.add(exerciseId as string);
    pl.rows.exercise_notes.push({ id: uuid7(pl.now), exercise_id: exerciseId, note: text });
  }
}

function goalSection(pl: Planner, goal: unknown) {
  if (!isObj(goal) || pl.ex.hasGoal) return;
  const r = WeightGoalIn.safeParse(goal);
  const start = pyFloat(goal.start_kg);
  const setOn = isoDate(goal.set_on);
  if (!r.success || start === null || setOn === null) return;
  pl.ex.hasGoal = true;
  pl.rows.weight_goals.push({
    id: uuid7(pl.now),
    target_kg: r.data.target_kg,
    milestone_kg: r.data.milestone_kg,
    start_kg: start,
    set_on: setOn,
  });
}

function habitSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    if (!isObj(item)) continue;
    const picked = Object.fromEntries(Object.keys(HabitIn.shape).map((k) => [k, item[k] ?? null]));
    const r = HabitIn.safeParse(picked);
    const started = isoDate(item.started_on);
    if (!r.success || started === null) continue;
    const spec = r.data;
    if (!spec.name) continue;
    const key = spec.name.toLowerCase();
    let id = pl.ex.habits.get(key);
    if (id === undefined) {
      id = uuid7(pl.now);
      const kind = spec.kind ?? "check";
      pl.rows.habits.push({
        id,
        name: spec.name.trim(),
        emoji: spec.emoji || "✨",
        category: spec.category || "other",
        kind,
        unit: spec.unit ?? null,
        daily_goal: kind === "duration" || kind === "count" ? (spec.daily_goal ?? null) : null,
        weekly_target: spec.weekly_target || 7,
        time_of_day: spec.time_of_day || "anytime",
        cue: spec.cue ?? null,
        why: spec.why ?? null,
        total_goal: spec.total_goal ?? null,
        remind_hour: spec.remind_hour ?? null,
        days_mask: kind !== "quit" ? (spec.days_mask ?? null) : null,
        paused_from: isoDate(item.paused_from),
        paused_until: isoDate(item.paused_until),
        started_on: started,
        archived_at: item.archived_at ? pl.now : null,
      });
      pl.ex.habits.set(key, id);
    }
    const have = pl.ex.habitDays.get(id) ?? new Set<string>();
    pl.ex.habitDays.set(id, have);
    for (const entry of list(item.days)) {
      if (!isObj(entry)) continue;
      const day = isoDate(entry.date);
      const amount = pyFloat(entry.amount);
      if (day === null || amount === null) continue;
      if (have.has(day) || !(amount > 0 && amount <= 100_000)) continue;
      have.add(day);
      const note = cut(pyStrOf(entry.note || ""), 280);
      pl.rows.habit_logs.push({ id: uuid7(pl.now), habit_id: id, day, amount, note: note || null });
    }
  }
}

function readinessSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    if (!isObj(item)) continue;
    const day = isoDate(item.date);
    const r = ReadinessIn.safeParse(item);
    if (day === null || !r.success || pl.ex.readyDays.has(day)) continue;
    pl.ex.readyDays.add(day);
    pl.rows.readiness.push({ id: uuid7(pl.now), day, ...r.data });
  }
}

function reflectionSection(pl: Planner, items: unknown[]) {
  for (const item of items) {
    if (!isObj(item)) continue;
    const week = isoDate(item.week_start);
    const r = ReflectionIn.safeParse(item);
    if (week === null || !r.success || pl.ex.reflectionWeeks.has(week)) continue;
    if (!r.data.went_well && !r.data.change) continue;
    pl.ex.reflectionWeeks.add(week);
    pl.rows.week_reflections.push({
      id: uuid7(pl.now),
      week_start: week,
      went_well: r.data.went_well ?? null,
      change: r.data.change ?? null,
    });
  }
}

const HANDLERS: Record<Exclude<Section, "weight_goal">, (pl: Planner, items: unknown[]) => void> = {
  custom_exercises: customExercises,
  gear: gearSection,
  gyms: gymSection,
  workouts: workoutSection,
  pauses: pauseSection,
  body_metrics: bodyMetricSection,
  weigh_ins: weighInSection,
  exercise_notes: noteSection,
  habits: habitSection,
  readiness: readinessSection,
  reflections: reflectionSection,
};

/** Plans one section. Arrays may arrive in pieces (queued slices); each piece is planned as it comes. */
export function planSection(pl: Planner, section: Section, value: unknown): void {
  if (section === "weight_goal") goalSection(pl, value);
  else HANDLERS[section](pl, list(value));
}
