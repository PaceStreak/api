/**
 * Achievement rules (Python `app/game/achievements.py`, spec/game.md). Pure and declarative: adding a badge is
 * adding a rule. Every rule rewards something healthy; none rewards training every day, maximum weight or body
 * weight. Habit badges are named generically on purpose: a habit's name never reaches a profile.
 *
 * Tiered rules unlock one row per tier reached, so someone who jumps past bronze to silver gets both.
 */
import { pyRound } from "../lib/format.ts";

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

export type AchievementCategory =
  | "milestone"
  | "consistency"
  | "collection"
  | "volume"
  | "pr"
  | "social"
  | "hidden";

/** Everything a rule can look at. Built by the game unit from the user's history. */
export interface AchievementContext {
  sessions: number;
  active_days: number;
  kept_weeks: number;
  longest_streak: number;
  distinct_exercises: number;
  distinct_patterns: number;
  distinct_disciplines: number;
  tonnage_kg: number;
  distance_km: number;
  hours: number;
  rewarded_prs: number;
  rpe_sets: number;
  push_sets: number;
  pull_sets: number;
  /** Longest break (days) the user came back from. */
  longest_gap_return: number;
  /** Sessions started before 07:00 local. */
  early_sessions: number;
  /** Sessions started at or after 21:00 local. */
  late_sessions: number;
  /** Consecutive kept weeks never exceeding target + 2 days. */
  restful_run: number;
  repaired_then_kept: boolean;
  kudos_given: number;
  groups_joined: number;
  challenges_finished: number;
  body_metric_days: number;
  /** Longest run of four-week blocks with a PR. */
  pr_streak: number;
  /** Most days any one habit was done. */
  habit_best_days: number;
  /** Kept weeks across all habits. */
  habit_kept_weeks: number;
  /** Areas of life with a habit done at least once. */
  habit_categories: number;
  /** Longest clean run of a habit being broken. */
  habit_best_clean: number;
}

export function emptyAchievementContext(): AchievementContext {
  return {
    sessions: 0,
    active_days: 0,
    kept_weeks: 0,
    longest_streak: 0,
    distinct_exercises: 0,
    distinct_patterns: 0,
    distinct_disciplines: 0,
    tonnage_kg: 0,
    distance_km: 0,
    hours: 0,
    rewarded_prs: 0,
    rpe_sets: 0,
    push_sets: 0,
    pull_sets: 0,
    longest_gap_return: 0,
    early_sessions: 0,
    late_sessions: 0,
    restful_run: 0,
    repaired_then_kept: false,
    kudos_given: 0,
    groups_joined: 0,
    challenges_finished: 0,
    body_metric_days: 0,
    pr_streak: 0,
    habit_best_days: 0,
    habit_kept_weeks: 0,
    habit_categories: 0,
    habit_best_clean: 0,
  };
}

export interface AchievementRule {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: AchievementCategory;
  readonly value: (c: Readonly<AchievementContext>) => number;
  /** One threshold for a single badge, three for a tiered one. */
  readonly thresholds: readonly number[];
  readonly hidden: boolean;
  readonly unit: string;
  readonly tier_names: readonly string[];
}

export interface AchievementProgress {
  value: number;
  next: number | null;
  max: number;
}

export function isTiered(rule: AchievementRule): boolean {
  return rule.thresholds.length === 3;
}

/** Tiers reached: `[null]` for a reached single badge, `[]` for none, else the tier names reached in order. */
export function reached(rule: AchievementRule, ctx: Readonly<AchievementContext>): (Tier | null)[] {
  const v = rule.value(ctx);
  if (!isTiered(rule)) return v >= (rule.thresholds[0] ?? Number.POSITIVE_INFINITY) ? [null] : [];
  return TIERS.filter((_, i) => v >= (rule.thresholds[i] ?? Number.POSITIVE_INFINITY));
}

export function progress(rule: AchievementRule, ctx: Readonly<AchievementContext>): AchievementProgress {
  const v = rule.value(ctx);
  const next = rule.thresholds.find((t) => v < t) ?? null;
  return { value: pyRound(v, 1), next, max: rule.thresholds[rule.thresholds.length - 1] ?? 0 };
}

