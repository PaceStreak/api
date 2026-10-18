/**
 * Response schemas for the golden endpoints, each `satisfies z.ZodType<AppType>` against the app's own types
 * (app-types.ts, vendored by scripts/extract-app-routes.ts). `pnpm typecheck` therefore fails when a schema drifts
 * from what the app declares, and the golden test fails when a response drifts from its schema.
 *
 * Fields the app marks optional are required here when the API always sends them, so a dropped key is caught.
 * Objects are not strict: an extra key the app ignores is not a contract break (the golden shape still sees it).
 */
import * as z from "zod";
import type * as app from "./app-types.ts";

const str = z.string();
const num = z.number();
const bool = z.boolean();
const nstr = str.nullable();
const nnum = num.nullable();
const date = z.iso.date();
/** Wire timestamps are `toISOString()` (DESIGN.md §19 item 10). */
const ts = z.iso.datetime({ offset: false });
const nts = ts.nullable();
const strs = z.array(str);

const weekStatus = z.enum(["kept", "frozen", "repaired", "paused", "missed", "open"]);
const weekRow = z.object({ week_start: date, days: num, target: num, status: str, score: num });

export const Profile = z.object({
  handle: nstr,
  display_name: nstr,
  official: bool,
  bio: nstr,
  avatar_hue: num,
  timezone: str,
  week_starts_on: num,
  weight_unit: z.enum(["kg", "lb"]),
  distance_unit: z.enum(["km", "mi"]),
  training_days: nnum,
  max_hr: nnum,
  onboarded_at: nts,
  life_target: nnum,
  favourite_disciplines: strs,
  birth_year: nnum,
  onboarded: bool,
  visibility: z.enum(["private", "followers", "public"]),
  sharing_paused: bool,
  gamification_enabled: bool,
  leaderboard_opt_in: bool,
  social_suspended: bool,
  deletion_scheduled_at: nts,
  reminder_hour: num,
  reminder_mode: z.enum(["fixed", "smart"]),
  learned_reminder_hour: nnum,
  quiet_start: num,
  quiet_end: num,
  quiet_days: nnum,
}) satisfies z.ZodType<app.Profile>;

export const Me = z.object({
  user: z.object({
    id: str,
    email: str,
    is_verified: bool,
    role: z.enum(["user", "moderator", "admin"]),
    totp_enabled: bool,
  }),
  profile: Profile,
  needs_onboarding: bool,
  needs_terms: bool,
  terms_version: str,
  social_allowed: bool,
  min_age: num,
  social_min_age: num,
  unread_notifications: num,
  follow_requests: num,
  push_public_key: nstr,
}) satisfies z.ZodType<app.Me>;

const RoutineItem = z.object({
  exercise_id: str,
  sets: num,
  reps_min: nnum,
  reps_max: nnum,
  rest_sec: nnum,
  target_rpe: nnum,
  weight_kg: nnum.exactOptional(),
  increment_kg: nnum.exactOptional(),
  note: nstr,
}) satisfies z.ZodType<app.RoutineItem>;

export const Exercise = z.object({
  id: str,
  name: str,
  pattern: str,
  equipment: str,
  primary: strs,
  secondary: strs,
  load_type: z.enum(["weight", "bodyweight", "weighted_bw", "time"]),
  rest_sec: num,
  cue: nstr,
  unilateral: bool,
  aliases: strs,
  custom: bool,
  archived: bool.exactOptional(),
}) satisfies z.ZodType<app.Exercise>;

export const Library = z.object({
  version: num,
  disciplines: z.array(z.object({ id: str, name: str, emoji: str, metrics: strs, verb: str })),
  muscles: z.record(str, str),
  patterns: z.record(str, str),
  equipment: z.record(str, str),
  exercises: z.array(Exercise),
  templates: z.array(
    z.object({ id: str, name: str, discipline: str, summary: str, items: z.array(RoutineItem) }),
  ),
}) satisfies z.ZodType<app.Library>;

const WorkoutSet = z.object({
  exercise_id: str,
  position: num,
  set_index: num,
  kind: z.enum(["work", "warmup", "drop", "failure"]),
  weight_kg: nnum,
  reps: nnum,
  rpe: nnum,
  duration_sec: nnum,
  distance_m: nnum,
  completed: bool,
  superset: nnum,
}) satisfies z.ZodType<app.WorkoutSet>;

