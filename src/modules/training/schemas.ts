/**
 * Request schemas for the training routes (Python app/training/schemas.py, plans.py, photos.py, habits.py).
 * Objects are non-strict, like pydantic; messages come out pydantic-shaped through lib/validation.ts.
 */
import * as z from "zod";
import { DISCIPLINE_IDS, EQUIPMENT, LOAD_TYPES, MUSCLES, PATTERNS } from "../../catalog/exercises.ts";
import { pyRound } from "../../lib/format.ts";
import { parseInstant } from "../../lib/time.ts";

// ---- shared pieces ----------------------------------------------------------------------------------------

/** A UUID path or body field, lowercased (Python `UUID` accepts either case). */
export const uuid = z.guid().transform((s) => s.toLowerCase());

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** pydantic `datetime` that must carry an offset; epoch ms out. */
const awareInstant = (message: string) =>
  z.iso
    .datetime({ offset: true, local: true })
    .refine((s) => HAS_OFFSET.test(s), message)
    .transform((s) => parseInstant(s) ?? Number.NaN);

/** A `datetime` query value: naive is read as UTC (the stored instants are UTC). */
export const instantQuery = z.iso
  .datetime({ offset: true, local: true })
  .transform((s) => parseInstant(HAS_OFFSET.test(s) ? s : `${s}Z`) ?? Number.NaN);

const known = (set: ReadonlySet<string>, message: string) => z.string().refine((v) => set.has(v), message);

/** `list(dict.fromkeys(v))`. */
const dedupe = <T>(v: readonly T[]): T[] => [...new Set(v)];

function knownList(set: ReadonlySet<string> | readonly string[], label: string, max: number) {
  const has = (v: string) => (Array.isArray(set) ? set.includes(v) : (set as ReadonlySet<string>).has(v));
  return z
    .array(z.string())
    .max(max)
    .superRefine((v, ctx) => {
      const bad = v.filter((d) => !has(d));
      if (bad.length > 0) ctx.addIssue({ code: "custom", message: `unknown ${label}: ${bad.join(", ")}` });
    })
    .transform(dedupe);
}

const disciplineList = (max: number) => knownList(DISCIPLINE_IDS, "disciplines", max);

const stripOrNull = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};

// ---- workouts ---------------------------------------------------------------------------------------------

export const SetIn = z.object({
  exercise_id: z.string().min(1).max(80),
  position: z.int().min(0).max(200),
  set_index: z.int().min(0).max(100),
  superset: z.int().min(0).max(50).nullable().default(null),
  kind: z.enum(["work", "warmup", "drop", "failure"]).default("work"),
  weight_kg: z.number().min(0).max(2000).nullable().default(null),
  reps: z.int().min(0).max(1000).nullable().default(null),
  rpe: z.number().min(1).max(10).nullable().default(null),
  duration_sec: z.int().min(0).max(86_400).nullable().default(null),
  distance_m: z.number().min(0).max(1_000_000).nullable().default(null),
  completed: z.boolean().default(true),
});
export type SetInput = z.output<typeof SetIn>;

const SplitIn = z.object({ m: z.int().min(1).max(1000), sec: z.int().min(0).max(86_400) });

const TAG_RE = /[^a-z0-9-]+/g;

/** Lowercase slugs, deduplicated in order: "#Hill Reps" -> "hill-reps" (Python `clean_tags`). */
export function cleanTags(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const tag = raw
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(TAG_RE, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 8);
}

const TZ_MESSAGE = "timestamps must carry a timezone offset";

export const WorkoutIn = z.object({
  discipline: known(DISCIPLINE_IDS, "unknown discipline"),
  title: z.string().max(80).nullable().default(null).transform(stripOrNull),
  notes: z.string().max(1000).nullable().default(null).transform(stripOrNull),
  started_at: awareInstant(TZ_MESSAGE),
  duration_sec: z.int().min(0).max(172_800).nullable().default(null),
  distance_m: z.number().min(0).max(1_000_000).nullable().default(null),
  elevation_m: z.number().min(0).max(20_000).nullable().default(null),
  effort: z.int().min(1).max(10).nullable().default(null),
  feel: z.int().min(1).max(5).nullable().default(null),
  routine_id: uuid.nullable().default(null),
  tags: z.array(z.string()).max(20).default([]).transform(cleanTags),
  gear_id: uuid.nullable().default(null),
  gym_id: uuid.nullable().default(null),
  soreness: z.int().min(0).max(3).nullable().default(null),
  pump: z.int().min(0).max(2).nullable().default(null),
  avg_hr: z.int().min(30).max(240).nullable().default(null),
  max_hr: z.int().min(30).max(240).nullable().default(null),
  hr_zones: z.array(z.int()).max(5).default([]),
  splits: z.array(SplitIn).max(500).default([]),
  client_updated_at: awareInstant(TZ_MESSAGE),
  sets: z.array(SetIn).max(400).default([]),
});
export type WorkoutInput = z.output<typeof WorkoutIn>;

