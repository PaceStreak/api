// Vendored from PaceStreak/app src/lib/types.ts by scripts/extract-app-routes.ts. Do not edit by hand.
// Shapes returned by api.pacestreak.com /v1. Kept by hand next to the code
// that renders them; the API is the source of truth.

export type Visibility = "private" | "followers" | "public";

export interface Profile {
  handle: string | null;
  display_name: string | null;
  /** Set only by an admin; the brand's own account. */
  official: boolean;
  bio: string | null;
  avatar_hue: number;
  timezone: string;
  week_starts_on: number;
  weight_unit: "kg" | "lb";
  distance_unit: "km" | "mi";
  training_days: number | null;
  /** For heart-rate zones; null means estimated from the birth year. */
  max_hr?: number | null;
  onboarded_at?: string | null;
  /** Days a week for the whole-life streak; null means it's off. */
  life_target?: number | null;
  /** Picked at onboarding; biases the log sheet's suggestion ordering until history takes over. */
  favourite_disciplines?: string[];
  birth_year: number | null;
  onboarded: boolean;
  visibility: Visibility;
  sharing_paused: boolean;
  gamification_enabled: boolean;
  leaderboard_opt_in: boolean;
  social_suspended: boolean;
  deletion_scheduled_at: string | null;
  reminder_hour: number;
  reminder_mode?: "fixed" | "smart";
  learned_reminder_hour?: number | null;
  quiet_start: number;
  quiet_end: number;
  /** Whole days without nudges, Monday = bit 0. */
  quiet_days?: number | null;
}

export interface Me {
  user: { id: string; email: string; is_verified: boolean; role: "user" | "moderator" | "admin"; totp_enabled: boolean };
  profile: Profile;
  needs_onboarding: boolean;
  /** Onboarded under an older version of the terms. */
  needs_terms?: boolean;
  terms_version?: string;
  social_allowed: boolean;
  min_age: number;
  social_min_age: number;
  unread_notifications: number;
  follow_requests: number;
  push_public_key: string | null;
}

export interface Discipline {
  id: string;
  name: string;
  emoji: string;
  metrics: string[];
  verb: string;
}

export interface Exercise {
  id: string;
  name: string;
  pattern: string;
  equipment: string;
  primary: string[];
  secondary: string[];
  load_type: "weight" | "bodyweight" | "weighted_bw" | "time";
  rest_sec: number;
  cue: string | null;
  unilateral: boolean;
  aliases: string[];
  custom: boolean;
  archived?: boolean;
}

export interface RoutineItem {
  exercise_id: string;
  sets: number;
  reps_min: number | null;
  reps_max: number | null;
  rest_sec: number | null;
  target_rpe: number | null;
  /** Starting weight in kg, for a movement with no history yet. */
  weight_kg?: number | null;
  /** Load added when progression says go up, in kg. Default 2.5 kg / 5 lb. */
  increment_kg?: number | null;
  note: string | null;
}

export interface Template {
  id: string;
  name: string;
  discipline: string;
  summary: string;
  items: RoutineItem[];
}

export interface Library {
  version: number;
  disciplines: Discipline[];
  muscles: Record<string, string>;
  patterns: Record<string, string>;
  equipment: Record<string, string>;
  exercises: Exercise[];
  templates: Template[];
}

export type SetKind = "work" | "warmup" | "drop" | "failure";

export interface WorkoutSet {
  exercise_id: string;
  position: number;
  set_index: number;
  kind: SetKind;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  duration_sec: number | null;
  distance_m: number | null;
  completed: boolean;
  /** Exercises sharing a number are a superset. */
  superset?: number | null;
}

export interface Workout {
  id: string;
  discipline: string;
  title: string | null;
  notes: string | null;
  started_at: string;
  local_date: string;
  duration_sec: number | null;
  distance_m: number | null;
  elevation_m: number | null;
  effort: number | null;
  feel: number | null;
  routine_id: string | null;
  /** Private labels, lowercase slugs: "hills", "with-sam". */
  tags?: string[];
  gear_id?: string | null;
  gym_id?: string | null;
  /** After-session check-in: soreness carried in (0-3), pump (0-2). */
  soreness?: number | null;
  pump?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  /** Seconds in heart-rate zones 1-5. */
  hr_zones?: number[];
  /** Per-kilometre times from an imported track. */
  splits?: { m: number; sec: number }[];
  source: string;
  client_updated_at: string;
  deleted_at: string | null;
  seq?: number;
  sets: WorkoutSet[];
  /** Local-only: saved on this device, not yet confirmed by the server. */
  _pending?: boolean;
  _error?: string | null;
}