export const Workout = z.object({
  id: str,
  discipline: str,
  title: nstr,
  notes: nstr,
  started_at: ts,
  local_date: date,
  duration_sec: nnum,
  distance_m: nnum,
  elevation_m: nnum,
  effort: nnum,
  feel: nnum,
  routine_id: nstr,
  tags: strs,
  gear_id: nstr,
  gym_id: nstr,
  soreness: nnum,
  pump: nnum,
  avg_hr: nnum,
  max_hr: nnum,
  hr_zones: z.array(num).exactOptional(),
  splits: z.array(z.object({ m: num, sec: num })).exactOptional(),
  source: str,
  client_updated_at: ts,
  deleted_at: nts,
  seq: num,
  sets: z.array(WorkoutSet),
}) satisfies z.ZodType<app.Workout>;

export const Changes = z.object({ workouts: z.array(Workout), cursor: num, more: bool }) satisfies z.ZodType<{
  workouts: app.Workout[];
  cursor: number;
  more: boolean;
}>;

const WeekCell = z.object({ week_start: date, days: num, target: num, status: weekStatus, score: num });

export const Chain = z.object({
  id: str,
  name: str,
  disciplines: strs,
  target: num,
  current: num,
  longest: num,
  freezes_available: num,
  this_week_days: num,
  this_week_target: num,
  days_left: num,
  needed: num,
  at_risk: bool,
  will_freeze: bool,
  repairable_week: nstr,
  run_started: nstr,
  consistency: num,
  consistency_12: num,
  consistency_52: num,
  paused_now: bool,
  requirements: z.array(z.object({ disciplines: strs, days: num, done: num })),
  weeks: z.array(WeekCell),
}) satisfies z.ZodType<app.Chain>;

export const Chains = z.object({ chains: z.array(Chain) }) satisfies z.ZodType<{ chains: app.Chain[] }>;

const Pause = z.object({
  id: str,
  starts_on: date,
  ends_on: date.nullable(),
  effective_end: date,
  reason: z.enum(["injury", "illness", "travel", "life", "other"]),
  note: nstr,
  active: bool,
  upcoming: bool,
}) satisfies z.ZodType<app.Pause>;

export const PauseState = z.object({
  pauses: z.array(Pause),
  budget: z.object({ days_used: num, days_allowed: num }),
}) satisfies z.ZodType<app.PauseState>;

const Quest = z.object({ id: str, title: str, description: str, goal: num, progress: num, done: bool });
const Wager = z.object({ week_start: date, days: num, done: nnum, status: z.enum(["open", "won", "lost"]) });

export const Stats = z.object({
  today: date,
  week_starts_on: num,
  gamification_enabled: bool,
  level: z.object({ level: num, title: str, total_xp: num, into_level: num, level_span: num, to_next: num }),
  xp: z.object({ total: num, season: num, by_source: z.record(str, num) }),
  season: z.object({ id: str, starts_on: date, ends_on: date }),
  chains: z.array(Chain),
  repair_available: bool,
  paused_today: bool,
  pauses: z.array(Pause),
  training_days: nnum,
  heatmap: z.array(z.object({ date, level: num, sessions: num, disciplines: strs })),
  totals: z.object({
    sessions: num,
    active_days: num,
    hours: num,
    distance_km: num,
    tonnage_kg: num,
    records: num,
    disciplines: num,
    exercises: num,
  }),
  last_active: nstr,
  quests: z
    .object({ week_start: date, xp_each: num, paused: bool, items: z.array(Quest), completed_total: num })
    .nullable(),
  pr_streak: z.object({ current: num, longest: num, this_block_has_pr: bool, block_ends: date }).nullable(),
  wager: z.object({
    current: Wager.nullable(),
    next: Wager.nullable(),
    last: Wager.nullable(),
    options: z.array(
      z.object({ week: z.enum(["this", "next"]), week_start: date, days: num, blocked: nstr }),
    ),
    freezes_available: num,
  }),
  life: z
    .object({
      target: num,
      current: num,
      longest: num,
      this_week_days: num,
      needed: num,
      days_left: num,
      freezes_available: num,
      weeks: z.array(weekRow),
    })
    .nullable(),
  habits: z.object({ count: num, done_today: num, kept_this_week: num }),
}) satisfies z.ZodType<app.Stats>;