export const BatchIn = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(["put", "delete"]),
        id: uuid,
        workout: WorkoutIn.nullable().default(null),
        client_updated_at: awareInstant(TZ_MESSAGE),
      }),
    )
    .max(200),
});
export type BatchInput = z.output<typeof BatchIn>;

export const WorkoutId = z.object({ workout_id: uuid });

export const ListQuery = z.object({
  before: instantQuery.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  discipline: z.string().optional(),
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
});

export const ChangesQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const DeleteQuery = z.object({ client_updated_at: instantQuery.optional() });

// ---- exercises and routines -------------------------------------------------------------------------------

export const LastQuery = z.object({ ids: z.string().max(2000) });
export const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) });
export const ExerciseIdParam = z.object({ exercise_id: z.string() });

export const CustomExerciseIn = z.object({
  name: z.string().min(1).max(60),
  pattern: known(new Set(Object.keys(PATTERNS)), "unknown movement pattern"),
  equipment: known(new Set(Object.keys(EQUIPMENT)), "unknown equipment"),
  primary: knownList(Object.keys(MUSCLES), "muscles", 6).default([]),
  secondary: knownList(Object.keys(MUSCLES), "muscles", 6).default([]),
  load_type: known(new Set<string>(LOAD_TYPES), "unknown load type").default("weight"),
  rest_sec: z.int().min(0).max(900).default(90),
  unilateral: z.boolean().default(false),
  cue: z.string().max(200).nullable().default(null),
});
export type CustomExerciseInput = z.output<typeof CustomExerciseIn>;

export const RoutineItem = z.object({
  exercise_id: z.string().min(1).max(80),
  sets: z.int().min(1).max(20).default(3),
  reps_min: z.int().min(0).max(1000).nullable().default(null),
  reps_max: z.int().min(0).max(1000).nullable().default(null),
  rest_sec: z.int().min(0).max(900).nullable().default(null),
  target_rpe: z.number().min(1).max(10).nullable().default(null),
  weight_kg: z.number().min(0).max(1000).nullable().default(null),
  increment_kg: z.number().gt(0).max(50).nullable().default(null),
  note: z.string().max(140).nullable().default(null),
});
export type RoutineItemInput = z.output<typeof RoutineItem>;

export const RoutineIn = z.object({
  name: z.string().min(1).max(60),
  discipline: known(DISCIPLINE_IDS, "unknown discipline").default("strength"),
  notes: z.string().max(500).nullable().default(null),
  items: z.array(RoutineItem).max(40).default([]),
  position: z.int().default(0),
});
export type RoutineInput = z.output<typeof RoutineIn>;

export const RoutineId = z.object({ routine_id: uuid });
export const TemplateId = z.object({ template_id: z.string() });

// ---- body -------------------------------------------------------------------------------------------------

const cm = () => z.number().gt(0).max(400).nullable().default(null);

export const BodyMetricIn = z.object({
  body_fat_pct: z.number().min(1).max(75).nullable().default(null),
  waist_cm: cm(),
  resting_hr: z.int().min(20).max(250).nullable().default(null),
  sleep_hours: z.number().min(0).max(24).nullable().default(null),
  note: z.string().max(200).nullable().default(null),
  neck_cm: cm(),
  shoulders_cm: cm(),
  chest_cm: cm(),
  arm_cm: cm(),
  forearm_cm: cm(),
  hips_cm: cm(),
  thigh_cm: cm(),
  calf_cm: cm(),
});
export type BodyMetricInput = z.output<typeof BodyMetricIn>;

export const DayParam = z.object({ day: z.iso.date() });
export const DaysQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(365) });