export interface WeekCell {
  week_start: string;
  days: number;
  target: number;
  status: "kept" | "frozen" | "repaired" | "paused" | "missed" | "open";
  score: number;
}

export interface Chain {
  id: string;
  name: string;
  disciplines: string[];
  target: number;
  current: number;
  longest: number;
  freezes_available: number;
  this_week_days: number;
  this_week_target: number;
  days_left: number;
  needed: number;
  at_risk: boolean;
  will_freeze: boolean;
  repairable_week: string | null;
  run_started: string | null;
  consistency: number;
  consistency_12: number;
  consistency_52: number;
  /** The current week is sheltered by a pause. */
  paused_now: boolean;
  /** This week's compound goals: at least `days` days on these disciplines. */
  requirements: { disciplines: string[]; days: number; done: number }[];
  weeks: WeekCell[];
}

export type PauseReason = "injury" | "illness" | "travel" | "life" | "other";

export interface Pause {
  id: string;
  starts_on: string;
  /** Inclusive; null while open-ended. */
  ends_on: string | null;
  /** When it actually stops sheltering weeks (open pauses are capped). */
  effective_end: string;
  reason: PauseReason;
  note: string | null;
  active: boolean;
  upcoming: boolean;
}

export interface PauseState {
  pauses: Pause[];
  budget: { days_used: number; days_allowed: number };
}

export interface Recap {
  week_start: string;
  week_end: string;
  status: WeekCell["status"];
  verdict: string;
  days: number;
  target: number;
  sessions: number;
  trained_on: string[];
  disciplines: { id: string; name: string; sessions: number }[];
  previous_days: number | null;
  streak: number;
  longest: number;
  freezes_available: number;
  records: { label: string; day: string }[];
  badges: { id: string; title: string; tier: string | null }[];
  this_week_target: number;
}

export interface FileImportResult {
  format: "gpx" | "fit" | "csv" | "strong" | "hevy" | "fitnotes";
  found: number;
  imported: number;
  duplicates: number;
  /** Lifting-app imports: sets brought in, and names that became custom exercises. */
  sets?: number;
  new_exercises?: string[];
  problems: string[];
  more_problems: number;
}

export interface LevelInfo {
  level: number;
  title: string;
  total_xp: number;
  into_level: number;
  level_span: number;
  to_next: number;
}

export interface HeatDay {
  date: string;
  level: number;
  sessions: number;
  disciplines: string[];
}

export interface Stats {
  today: string;
  week_starts_on: number;
  gamification_enabled: boolean;
  level: LevelInfo;
  xp: { total: number; season: number; by_source: Record<string, number> };
  season: { id: string; starts_on: string; ends_on: string };
  chains: Chain[];
  repair_available: boolean;
  paused_today: boolean;
  pauses: Pause[];
  training_days: number | null;
  heatmap: HeatDay[];
  totals: {
    sessions: number;
    active_days: number;
    hours: number;
    distance_km: number;
    tonnage_kg: number;
    records: number;
    disciplines: number;
    exercises: number;
  };
  last_active: string | null;
  /** Null when gamification is off. */
  quests?: QuestWeek | null;
  pr_streak?: PrStreak | null;
  wager?: WagerState;
  life?: LifeStreak | null;
  habits?: { count: number; done_today: number; kept_this_week: number };
}

export interface LifeStreak {
  target: number;
  current: number;
  longest: number;
  this_week_days: number;
  needed: number;
  days_left: number;
  freezes_available: number;
  weeks: { week_start: string; days: number; target: number; status: string; score: number }[];
}

export type HabitKind = "check" | "duration" | "count" | "quit";
export type TimeOfDay = "morning" | "afternoon" | "evening" | "anytime";