const habitDay = z.object({ date, amount: num, note: nstr });
const habitFields = {
  id: str,
  name: str,
  emoji: str,
  category: str,
  kind: z.enum(["check", "duration", "count", "quit"]),
  unit: nstr,
  daily_goal: nnum,
  weekly_target: num,
  time_of_day: z.enum(["morning", "afternoon", "evening", "anytime"]),
  cue: nstr,
  why: nstr,
  total_goal: nnum,
  remind_hour: nnum,
  days_mask: nnum,
  scheduled_today: bool,
  paused: bool,
  paused_from: date.nullable(),
  paused_until: date.nullable(),
  snoozed_until: nts,
  template_id: nstr,
  started_on: date,
  archived: bool,
  position: num,
  today: z.object({ amount: num, done: bool }),
  streak: z.object({
    current: num,
    longest: num,
    this_week_days: num,
    this_week_target: num,
    needed: num,
    days_left: num,
    at_risk: bool,
    freezes_available: num,
    consistency: num,
  }),
  strength: num,
  total: num,
  clean_run: nnum,
  best_clean_run: nnum,
  last_slip: date.nullable(),
};

/** A list row: carries `recent`, the last seven days. */
export const HabitListRow = z.object({
  ...habitFields,
  recent: z.array(habitDay),
}) satisfies z.ZodType<app.Habit>;
/** The detail view: `days` and `weeks`. */
export const HabitDetail = z.object({
  ...habitFields,
  days: z.array(habitDay),
  weeks: z.array(weekRow),
}) satisfies z.ZodType<app.Habit>;
export const HabitCreated = z.object(habitFields) satisfies z.ZodType<app.Habit>;

export const HabitStats = z.object({
  weeks: z.array(weekRow),
  weeks_counted: num,
  weeks_kept: num,
  keep_rate: num,
}) satisfies z.ZodType<app.HabitStats>;

export const HabitCatalog = z.object({
  categories: z.record(str, str),
  templates: z.array(
    z.object({
      id: str,
      name: str,
      emoji: str,
      category: str,
      kind: z.enum(["check", "duration", "count", "quit"]),
      blurb: str,
      unit: nstr,
      daily_goal: nnum,
      weekly_target: num,
      time_of_day: z.enum(["morning", "afternoon", "evening", "anytime"]),
      cue: nstr,
      total_goal: nnum,
    }),
  ),
}) satisfies z.ZodType<{ categories: Record<string, string>; templates: app.HabitTemplate[] }>;

export const HabitRoutine = z.object({
  id: str,
  name: str,
  emoji: str,
  time_of_day: z.enum(["morning", "afternoon", "evening", "anytime"]),
  habit_ids: strs,
}) satisfies z.ZodType<app.HabitRoutine>;

export const Gym = z.object({
  id: str,
  name: str,
  equipment: strs,
  plates_kg: z.array(num),
  bar_kg: num,
  is_default: bool,
}) satisfies z.ZodType<app.Gym>;

export const Gear = z.object({
  id: str,
  name: str,
  kind: z.enum(["shoes", "bike", "other"]),
  default_for: strs,
  limit_km: nnum,
  initial_km: num,
  distance_m: num,
  sessions: num,
  last_used: nstr,
  worn: nnum,
  retired: bool,
  retired_at: nstr,
  note: nstr,
}) satisfies z.ZodType<app.Gear>;

export const Routine = z.object({
  id: str,
  name: str,
  discipline: str,
  notes: nstr,
  items: z.array(RoutineItem),
  position: num,
  last_used_at: nts,
  updated_at: nts,
}) satisfies z.ZodType<app.Routine>;

const planSummaryFields = {
  id: str,
  name: str,
  description: nstr,
  template_id: nstr,
  weeks_count: num,
  sessions_count: num,
  started_on: date.nullable(),
  finished_at: nstr,
  active: bool,
  repeat: bool,
};
export const PlanSummary = z.object(planSummaryFields) satisfies z.ZodType<app.PlanSummary>;

const PlanSession = z.object({
  day: num,
  discipline: str,
  title: str,
  minutes: nnum.exactOptional(),
  distance_km: nnum.exactOptional(),
  routine_id: nstr.exactOptional(),
  note: nstr.exactOptional(),
  date: date.exactOptional(),
  status: z.enum(["done", "today", "upcoming", "skipped"]).exactOptional(),
  moved: bool.exactOptional(),
}) satisfies z.ZodType<app.PlanSession>;