export const WeighInIn = z.object({
  // Python checks the zone in the handler ("Time needs a timezone"), after the shape.
  weighed_at: z.iso.datetime({ offset: true, local: true }),
  moment: z.enum(["waking", "pre_workout", "post_workout", "bedtime", "other"]),
  weight_kg: z.number().gt(0).max(700),
  note: z.string().max(200).nullable().default(null),
});
export type WeighInInput = z.output<typeof WeighInIn>;
export const WeighInId = z.object({ weigh_in_id: uuid });

export const PhotoIn = z.object({
  date: z.iso.date(),
  pose: z.enum(["front", "side", "back"]),
  content_type: z.string(),
});
export type PhotoInput = z.output<typeof PhotoIn>;
export const PhotoId = z.object({ photo_id: uuid });

// ---- chains and pauses ------------------------------------------------------------------------------------

export const RequirementIn = z.object({
  disciplines: z
    .array(z.string())
    .min(1)
    .max(11)
    .superRefine((v, ctx) => {
      const bad = v.filter((d) => !DISCIPLINE_IDS.has(d));
      if (bad.length > 0) ctx.addIssue({ code: "custom", message: `unknown disciplines: ${bad.join(", ")}` });
    })
    .transform((v) => dedupe(v).sort()),
  days: z.int().min(1).max(7),
});
export type Requirement = z.output<typeof RequirementIn>;

export const ChainIn = z.object({
  name: z.string().min(1).max(40),
  disciplines: disciplineList(11).default([]),
  target: z.int().min(1).max(7).default(3),
  requirements: z.array(RequirementIn).max(3).default([]),
});
export type ChainInput = z.output<typeof ChainIn>;

export const ChainPatch = z.object({
  name: z.string().min(1).max(40).nullable().default(null),
  disciplines: disciplineList(11).nullable().default(null),
  target: z.int().min(1).max(7).nullable().default(null),
  requirements: z.array(RequirementIn).max(3).nullable().default(null),
  position: z.int().nullable().default(null),
});
export type ChainPatchInput = z.output<typeof ChainPatch>;

export const ChainId = z.object({ chain_id: uuid });
export const RepairIn = z.object({ week_start: z.iso.date() });

export const PauseIn = z.object({
  starts_on: z.iso.date(),
  ends_on: z.iso.date().nullable().default(null),
  reason: z.enum(["injury", "illness", "travel", "life", "other"]).default("injury"),
  note: z.string().max(280).nullable().default(null),
});
export type PauseInput = z.output<typeof PauseIn>;
export const PauseId = z.object({ pause_id: uuid });

// ---- gear and personal ------------------------------------------------------------------------------------

export const GearIn = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(["shoes", "bike", "other"]).default("shoes"),
  default_for: disciplineList(11).default([]),
  limit_km: z.number().gt(0).max(100_000).nullable().default(null),
  initial_km: z.number().min(0).max(100_000).default(0),
  note: z.string().max(200).nullable().default(null),
});
export type GearInput = z.output<typeof GearIn>;

/** Every field optional; `limit_km` and `note` are applied when present (explicit null clears them). */
export const GearPatch = z.object({
  name: z.string().min(1).max(60).nullable().optional(),
  kind: z.enum(["shoes", "bike", "other"]).nullable().optional(),
  default_for: disciplineList(11).nullable().optional(),
  limit_km: z.number().gt(0).max(100_000).nullable().optional(),
  initial_km: z.number().min(0).max(100_000).nullable().optional(),
  note: z.string().max(200).nullable().optional(),
  retired: z.boolean().nullable().optional(),
});
export type GearPatchInput = z.output<typeof GearPatch>;
export const GearId = z.object({ gear_id: uuid });

export const GymIn = z.object({
  name: z.string().min(1).max(60),
  equipment: knownList(Object.keys(EQUIPMENT), "equipment", 20).default([]),
  plates_kg: z
    .array(z.number())
    .max(20)
    .default([])
    .refine((v) => v.every((p) => p > 0 && p <= 50), "plates are between 0 and 50 kg")
    .transform((v) => [...new Set(v.map((p) => pyRound(p, 3)))].sort((a, b) => b - a)),
  bar_kg: z.number().min(0).max(50).default(20),
  is_default: z.boolean().default(false),
});
export type GymInput = z.output<typeof GymIn>;
export const GymId = z.object({ gym_id: uuid });