export interface Habit {
  id: string;
  name: string;
  emoji: string;
  category: string;
  kind: HabitKind;
  unit: string | null;
  daily_goal: number | null;
  weekly_target: number;
  time_of_day: TimeOfDay;
  cue: string | null;
  why: string | null;
  total_goal: number | null;
  remind_hour: number | null;
  /** Planned weekdays, Monday = bit 0; null = any day. */
  days_mask?: number | null;
  scheduled_today?: boolean;
  paused?: boolean;
  paused_from?: string | null;
  paused_until?: string | null;
  /** A snoozed reminder comes back at this time, if still not done. */
  snoozed_until?: string | null;
  template_id: string | null;
  started_on: string;
  archived: boolean;
  position: number;
  today: { amount: number; done: boolean };
  streak: {
    current: number;
    longest: number;
    this_week_days: number;
    this_week_target: number;
    needed: number;
    days_left: number;
    at_risk: boolean;
    freezes_available: number;
    consistency: number;
  };
  strength: number;
  total: number;
  clean_run: number | null;
  best_clean_run: number | null;
  last_slip: string | null;
  /** Detail only. */
  days?: { date: string; amount: number; note?: string | null }[];
  /** The last seven days, oldest first; list responses only. */
  recent?: { date: string; amount: number; note?: string | null }[];
  weeks?: { week_start: string; days: number; target: number; status: string; score: number }[];
}

/** The small per-habit trend view: GET /habits/{id}/stats. */
export interface HabitStats {
  weeks: { week_start: string; days: number; target: number; status: string; score: number }[];
  weeks_counted: number;
  weeks_kept: number;
  keep_rate: number;
}

export interface HabitTemplate {
  id: string;
  name: string;
  emoji: string;
  category: string;
  kind: HabitKind;
  blurb: string;
  unit: string | null;
  daily_goal: number | null;
  weekly_target: number;
  time_of_day: TimeOfDay;
  cue: string | null;
  total_goal: number | null;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  goal: number;
  progress: number;
  done: boolean;
}

export interface QuestWeek {
  week_start: string;
  xp_each: number;
  paused: boolean;
  items: Quest[];
  completed_total: number;
}

export interface PrStreak {
  current: number;
  longest: number;
  this_block_has_pr: boolean;
  block_ends: string;
}

export interface Wager {
  week_start: string;
  days: number;
  done: number | null;
  status: "open" | "won" | "lost";
}

export interface WagerState {
  current: Wager | null;
  next: Wager | null;
  last: Wager | null;
  options: { week: "this" | "next"; week_start: string; days: number; blocked: string | null }[];
  freezes_available: number;
}

export interface Gym {
  id: string;
  name: string;
  equipment: string[];
  plates_kg: number[];
  bar_kg: number;
  is_default: boolean;
}

export interface WeightGoal {
  target_kg: number;
  start_kg: number;
  milestone_kg: number;
  set_on: string;
}

export interface MonthRecap {
  month: string;
  starts_on: string;
  ends_on: string;
  complete: boolean;
  sessions: number;
  active_days: number;
  weeks_kept: number;
  weeks: number;
  records: number;
  lifts: { exercise_id: string; name: string; sessions: number; best_e1rm: number; previous_best: number | null; change_pct: number | null }[];
  steadiest: string | null;
  pr_streak: number;
}

export interface Badge {
  id: string;
  title: string;
  tier: "bronze" | "silver" | "gold" | null;
  tier_name: string | null;
  hidden: boolean;
  description: string;
}

export interface NewRecord {
  key: string;
  label: string;
  value: number;
  previous: number;
  gain_pct: number;
}

export interface Outcome {
  level: number;
  title: string;
  total_xp: number;
  xp_gained: number;
  leveled_up_to: number | null;
  new_achievements: Badge[];
  new_records: NewRecord[];
  streak: { current: number; this_week_days: number; target: number; milestone: number | null };
}

export interface Person {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_hue: number;
  visibility: Visibility;
  official?: boolean;
  level?: number;
  current_streak?: number;
  [extra: string]: unknown;
}

export type Reaction = "kudos" | "fire" | "strong" | "star" | "heart";