export const Plan = z.object({
  ...planSummaryFields,
  weeks: z.array(z.array(PlanSession)),
  current_week: nnum,
  today: z.array(PlanSession),
  progress: z.object({ done: num, due: num, total: num }).nullable(),
  cycle: num.exactOptional(),
}) satisfies z.ZodType<app.Plan>;

export const PlanTemplate = z.object({
  id: str,
  name: str,
  summary: str,
  weeks_count: num,
  per_week: num,
  disciplines: strs,
  equipment: strs,
}) satisfies z.ZodType<app.PlanTemplate>;

export const WeighIn = z.object({
  id: str,
  weighed_at: ts,
  date,
  moment: z.enum(["waking", "pre_workout", "post_workout", "bedtime", "other"]),
  weight_kg: num,
  note: nstr,
}) satisfies z.ZodType<app.WeighIn>;

export const BodyMetric = z.object({
  date,
  body_fat_pct: nnum,
  waist_cm: nnum,
  resting_hr: nnum,
  sleep_hours: nnum,
  neck_cm: nnum,
  shoulders_cm: nnum,
  chest_cm: nnum,
  arm_cm: nnum,
  forearm_cm: nnum,
  hips_cm: nnum,
  thigh_cm: nnum,
  calf_cm: nnum,
  note: nstr,
}) satisfies z.ZodType<app.BodyMetric>;

export const WeightGoal = z
  .object({ target_kg: num, start_kg: num, milestone_kg: num, set_on: date })
  .nullable() satisfies z.ZodType<app.WeightGoal | null>;

export const Readiness = z.object({
  date,
  sleep: num,
  energy: num,
  soreness: num,
}) satisfies z.ZodType<app.ReadinessEntry>;

export const Reflection = z.object({
  week_start: date,
  went_well: nstr,
  change: nstr,
}) satisfies z.ZodType<app.Reflection>;

const macros = { kcal: num, protein_g: num, carbs_g: num, fat_g: num };
const MealEntry = z.object({
  ...macros,
  id: str,
  date,
  meal: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  name: str,
  food_id: nstr,
  servings: num,
}) satisfies z.ZodType<app.MealEntry>;

export const NutritionDay = z.object({
  date,
  entries: z.array(MealEntry),
  totals: z.object(macros),
  target: z.object({ kcal: nnum, protein_g: nnum, carbs_g: nnum, fat_g: nnum }).nullable(),
}) satisfies z.ZodType<app.NutritionDay>;

export const Food = z.object({
  ...macros,
  id: str,
  name: str,
  brand: nstr,
  barcode: nstr,
  serving_label: nstr,
}) satisfies z.ZodType<app.Food>;

export const RecentFood = z.object({
  ...macros,
  name: str,
  food_id: nstr,
  times: num,
}) satisfies z.ZodType<app.RecentFood>;

export const Recipe = z.object({
  ...macros,
  id: str,
  name: str,
  serves: num,
  items: z.array(z.object({ food_id: str, name: str, servings: num })),
}) satisfies z.ZodType<app.Recipe>;

export const NutritionHistory = z.array(z.object({ ...macros, date })) satisfies z.ZodType<
  (app.Macros & { date: string })[]
>;

export const Expenditure = z.object({
  window_days: num,
  status: z.enum(["ok", "not_enough", "inconsistent"]),
  food_days: num,
  weigh_days: num,
  tdee: nnum,
  avg_intake: nnum,
  trend_kg_per_week: nnum,
  trend_kg: nnum,
  confidence: z.enum(["low", "good"]).nullable(),
  suggestion: z
    .object({ goal: z.enum(["lose", "gain", "maintain"]), kcal: num, rate_kg_per_week: num })
    .nullable(),
}) satisfies z.ZodType<app.Expenditure>;

export const CoachToday = z.object({
  notes: z.array(
    z.object({ kind: str, tone: z.enum(["nudge", "praise", "rest", "info"]), title: str, body: str }),
  ),
}) satisfies z.ZodType<{ notes: app.CoachNote[] }>;

export const JournalDay = z.object({ date, mood: nnum, note: nstr }) satisfies z.ZodType<app.JournalDay>;

export const Insights = z.object({
  window_days: num,
  insights: z.array(
    z.object({
      driver: str,
      outcome: str,
      text: str,
      high: num,
      low: num,
      days_high: num,
      days_low: num,
      strength: num,
    }),
  ),
  coverage: z.record(str, num),
}) satisfies z.ZodType<app.Insights>;