interface RuleInput {
  id: string;
  title: string;
  description: string;
  category: AchievementCategory;
  value: (c: Readonly<AchievementContext>) => number;
  thresholds: number[];
  hidden?: boolean;
  unit?: string;
  tier_names?: string[];
}

function rule(r: RuleInput): AchievementRule {
  return Object.freeze({
    ...r,
    thresholds: Object.freeze(r.thresholds),
    hidden: r.hidden ?? false,
    unit: r.unit ?? "",
    tier_names: Object.freeze(r.tier_names ?? []),
  });
}

export const RULES: readonly AchievementRule[] = Object.freeze([
  // --- milestones
  rule({
    id: "first_session",
    title: "First log",
    description: "Log your first session. The hardest one.",
    category: "milestone",
    value: (c) => c.sessions,
    thresholds: [1],
  }),
  rule({
    id: "first_kept_week",
    title: "Week one",
    description: "Hit your weekly target for the first time.",
    category: "milestone",
    value: (c) => c.kept_weeks,
    thresholds: [1],
  }),
  // --- consistency
  rule({
    id: "showing_up",
    title: "Showing up",
    description: "Train on distinct days. Rest days never count against you.",
    category: "consistency",
    value: (c) => c.active_days,
    thresholds: [10, 50, 150],
    unit: "days",
  }),
  rule({
    id: "unbroken",
    title: "Unbroken",
    description: "Build a streak of kept weeks.",
    category: "consistency",
    value: (c) => c.longest_streak,
    thresholds: [4, 12, 26],
    unit: "weeks",
  }),
  rule({
    id: "year_of_the_chain",
    title: "A year of weeks",
    description: "Keep your streak for 52 weeks.",
    category: "consistency",
    value: (c) => c.longest_streak,
    thresholds: [52],
    unit: "weeks",
  }),
  rule({
    id: "rest_is_training",
    title: "Rest is training",
    description: "Keep eight weeks in a row without training more than two days past your target.",
    category: "consistency",
    value: (c) => c.restful_run,
    thresholds: [8],
    unit: "weeks",
  }),
  // --- breadth
  rule({
    id: "explorer",
    title: "Explorer",
    description: "Log different exercises.",
    category: "collection",
    value: (c) => c.distinct_exercises,
    thresholds: [10, 25, 50],
    unit: "exercises",
  }),
  rule({
    id: "movement_master",
    title: "Movement master",
    description: "Train every movement pattern.",
    category: "collection",
    value: (c) => c.distinct_patterns,
    thresholds: [6, 9, 12],
    unit: "patterns",
  }),
  rule({
    id: "multi_sport",
    title: "Multi-sport",
    description: "Log sessions in different disciplines.",
    category: "collection",
    value: (c) => c.distinct_disciplines,
    thresholds: [2, 4, 6],
    unit: "disciplines",
  }),
  // --- lifetime landmarks: totals only rise, so they reward sticking around, not one heroic day
  rule({
    id: "tonnage",
    title: "Heavy lifting",
    description: "Accumulate lifetime tonnage.",
    category: "volume",
    value: (c) => c.tonnage_kg,
    thresholds: [25_000, 100_000, 500_000],
    unit: "kg",
    tier_names: ["Moved a piano", "Moved a rhino", "Moved a bus"],
  }),
  rule({
    id: "distance",
    title: "Long way round",
    description: "Cover lifetime distance, on foot, wheels or water.",
    category: "volume",
    value: (c) => c.distance_km,
    thresholds: [42.2, 500, 2_000],
    unit: "km",
    tier_names: ["A marathon, eventually", "Across a country", "Across a continent"],
  }),
  rule({
    id: "time_well_spent",
    title: "Time well spent",
    description: "Log lifetime training hours.",
    category: "volume",
    value: (c) => c.hours,
    thresholds: [10, 100, 500],
    unit: "hours",
  }),
  // --- records
  rule({
    id: "first_pr",
    title: "New best",
    description: "Beat one of your own records.",
    category: "pr",
    value: (c) => c.rewarded_prs,
    thresholds: [1],
  }),
  rule({
    id: "pr_collector",
    title: "Getting better",
    description: "Set personal records - your own, nobody else's.",
    category: "pr",
    value: (c) => c.rewarded_prs,
    thresholds: [10, 25, 50],
    unit: "records",
  }),
  rule({
    id: "always_improving",
    title: "Always improving",
    description: "A personal record in consecutive four-week blocks. Any lift, any size.",
    category: "pr",
    value: (c) => c.pr_streak,
    thresholds: [3, 6, 13],
    unit: "blocks",
  }),
  // --- honest logging
  rule({
    id: "honest_logger",
    title: "Honest logger",
    description: "Log how hard sets felt (RPE). Complete records, not heavier ones.",
    category: "consistency",
    value: (c) => c.rpe_sets,
    thresholds: [50, 200, 500],
    unit: "sets",
  }),
  // --- habits: generic names, a habit's name (especially one being broken) never shows on a profile
  rule({
    id: "sixty_six",
    title: "Sixty-six days",
    description: "Do one habit on 66 days: about how long, on average, a habit takes to feel automatic.",
    category: "consistency",
    value: (c) => c.habit_best_days,
    thresholds: [66],
  }),
  rule({
    id: "habit_keeper",
    title: "Habit keeper",
    description: "Keep the weekly target on your habits, week after week.",
    category: "consistency",
    value: (c) => c.habit_kept_weeks,
    thresholds: [10, 50, 150],
    unit: "habit weeks",
  }),
  rule({
    id: "well_rounded",
    title: "Well rounded",
    description: "Keep habits in three different areas of life.",
    category: "collection",
    value: (c) => c.habit_categories,
    thresholds: [3],
  }),
  rule({
    id: "held_the_line",
    title: "Held the line",
    description: "Thirty days in a row free of a habit you're breaking. Private: it never says which.",
    category: "consistency",
    value: (c) => c.habit_best_clean,
    thresholds: [30],
  }),
  rule({
    id: "measured",
    title: "Measured",
    description: "Keep a private body log on different days. Only you ever see it.",
    category: "consistency",
    value: (c) => c.body_metric_days,
    thresholds: [10],
    unit: "days",
  }),
  // --- social
  rule({
    id: "cheerleader",
    title: "Cheerleader",
    description: "Give kudos to other people's sessions.",
    category: "social",
    value: (c) => c.kudos_given,
    thresholds: [10],
    unit: "kudos",
  }),
  rule({
    id: "crew",
    title: "Crew",
    description: "Join or start a group.",
    category: "social",
    value: (c) => c.groups_joined,
    thresholds: [1],
  }),
  rule({
    id: "finisher",
    title: "Finisher",
    description: "See a challenge through to the end.",
    category: "social",
    value: (c) => c.challenges_finished,
    thresholds: [1],
  }),
  // --- hidden: good behaviour, discovered rather than chased
  rule({
    id: "welcome_back",
    title: "Welcome back",
    description: "Return after two weeks or more away. Coming back is the part that counts.",
    category: "hidden",
    value: (c) => c.longest_gap_return,
    thresholds: [14],
    hidden: true,
  }),
  rule({
    id: "balanced",
    title: "Balanced",
    description: "Keep pushing and pulling volume within 25% of each other.",
    category: "hidden",
    value: (c) => {
      const lo = Math.min(c.push_sets, c.pull_sets);
      return c.push_sets + c.pull_sets >= 40 && lo > 0 ? (lo / Math.max(c.push_sets, c.pull_sets)) * 100 : 0;
    },
    thresholds: [75],
    hidden: true,
  }),
  rule({
    id: "early_bird",
    title: "Early bird",
    description: "Five sessions started before 7am.",
    category: "hidden",
    value: (c) => c.early_sessions,
    thresholds: [5],
    hidden: true,
  }),
  rule({
    id: "night_owl",
    title: "Night owl",
    description: "Five sessions started after 9pm.",
    category: "hidden",
    value: (c) => c.late_sessions,
    thresholds: [5],
    hidden: true,
  }),
  rule({
    id: "second_chance",
    title: "Second chance",
    description: "Repair a week, then keep the next four.",
    category: "hidden",
    value: (c) => (c.repaired_then_kept ? 1 : 0),
    thresholds: [1],
    hidden: true,
  }),
]);

export const RULE_BY_ID: ReadonlyMap<string, AchievementRule> = new Map(RULES.map((r) => [r.id, r]));
