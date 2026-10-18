import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, bool, enumCheck, json, maxLength, ms, nullableCheck } from "./columns.ts";
import { challenges } from "./groups.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const GEAR_KINDS = ["shoes", "bike", "other"] as const;

export const gear = sqliteTable(
  "gear",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    kind: text({ enum: GEAR_KINDS }).notNull().default("shoes"),
    defaultFor: json<string[]>().notNull().default([]),
    limitM: real(),
    initialM: real().notNull().default(0),
    retiredAt: ms(),
    note: text(),
  },
  (t) => [
    index("ix_gear_user_id").on(t.userId),
    enumCheck("ck_gear_kind", t.kind, GEAR_KINDS),
    nullableCheck("ck_gear_limit_m", t.limitM, sql`${t.limitM} > 0`),
  ],
);

export const gyms = sqliteTable(
  "gyms",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    equipment: json<string[]>().notNull().default([]),
    platesKg: json<number[]>().notNull().default([]),
    barKg: real().notNull().default(20),
    isDefault: bool().notNull().default(false),
  },
  (t) => [index("ix_gyms_user_id").on(t.userId)],
);

export type Split = { m: number; sec: number };
export const WORKOUT_SOURCES = ["app", "import"] as const;

/**
 * Workouts sync with last-writer-wins on `client_updated_at`. `seq` comes from the global `sync_seq` counter in the
 * same batch as the write and is re-assigned on every update, soft delete and restore (spec/schema.md §2.1).
 */
export const workouts = sqliteTable(
  "workouts",
  {
    ...base(),
    userId: userFk(),
    discipline: text().notNull(),
    title: text(),
    notes: text(),
    startedAt: ms().notNull(),
    /** The user's local date at write time; stored, never derived. */
    localDate: text().notNull(),
    /** The user's local start hour at write time (early/late badges, smart reminders). NULL falls back to UTC. */
    localHour: integer(),
    durationSec: integer(),
    distanceM: real(),
    elevationM: real(),
    effort: integer(),
    feel: integer(),
    soreness: integer(),
    pump: integer(),
    avgHr: integer(),
    maxHr: integer(),
    hrZones: json<number[]>().notNull().default([]),
    /** Not a foreign key: routines can be deleted while workouts keep the reference. */
    routineId: text(),
    tags: json<string[]>().notNull().default([]),
    splits: json<Split[]>().notNull().default([]),
    gearId: text().references(() => gear.id, { onDelete: "set null" }),
    gymId: text().references(() => gyms.id, { onDelete: "set null" }),
    source: text({ enum: WORKOUT_SOURCES }).notNull().default("app"),
    clientUpdatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: integer().notNull(),
  },
  (t) => [
    index("ix_workouts_user_date").on(t.userId, t.localDate),
    index("ix_workouts_user_seq").on(t.userId, t.seq),
    // Newest-first lists, exercise history and the import duplicate window.
    index("ix_workouts_user_started").on(t.userId, t.startedAt),
    index("ix_workouts_seq").on(t.seq),
    index("ix_workouts_gear_id").on(t.gearId),
    index("ix_workouts_gym_id").on(t.gymId),
    enumCheck("ck_workouts_source", t.source, WORKOUT_SOURCES),
    nullableCheck("ck_workouts_duration", t.durationSec, sql`${t.durationSec} >= 0`),
    nullableCheck("ck_workouts_distance", t.distanceM, sql`${t.distanceM} >= 0`),
    nullableCheck("ck_workouts_effort", t.effort, sql`${t.effort} BETWEEN 1 AND 10`),
    nullableCheck("ck_workouts_feel", t.feel, sql`${t.feel} BETWEEN 1 AND 5`),
    nullableCheck("ck_workouts_soreness", t.soreness, sql`${t.soreness} BETWEEN 0 AND 3`),
    nullableCheck("ck_workouts_pump", t.pump, sql`${t.pump} BETWEEN 0 AND 2`),
    maxLength("ck_workouts_title_len", t.title, 80),
  ],
);

export const SET_KINDS = ["work", "warmup", "drop", "failure"] as const;