export interface FeedEvent {
  id: string;
  kind: "workout" | "pr" | "streak" | "achievement" | "level" | "challenge";
  data: Record<string, unknown>;
  date: string;
  created_at: string;
  author: Person;
  kudos: number;
  comments: number;
  kudoed: boolean;
  mine: boolean;
  kudos_by?: Person[];
  /** How many of each preset reaction; every one also counts as kudos. */
  reactions?: Partial<Record<Reaction, number>>;
  my_reaction?: Reaction | null;
}

export interface Notification {
  id: string;
  kind: string;
  category: string;
  title: string;
  body: string | null;
  url: string | null;
  read: boolean;
  created_at: string;
  actor: { handle: string | null; display_name: string | null; avatar_hue: number } | null;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  kind: "crew" | "coaching";
  avatar_hue: number;
  member_count: number;
  my_role: "owner" | "admin" | "coach" | "member" | null;
  shares_with_coach: boolean;
  /** Push and email off for this group; the inbox still gets everything. */
  muted?: boolean;
  /** Share of members (%) who must keep their week for the group's to count. */
  streak_threshold?: number;
  streak?: {
    current: number;
    longest: number;
    threshold: number;
    weeks: ("kept" | "missed" | "paused" | "open")[];
    this_week: { kept: number; counted: number } | null;
  };
  invite_code: string | null;
  members?: (Person & {
    role: string;
    this_week_days: number;
    this_week_target: number | null;
    consistency: number;
    last_active: string | null;
    shares_with_coach: boolean | null;
  })[];
}

export interface Challenge {
  id: string;
  title: string;
  description: string | null;
  kind: "active_days" | "weekly_target" | "plan_sessions";
  /** For plan challenges: the plan everyone follows. */
  plan_name?: string | null;
  target: number | null;
  disciplines: string[];
  starts_on: string;
  ends_on: string;
  group_id: string | null;
  status: "upcoming" | "live" | "finished";
  joined: boolean;
  is_creator: boolean;
  invite_code: string | null;
  participants: number | null;
  leaderboard?: (Person & { score: number; rank: number; completed: boolean })[];
  days_total?: number;
  days_elapsed?: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  category: string;
  hidden: boolean;
  secret: boolean;
  tiered: boolean;
  unit: string;
  thresholds: number[];
  tier_names: string[];
  unlocked: Record<string, string>;
  progress: { value: number; next: number | null; max: number } | null;
  rarity: Record<string, number>;
}

export interface RecordRow {
  key: string;
  kind: string;
  subject: string;
  label: string;
  value: number;
  previous: number | null;
  gain_pct: number | null;
  date: string;
  workout_id: string | null;
  flagged: boolean;
  rewarded: boolean;
}

export type WeighInMoment = "waking" | "pre_workout" | "post_workout" | "bedtime" | "other";

export interface WeighIn {
  id: string;
  weighed_at: string;
  date: string;
  moment: WeighInMoment;
  weight_kg: number;
  note: string | null;
  /** Client only: saved on the device, waiting for signal. */
  pending?: boolean;
}

export interface BodyMetric {
  date: string;
  body_fat_pct: number | null;
  waist_cm: number | null;
  resting_hr: number | null;
  sleep_hours: number | null;
  neck_cm?: number | null;
  shoulders_cm?: number | null;
  chest_cm?: number | null;
  arm_cm?: number | null;
  forearm_cm?: number | null;
  hips_cm?: number | null;
  thigh_cm?: number | null;
  calf_cm?: number | null;
  note?: string | null;
}

export interface Routine {
  id: string;
  name: string;
  discipline: string;
  notes: string | null;
  items: RoutineItem[];
  position: number;
  last_used_at: string | null;
  updated_at: string | null;
}

export interface Gear {
  id: string;
  name: string;
  kind: "shoes" | "bike" | "other";
  default_for: string[];
  limit_km: number | null;
  initial_km: number;
  distance_m: number;
  sessions: number;
  last_used: string | null;
  /** Share of the replacement distance used, 0-1+. Null without a limit. */
  worn: number | null;
  retired: boolean;
  retired_at: string | null;
  note: string | null;
}

export interface PlanSession {
  day: number;
  discipline: string;
  title: string;
  minutes?: number | null;
  distance_km?: number | null;
  routine_id?: string | null;
  note?: string | null;
  /** Present once the plan is running and the week has begun. */
  date?: string;
  status?: "done" | "today" | "upcoming" | "skipped";
  moved?: boolean;
}