export const Search = z.object({
  results: z.array(
    z.object({
      kind: z.enum(["habit", "habit_note", "workout", "journal", "food", "recipe"]),
      id: str,
      title: str,
      detail: nstr,
      date: date.exactOptional(),
      url: str,
    }),
  ),
}) satisfies z.ZodType<{ results: app.SearchResult[] }>;

export const DayView = z.object({
  date,
  workouts: z.array(
    z.object({ id: str, title: nstr, discipline: str, duration_sec: nnum, distance_m: nnum }),
  ),
  habits: z.array(
    z.object({
      id: str,
      name: str,
      emoji: str,
      kind: z.enum(["check", "duration", "count", "quit"]),
      unit: nstr,
      amount: num,
      note: nstr,
      done: bool,
    }),
  ),
  food: z.object({
    meals: z.array(
      z.object({
        meal: z.enum(["breakfast", "lunch", "dinner", "snack"]),
        count: num,
        kcal: num,
        protein_g: num,
      }),
    ),
    kcal: num,
    protein_g: num,
  }),
  journal: z.object({ mood: nnum, note: nstr }).nullable(),
  readiness: z.object({ sleep: num, energy: num, soreness: num }).nullable(),
  rest: z.object({ kind: str, note: nstr }).nullable(),
  weigh_ins: z.array(z.object({ weight_kg: num, moment: str })),
}) satisfies z.ZodType<app.DayView>;

export const Notifications = z.object({
  items: z.array(
    z.object({
      id: str,
      kind: str,
      category: str,
      title: str,
      body: nstr,
      url: nstr,
      read: bool,
      created_at: ts,
      actor: z.object({ handle: nstr, display_name: nstr, avatar_hue: num }).nullable(),
    }),
  ),
  next: nstr,
}) satisfies z.ZodType<{ items: app.Notification[]; next: string | null }>;

export const Person = z.looseObject({
  id: str,
  handle: str,
  display_name: nstr,
  avatar_hue: num,
  visibility: z.enum(["private", "followers", "public"]),
  official: bool.exactOptional(),
  level: num.exactOptional(),
  current_streak: num.exactOptional(),
}) satisfies z.ZodType<app.Person>;

const reaction = z.enum(["kudos", "fire", "strong", "star", "heart"]);
export const FeedEvent = z.object({
  id: str,
  kind: z.enum(["workout", "pr", "streak", "achievement", "level", "challenge"]),
  data: z.record(str, z.unknown()),
  date,
  created_at: ts,
  author: Person,
  kudos: num,
  comments: num,
  kudoed: bool,
  mine: bool,
  kudos_by: z.array(Person).exactOptional(),
  reactions: z.partialRecord(reaction, num),
  my_reaction: reaction.nullable(),
}) satisfies z.ZodType<app.FeedEvent>;

export const FeedPage = z.object({ events: z.array(FeedEvent), next: nstr }) satisfies z.ZodType<{
  events: app.FeedEvent[];
  next: string | null;
}>;

const groupFields = {
  id: str,
  name: str,
  description: nstr,
  kind: z.enum(["crew", "coaching"]),
  avatar_hue: num,
  member_count: num,
  my_role: z.enum(["owner", "admin", "coach", "member"]).nullable(),
  shares_with_coach: bool,
  muted: bool,
  streak_threshold: num,
  streak: z.object({
    current: num,
    longest: num,
    threshold: num,
    weeks: z.array(z.enum(["kept", "missed", "paused", "open"])),
    this_week: z.object({ kept: num, counted: num }).nullable(),
  }),
  invite_code: nstr,
};
/** The list leaves the streak out (it needs every member's weeks); the detail carries it. */
export const GroupRow = z.object({
  ...groupFields,
  streak: groupFields.streak.exactOptional(),
}) satisfies z.ZodType<app.Group>;
export const Group = z.object({
  ...groupFields,
  members: z.array(
    z.looseObject({
      ...Person.shape,
      role: str,
      this_week_days: num,
      this_week_target: nnum,
      consistency: num,
      last_active: nstr,
      shares_with_coach: bool.nullable(),
    }),
  ),
}) satisfies z.ZodType<app.Group>;