/** Always read ordered by (position, set_index). */
export const workoutSets = sqliteTable(
  "workout_sets",
  {
    ...base(),
    workoutId: text()
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    userId: userFk(),
    /** Library id or `custom:<uuid>`. */
    exerciseId: text().notNull(),
    position: integer().notNull(),
    setIndex: integer().notNull(),
    superset: integer(),
    kind: text({ enum: SET_KINDS }).notNull().default("work"),
    weightKg: real(),
    reps: integer(),
    rpe: real(),
    durationSec: integer(),
    distanceM: real(),
    completed: bool().notNull().default(true),
  },
  (t) => [
    index("ix_workout_sets_workout_id").on(t.workoutId, t.position, t.setIndex),
    index("ix_workout_sets_user_exercise").on(t.userId, t.exerciseId),
    enumCheck("ck_workout_sets_kind", t.kind, SET_KINDS),
    nullableCheck("ck_workout_sets_weight", t.weightKg, sql`${t.weightKg} >= 0`),
    nullableCheck("ck_workout_sets_reps", t.reps, sql`${t.reps} >= 0`),
    nullableCheck("ck_workout_sets_rpe", t.rpe, sql`${t.rpe} BETWEEN 1 AND 10`),
  ],
);

export const customExercises = sqliteTable(
  "custom_exercises",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    nameFold: text().notNull(),
    pattern: text().notNull(),
    equipment: text().notNull(),
    primary: json<string[]>().notNull().default([]),
    secondary: json<string[]>().notNull().default([]),
    loadType: text().notNull().default("weight"),
    restSec: integer().notNull().default(90),
    unilateral: bool().notNull().default(false),
    cue: text(),
    archived: bool().notNull().default(false),
  },
  (t) => [index("ix_custom_exercises_user_name").on(t.userId, t.nameFold)],
);

export const routines = sqliteTable(
  "routines",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    nameFold: text().notNull(),
    discipline: text().notNull().default("strength"),
    notes: text(),
    items: json<Record<string, unknown>[]>().notNull().default([]),
    position: integer().notNull().default(0),
    lastUsedAt: ms(),
  },
  (t) => [index("ix_routines_user_name").on(t.userId, t.nameFold)],
);

export const bodyMetrics = sqliteTable(
  "body_metrics",
  {
    ...base(),
    userId: userFk(),
    measuredOn: text().notNull(),
    bodyFatPct: real(),
    waistCm: real(),
    restingHr: integer(),
    sleepHours: real(),
    note: text(),
    neckCm: real(),
    shouldersCm: real(),
    chestCm: real(),
    armCm: real(),
    forearmCm: real(),
    hipsCm: real(),
    thighCm: real(),
    calfCm: real(),
  },
  (t) => [unique("uq_body_metric_day").on(t.userId, t.measuredOn)],
);

export const PHOTO_POSES = ["front", "side", "back"] as const;

export const bodyPhotos = sqliteTable(
  "body_photos",
  {
    ...base(),
    userId: userFk(),
    takenOn: text().notNull(),
    pose: text({ enum: PHOTO_POSES }).notNull(),
    contentType: text().notNull(),
    objectKey: text().notNull(),
    size: integer().notNull(),
  },
  (t) => [
    uniqueIndex("uq_body_photos_object_key").on(t.objectKey),
    index("ix_body_photos_user_taken").on(t.userId, t.takenOn),
    enumCheck("ck_body_photos_pose", t.pose, PHOTO_POSES),
  ],
);

export const WEIGH_IN_MOMENTS = ["waking", "pre_workout", "post_workout", "bedtime", "other"] as const;

export const weighIns = sqliteTable(
  "weigh_ins",
  {
    ...base(),
    userId: userFk(),
    weighedAt: ms().notNull(),
    localDate: text().notNull(),
    moment: text({ enum: WEIGH_IN_MOMENTS }).notNull(),
    weightKg: real().notNull(),
    note: text(),
  },
  (t) => [
    index("ix_weigh_ins_user_day").on(t.userId, t.localDate),
    enumCheck("ck_weigh_ins_moment", t.moment, WEIGH_IN_MOMENTS),
  ],
);

export type TargetHistory = { from: string; target: number }[];
export type RequirementsHistory = { from: string; requirements: { disciplines: string[]; days: number }[] }[];

export const streakChains = sqliteTable(
  "streak_chains",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    /** Empty = every discipline counts. */
    disciplines: json<string[]>().notNull().default([]),
    targetHistory: json<TargetHistory>().notNull().default([]),
    requirementsHistory: json<RequirementsHistory>().notNull().default([]),
    position: integer().notNull().default(0),
    archived: bool().notNull().default(false),
  },
  (t) => [index("ix_streak_chains_user_id").on(t.userId)],
);

export const streakRepairs = sqliteTable(
  "streak_repairs",
  {
    ...base(),
    userId: userFk(),
    chainId: text()
      .notNull()
      .references(() => streakChains.id, { onDelete: "cascade" }),
    weekStart: text().notNull(),
    /** `YYYY-MM`: one repair per person per calendar month. */
    month: text().notNull(),
  },
  (t) => [
    unique("uq_repair_chain_week").on(t.chainId, t.weekStart),
    unique("uq_repair_user_month").on(t.userId, t.month),
  ],
);