export const ExerciseNoteIn = z.object({ note: z.string().max(500) });

export const WeightGoalIn = z.object({
  target_kg: z.number().gt(20).max(400),
  milestone_kg: z.number().min(0.5).max(20).default(2),
});

export const BlockIn = z.object({
  name: z.string().min(1).max(60).default("Training block"),
  weeks: z.int().min(3).max(8).default(5),
  rir_start: z.int().min(0).max(5).default(3),
  rir_end: z.int().min(0).max(5).default(1),
  when: z.enum(["this", "next"]).default("this"),
});
export type BlockInput = z.output<typeof BlockIn>;
export const BlockId = z.object({ block_id: uuid });

export const ReadinessIn = z.object({
  sleep: z.int().min(1).max(5),
  energy: z.int().min(1).max(5),
  soreness: z.int().min(1).max(5),
});
/** Python `days: int = 30`, clamped to 1..365 in the handler. */
export const ReadinessQuery = z.object({ days: z.coerce.number().int().default(30) });

export const ReflectionIn = z.object({
  went_well: z.string().max(500).nullable().default(null),
  change: z.string().max(500).nullable().default(null),
});
export const WeekParam = z.object({ week: z.iso.date() });

// ---- monthly goal and rest days (Python training/habits.py) -----------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MonthGoalQuery = z.object({ month: z.string().regex(MONTH).optional() });
export const GoalIn = z.object({ month: z.string().regex(MONTH), days: z.int().min(1).max(31) });
export const MonthParam = z.object({ month: z.string() });
export const RestIn = z.object({
  kind: z
    .string()
    .regex(/^(rest|sleep|mobility|sick)$/)
    .default("rest"),
  note: z.string().max(200).nullable().default(null).transform(stripOrNull),
});
export const RestQuery = z.object({ from: z.iso.date().optional() });

// ---- plans ------------------------------------------------------------------------------------------------

export const MAX_PER_WEEK = 14;
export const MAX_WEEKS = 26;

export const PlanSession = z.object({
  day: z.int().min(0).max(6),
  discipline: known(DISCIPLINE_IDS, "unknown discipline"),
  title: z.string().min(1).max(80),
  minutes: z.int().min(1).max(600).nullable().default(null),
  distance_km: z.number().gt(0).max(500).nullable().default(null),
  routine_id: uuid.nullable().default(null),
  note: z.string().max(200).nullable().default(null),
});
export type PlanSessionInput = z.output<typeof PlanSession>;

const byDay = <T extends { day: number }>(w: readonly T[]): T[] => [...w].sort((a, b) => a.day - b.day);

export const PlanIn = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).nullable().default(null),
  weeks: z
    .array(z.array(PlanSession))
    .min(1)
    .max(MAX_WEEKS)
    .refine((v) => v.every((w) => w.length <= MAX_PER_WEEK), `at most ${MAX_PER_WEEK} sessions a week`)
    .transform((v) => v.map(byDay)),
  repeat: z.boolean().default(false),
});
export type PlanInput = z.output<typeof PlanIn>;

export const PlanCreate = z.object({
  template_id: z.string().nullable().default(null),
  plan: PlanIn.nullable().default(null),
});

export const StartIn = z.object({
  when: z
    .string()
    .regex(/^(this|next)$/)
    .default("this"),
});

export const RaceIn = z.object({
  race: z.string().regex(/^(5k|10k|half|marathon)$/),
  race_date: z.iso.date(),
  per_week: z.int().min(3).max(5).default(3),
});

const SharedRoutine = z.object({
  name: z.string().min(1).max(60),
  discipline: z.string().default("strength"),
  notes: z.string().max(500).nullable().default(null),
  items: z.array(RoutineItem).max(40).default([]),
});

const SharedSession = PlanSession.extend({ routine: SharedRoutine.nullable().default(null) });

export const SharedPlan = z.object({
  format: z.string().regex(/^pacestreak-plan$/),
  version: z.int().min(1).max(1),
  name: z.string().min(1).max(60),
  description: z.string().max(500).nullable().default(null),
  weeks: z.array(z.array(SharedSession)).min(1).max(MAX_WEEKS),
  repeat: z.boolean().default(false),
});
export type SharedPlanInput = z.output<typeof SharedPlan>;

export const PlanId = z.object({ plan_id: uuid });