const challengeFields = {
  id: str,
  title: str,
  description: nstr,
  kind: z.enum(["active_days", "weekly_target", "plan_sessions"]),
  plan_name: nstr.exactOptional(),
  target: nnum,
  disciplines: strs,
  starts_on: date,
  ends_on: date,
  group_id: nstr,
  status: z.enum(["upcoming", "live", "finished"]),
  joined: bool,
  is_creator: bool,
  invite_code: nstr,
  participants: nnum,
};
export const ChallengeRow = z.object(challengeFields) satisfies z.ZodType<app.Challenge>;
export const Challenge = z.object({
  ...challengeFields,
  leaderboard: z.array(z.looseObject({ ...Person.shape, score: num, rank: num, completed: bool })),
  days_total: num,
  days_elapsed: num,
}) satisfies z.ZodType<app.Challenge>;

export const Achievements = z.object({
  achievements: z.array(
    z.object({
      id: str,
      title: str,
      description: str,
      category: str,
      hidden: bool,
      secret: bool,
      tiered: bool,
      unit: str,
      thresholds: z.array(num),
      tier_names: strs,
      unlocked: z.record(str, str),
      progress: z.object({ value: num, next: nnum, max: num }).nullable(),
      rarity: z.record(str, num),
    }),
  ),
  unlocked_count: num,
}) satisfies z.ZodType<{ achievements: app.Achievement[]; unlocked_count: number }>;

const RecordRow = z.object({
  key: str,
  kind: str,
  subject: str,
  label: str,
  value: num,
  previous: nnum,
  gain_pct: nnum,
  date,
  workout_id: nstr,
  flagged: bool,
  rewarded: bool,
}) satisfies z.ZodType<app.RecordRow>;

export const Records = z.object({
  current: z.array(RecordRow),
  recent: z.array(RecordRow),
}) satisfies z.ZodType<{
  current: app.RecordRow[];
  recent: app.RecordRow[];
}>;

export const Recap = z.object({
  week_start: date,
  week_end: date,
  status: weekStatus,
  verdict: str,
  days: num,
  target: num,
  sessions: num,
  trained_on: strs,
  disciplines: z.array(z.object({ id: str, name: str, sessions: num })),
  previous_days: nnum,
  streak: num,
  longest: num,
  freezes_available: num,
  records: z.array(z.object({ label: str, day: str })),
  badges: z.array(z.object({ id: str, title: str, tier: nstr })),
  this_week_target: num,
}) satisfies z.ZodType<app.Recap>;

export const MonthRecap = z.object({
  month: str,
  starts_on: date,
  ends_on: date,
  complete: bool,
  sessions: num,
  active_days: num,
  weeks_kept: num,
  weeks: num,
  records: num,
  lifts: z.array(
    z.object({
      exercise_id: str,
      name: str,
      sessions: num,
      best_e1rm: num,
      previous_best: nnum,
      change_pct: nnum,
    }),
  ),
  steadiest: nstr,
  pr_streak: num,
}) satisfies z.ZodType<app.MonthRecap>;

const Badge = z.object({
  id: str,
  title: str,
  tier: z.enum(["bronze", "silver", "gold"]).nullable(),
  tier_name: nstr,
  hidden: bool,
  description: str,
});
export const Outcome = z.object({
  level: num,
  title: str,
  total_xp: num,
  xp_gained: num,
  leveled_up_to: nnum,
  new_achievements: z.array(Badge),
  new_records: z.array(z.object({ key: str, label: str, value: num, previous: num, gain_pct: num })),
  streak: z.object({ current: num, this_week_days: num, target: num, milestone: nnum }),
}) satisfies z.ZodType<app.Outcome>;

export const BatchResult = z.object({
  results: z.array(
    z.object({
      id: str,
      ok: bool,
      applied: bool.exactOptional(),
      workout: Workout.exactOptional(),
      detail: str.exactOptional(),
      status: num.exactOptional(),
    }),
  ),
  outcome: Outcome.nullable(),
}) satisfies z.ZodType<{
  results: {
    id: string;
    ok: boolean;
    applied?: boolean;
    workout?: app.Workout;
    detail?: string;
    status?: number;
  }[];
  outcome: app.Outcome | null;
}>;

/** src/routes/Trash.tsx `TrashItem` (declared in the screen, not in types.ts). */
export const TrashItem = z.object({
  id: str,
  kind: z.enum(["habit", "meal", "food", "recipe", "journal", "habit_routine", "workout"]),
  item_id: str,
  label: str,
  deleted_at: ts,
  purge_after: ts,
});