export const PAUSE_REASONS = ["injury", "illness", "travel", "life", "other"] as const;

export const streakPauses = sqliteTable(
  "streak_pauses",
  {
    ...base(),
    userId: userFk(),
    startsOn: text().notNull(),
    /** Inclusive; NULL = open-ended. */
    endsOn: text(),
    reason: text({ enum: PAUSE_REASONS }).notNull().default("injury"),
    note: text(),
  },
  (t) => [
    index("ix_streak_pauses_user_start").on(t.userId, t.startsOn),
    enumCheck("ck_pause_reason", t.reason, PAUSE_REASONS),
    nullableCheck("ck_pause_range", t.endsOn, sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const trainingBlocks = sqliteTable(
  "training_blocks",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    startsOn: text().notNull(),
    weeks: integer().notNull(),
    rirStart: integer().notNull().default(3),
    rirEnd: integer().notNull().default(1),
    endedAt: ms(),
  },
  (t) => [
    index("ix_training_blocks_user_id").on(t.userId),
    check("ck_block_weeks", sql`${t.weeks} BETWEEN 3 AND 8`),
    check("ck_block_rir", sql`${t.rirStart} BETWEEN 0 AND 5 AND ${t.rirEnd} BETWEEN 0 AND 5`),
  ],
);

export const readiness = sqliteTable(
  "readiness",
  {
    ...base(),
    userId: userFk(),
    day: text().notNull(),
    sleep: integer().notNull(),
    energy: integer().notNull(),
    soreness: integer().notNull(),
  },
  (t) => [
    unique("uq_readiness_day").on(t.userId, t.day),
    check(
      "ck_readiness_range",
      sql`${t.sleep} BETWEEN 1 AND 5 AND ${t.energy} BETWEEN 1 AND 5 AND ${t.soreness} BETWEEN 1 AND 5`,
    ),
  ],
);

export const weekReflections = sqliteTable(
  "week_reflections",
  {
    ...base(),
    userId: userFk(),
    weekStart: text().notNull(),
    wentWell: text(),
    change: text(),
  },
  (t) => [unique("uq_reflection_week").on(t.userId, t.weekStart)],
);

export const exerciseNotes = sqliteTable(
  "exercise_notes",
  {
    ...base(),
    userId: userFk(),
    exerciseId: text().notNull(),
    note: text().notNull(),
  },
  (t) => [unique("uq_exercise_note").on(t.userId, t.exerciseId)],
);

export const weightGoals = sqliteTable(
  "weight_goals",
  {
    ...base(),
    userId: userFk(),
    targetKg: real().notNull(),
    startKg: real().notNull(),
    milestoneKg: real().notNull().default(2),
    setOn: text().notNull(),
  },
  (t) => [uniqueIndex("uq_weight_goals_user_id").on(t.userId)],
);

export type PlanSession = {
  day: number;
  discipline: string;
  title?: string | null;
  minutes?: number | null;
  distance_km?: number | null;
  routine_id?: string | null;
  note?: string | null;
};

export const trainingPlans = sqliteTable(
  "training_plans",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    description: text(),
    templateId: text(),
    weeks: json<PlanSession[][]>().notNull().default([]),
    /** Week-start date of week one. */
    startedOn: text(),
    challengeId: text().references(() => challenges.id, { onDelete: "set null" }),
    assignedBy: text().references(() => users.id, { onDelete: "set null" }),
    finishedAt: ms(),
    repeat: bool().notNull().default(false),
  },
  (t) => [
    index("ix_training_plans_user_started").on(t.userId, t.startedOn),
    index("ix_training_plans_challenge_id").on(t.challengeId),
    index("ix_training_plans_assigned_by").on(t.assignedBy),
  ],
);

export const monthlyGoals = sqliteTable(
  "monthly_goals",
  {
    ...base(),
    userId: userFk(),
    month: text().notNull(),
    days: integer().notNull(),
  },
  (t) => [
    unique("uq_monthly_goal").on(t.userId, t.month),
    check("ck_monthly_goal_days", sql`${t.days} BETWEEN 1 AND 31`),
  ],
);

export const REST_DAY_KINDS = ["rest", "sleep", "mobility", "sick"] as const;

export const restDays = sqliteTable(
  "rest_days",
  {
    ...base(),
    userId: userFk(),
    day: text().notNull(),
    kind: text({ enum: REST_DAY_KINDS }).notNull().default("rest"),
    note: text(),
  },
  (t) => [unique("uq_rest_day").on(t.userId, t.day), enumCheck("ck_rest_day_kind", t.kind, REST_DAY_KINDS)],
);