export interface PlanSummary {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  weeks_count: number;
  sessions_count: number;
  started_on: string | null;
  finished_at: string | null;
  active: boolean;
  /** Loops its weeks until stopped: a weekly schedule. */
  repeat: boolean;
}

export interface Plan extends PlanSummary {
  weeks: PlanSession[][];
  current_week: number | null;
  today: PlanSession[];
  progress: { done: number; due: number; total: number } | null;
  /** Which time round a repeating plan is on, from 1. */
  cycle?: number;
}

export interface PlanTemplate {
  id: string;
  name: string;
  summary: string;
  weeks_count: number;
  per_week: number;
  disciplines: string[];
  /** Equipment kinds the plan's routines use; empty when none is needed. */
  equipment?: string[];
}

export interface BlockWeek {
  week: number;
  weeks: number;
  deload: boolean;
  rir: number;
}

export interface TrainingBlock {
  id: string;
  name: string;
  starts_on: string;
  weeks: number;
  rir_start: number;
  rir_end: number;
  ended: boolean;
  now: BlockWeek | null;
}

export interface ReadinessEntry {
  date: string;
  sleep: number;
  energy: number;
  soreness: number;
}

export interface Reflection {
  week_start: string;
  went_well: string | null;
  change: string | null;
}

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

export interface Macros {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface Food extends Macros {
  id: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  serving_label: string | null;
}

export interface MealEntry extends Macros {
  id: string;
  date: string;
  meal: Meal;
  name: string;
  food_id: string | null;
  servings: number;
}

export type NutritionTarget = { [K in keyof Macros]: number | null };

export interface NutritionDay {
  date: string;
  entries: MealEntry[];
  totals: Macros;
  target: NutritionTarget | null;
}

export interface RecentFood extends Macros {
  name: string;
  food_id: string | null;
  times: number;
}

export interface CoachNote {
  kind: string;
  tone: "nudge" | "praise" | "rest" | "info";
  title: string;
  body: string;
}

export interface HabitRoutine {
  id: string;
  name: string;
  emoji: string;
  time_of_day: TimeOfDay;
  habit_ids: string[];
}

export interface Recipe extends Macros {
  id: string;
  name: string;
  serves: number;
  items: { food_id: string; name: string; servings: number }[];
}

export interface Expenditure {
  window_days: number;
  status: "ok" | "not_enough" | "inconsistent";
  food_days: number;
  weigh_days: number;
  tdee: number | null;
  avg_intake: number | null;
  trend_kg_per_week: number | null;
  trend_kg: number | null;
  confidence: "low" | "good" | null;
  suggestion: { goal: "lose" | "gain" | "maintain"; kcal: number; rate_kg_per_week: number } | null;
}

export interface JournalDay {
  date: string;
  mood: number | null;
  note: string | null;
}

export interface Insight {
  driver: string;
  outcome: string;
  text: string;
  high: number;
  low: number;
  days_high: number;
  days_low: number;
  strength: number;
}

export interface Insights {
  window_days: number;
  insights: Insight[];
  coverage: Record<string, number>;
}

export interface HabitImportResult {
  habits: { name: string; days: number; first: string | null; last: string | null; merge: boolean }[];
  imported_days: number;
}

export interface SearchResult {
  kind: "habit" | "habit_note" | "workout" | "journal" | "food" | "recipe";
  id: string;
  title: string;
  detail: string | null;
  date?: string;
  url: string;
}

export interface DayView {
  date: string;
  workouts: { id: string; title: string | null; discipline: string; duration_sec: number | null; distance_m: number | null }[];
  habits: { id: string; name: string; emoji: string; kind: HabitKind; unit: string | null; amount: number; note: string | null; done: boolean }[];
  food: { meals: { meal: Meal; count: number; kcal: number; protein_g: number }[]; kcal: number; protein_g: number };
  journal: { mood: number | null; note: string | null } | null;
  readiness: { sleep: number; energy: number; soreness: number } | null;
  rest: { kind: string; note: string | null } | null;
  weigh_ins: { weight_kg: number; moment: string }[];
}
