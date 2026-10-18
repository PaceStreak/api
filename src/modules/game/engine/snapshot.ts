/**
 * The snapshot: everything `/me/*` shows, derived purely from the aggregates (Python `service.snapshot`,
 * spec/game.md §2.3). No I/O: service.ts loads the rows in one D1 round trip and calls `buildSnapshot`.
 */
import { type AchievementContext, emptyAchievementContext } from "../../../catalog/achievements.ts";
import { CUSTOM_PREFIX, EXERCISE_BY_ID, PULL_PATTERNS, PUSH_PATTERNS } from "../../../catalog/exercises.ts";
import { QUEST_XP } from "../../../catalog/quests.ts";
import type { RequirementsHistory, TargetHistory } from "../../../db/schema/training.ts";
import { pyRound } from "../../../lib/format.ts";
import { monthKey, seasonId } from "../../../lib/time.ts";
import { addDays, daysBetween, weekStart } from "./days.ts";
import {
  computePrStreak,
  computeQuests,
  type PrStreak,
  type QuestWeek,
  questsDone,
  weekFacts,
  weeksBetween,
} from "./quests.ts";
import { type Best, detect, higherIsBetter, type Observation, type PrEvent, splitKey } from "./records.ts";
import {
  type ChainResult,
  computeChain,
  pausedDays,
  requirementsResolver,
  type Span,
  spanActive,
  targetResolver,
} from "./streak.ts";
import {
  computeXp,
  type DayActivity,
  habitXp,
  type LevelProgress,
  levelProgress,
  summarise,
  type XpItem,
  type XpSummary,
} from "./xp.ts";

export const HEATMAP_DAYS = 371;

// ---- inputs ---------------------------------------------------------------------------------------------------

export interface ProfileIn {
  userId: string;
  timezone: string;
  weekStartsOn: number;
  gamificationEnabled: boolean;
  lifeTarget: number | null;
  trainingDays: number | null;
  visibility: string;
  sharingPaused: boolean;
  birthYear: number | null;
  socialSuspendedAt: number | null;
  deletionScheduledAt: number | null;
  onboardedAt: number | null;
  leaderboardOptIn: boolean;
  learnedReminderHour: number | null;
  quietStart: number;
  quietEnd: number;
}

export interface ChainIn {
  id: string;
  name: string;
  disciplines: string[];
  targetHistory: TargetHistory;
  requirementsHistory: RequirementsHistory;
}

export interface DayIn {
  localDate: string;
  sessions: number;
  detailed: number;
  durationSec: number;
  distanceM: number;
  heat: number;
  short: number;
  early: number;
  late: number;
  rpeSets: number;
  disciplines: Record<string, number>;
  exercises: string[];
}

export interface ExerciseIn {
  exerciseId: string;
  firstSeen: string;
  sets: number;
  rpeSets: number;
  tonnage: number;
}

export interface CustomIn {
  id: string;
  name: string;
  pattern: string;
  loadType: string;
  primary: string[];
  secondary: string[];
}

export interface PauseIn {
  id: string;
  startsOn: string;
  endsOn: string | null;
  reason: string;
  note: string | null;
}

export interface StoredRecord {
  key: string;
  value: number;
  previous: number | null;
  gainPct: number | null;
  achievedOn: string;
  workoutId: string | null;
  flagged: boolean;
  rewarded: boolean;
  isCurrent: boolean;
}

/** A habit as the habits module sees it (Python `habit_views`); only generic fields, never the name. */
export interface HabitView {
  kind: string;
  category: string;
  weeklyTarget: number;
  startedOn: string;
  /** Sorted. */
  doneDays: string[];
  chain: ChainResult;
  bestCleanRun: number | null;
}

export interface SnapshotInputs {
  profile: ProfileIn;
  today: string;
  chains: ChainIn[];
  repairs: { chainId: string; weekStart: string; month: string }[];
  pauses: PauseIn[];
  wagers: { weekStart: string; days: number }[];
  days: DayIn[];
  exercises: ExerciseIn[];
  customs: CustomIn[];
  records: { events: PrEvent[]; bests: Map<string, Best> };
  achievements: { achievementId: string; tier: string | null; unlockedOn: string }[];
  counts: { kudos: number; groups: number; finished: number; bodyDays: number; firstWeigh: string | null };
  restDays: string[];
  wakingDates: string[];
  habits: HabitView[];
}

// ---- exercise meta --------------------------------------------------------------------------------------------

export interface ExerciseMeta {
  name: string;
  pattern: string;
  loadType: string;
  primary: readonly string[];
  secondary: readonly string[];
}

/** Python `exercise_meta`: library, custom (`custom-<id>`) or unknown. */
export function exerciseMeta(id: string, customs: ReadonlyMap<string, CustomIn>): ExerciseMeta {
  if (id.startsWith(CUSTOM_PREFIX)) {
    const c = customs.get(id);
    return c === undefined
      ? { name: "Deleted exercise", pattern: "other", loadType: "weight", primary: [], secondary: [] }
      : c;
  }
  const lib = EXERCISE_BY_ID.get(id);
  return lib === undefined
    ? { name: id, pattern: "other", loadType: "weight", primary: [], secondary: [] }
    : {
        name: lib.name,
        pattern: lib.pattern,
        loadType: lib.load_type,
        primary: lib.primary,
        secondary: lib.secondary,
      };
}

export const customMap = (customs: readonly CustomIn[]) =>
  new Map(customs.map((c) => [`${CUSTOM_PREFIX}${c.id}`, c]));

// ---- records --------------------------------------------------------------------------------------------------

/** Rebuilds events and bests from stored `personal_records` rows (the projection recompute writes). */
export function recordsFromRows(rows: readonly StoredRecord[]): {
  events: PrEvent[];
  bests: Map<string, Best>;
} {
  const bests = new Map<string, Best>();
  const events: PrEvent[] = [];
  for (const r of rows) {
    if (r.isCurrent) bests.set(r.key, { value: r.value, day: r.achievedOn, workoutId: r.workoutId ?? "" });
    if (r.previous !== null)
      events.push({
        key: r.key,
        value: r.value,
        previous: r.previous,
        gainPct: r.gainPct ?? 0,
        day: r.achievedOn,
        workoutId: r.workoutId ?? "",
        flagged: r.flagged,
        rewarded: r.rewarded,
      });
  }
  events.sort(eventOrder);
  return { events, bests };
}

export const eventOrder = (a: PrEvent, b: PrEvent) =>
  a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

export interface RawRecordDay {
  key: string;
  localDate: string;
  value: number;
  workoutId: string;
  rewardable: boolean;
}

const E1RM_LOADS: ReadonlySet<string> = new Set(["weight", "weighted_bw"]);

/**
 * Maps raw `record_days` keys to record observations by load type (spec/game.md §2.3 "Records observations"),
 * with Python's rounding: e1rm to 2 places, distance and pace to 1.
 */
export function observationsFrom(
  rows: readonly RawRecordDay[],
  customs: ReadonlyMap<string, CustomIn>,
): Observation[] {
  const out: Observation[] = [];
  for (const r of rows) {
    const [kind, subject] = splitKey(r.key);
    let key: string | null = null;
    let value = r.value;
    if (kind === "distance" || kind.startsWith("pace_")) {
      key = r.key;
      value = pyRound(r.value, 1);
    } else {
      const load = exerciseMeta(subject, customs).loadType;
      if (kind === "e1rm" && E1RM_LOADS.has(load) && r.value > 0) {
        key = r.key;
        value = pyRound(r.value, 2);
      } else if (kind === "reps" && load === "bodyweight") key = r.key;
      else if (kind === "repsbw" && load === "weighted_bw") key = `reps:${subject}`;
      else if (kind === "hold" && load === "time") key = r.key;
    }
    if (key !== null)
      out.push({
        key,
        value,
        day: r.localDate,
        workoutId: r.workoutId,
        higherIsBetter: higherIsBetter(key),
        rewardable: r.rewardable,
      });
  }
  return out;
}

/** Raw keys that feed record keys of these exercises and disciplines (a scoped recompute). */
export function rawKeysFor(exercises: Iterable<string>, disciplines: Iterable<string>): string[] {
  const keys: string[] = [];
  for (const ex of exercises) keys.push(`e1rm:${ex}`, `reps:${ex}`, `repsbw:${ex}`, `hold:${ex}`);
  for (const d of disciplines) {
    keys.push(`distance:${d}`);
    if (d === "run") keys.push("pace_5k:run", "pace_10k:run", "pace_half:run", "pace_marathon:run");
  }
  return keys;
}

/** The record keys (as stored) that raw keys can produce. */
export function recordKeysFor(rawKeys: readonly string[]): string[] {
  return [...new Set(rawKeys.map((k) => (k.startsWith("repsbw:") ? `reps:${k.slice(7)}` : k)))];
}

export const detectRecords = (rows: readonly RawRecordDay[], customs: ReadonlyMap<string, CustomIn>) =>
  detect(observationsFrom(rows, customs));

// ---- the snapshot ---------------------------------------------------------------------------------------------

export interface ChainView {
  chain: ChainIn;
  result: ChainResult;
}

export interface Snapshot {
  profile: ProfileIn;
  today: string;
  chains: [ChainView, ...ChainView[]];
  xp: XpSummary;
  level: LevelProgress;
  xpItems: XpItem[];
  events: PrEvent[];
  bests: Map<string, Best>;
  context: AchievementContext;
  heatmap: { date: string; level: number; sessions: number; disciplines: string[] }[];
  days: DayActivity[];
  dayRows: Map<string, DayIn>;
  sessions: number;
  lastActive: string | null;
  repairUsedThisMonth: boolean;
  names: Map<string, string>;
  pauses: PauseIn[];
  pausedToday: boolean;
  quests: QuestWeek[];
  prStreak: PrStreak;
  wagers: { weekStart: string; days: number }[];
  habits: HabitView[];
  life: ChainResult | null;
  sheltered: Set<string>;
  customs: Map<string, CustomIn>;
}

/** `chains` must be non-empty (the service creates the default chain first). */
export function buildSnapshot(inp: SnapshotInputs): Snapshot {
  const { profile, today } = inp;
  const wso = profile.weekStartsOn;
  const customs = customMap(inp.customs);
  const repairUsed = inp.repairs.some((r) => r.month === monthKey(today));
  const spans: Span[] = inp.pauses.map((p) => ({ startsOn: p.startsOn, endsOn: p.endsOn }));
  const sheltered = pausedDays(spans);
  const dayRows = new Map(inp.days.map((d) => [d.localDate, d]));
  const wagerMap = new Map(inp.wagers.map((w) => [w.weekStart, w.days]));

  // ---- streaks
  const views: ChainView[] = inp.chains.map((chain, i) => {
    const allowed = new Set(chain.disciplines);
    const active: string[] = [];
    const dayDisciplines = new Map<string, Set<string>>();
    const wantKinds = chain.requirementsHistory.length > 0;
    for (const d of inp.days) {
      if (allowed.size === 0 && !wantKinds) {
        active.push(d.localDate);
        continue;
      }
      const ds = Object.keys(d.disciplines);
      const matching = allowed.size === 0 ? ds : ds.filter((x) => allowed.has(x));
      if (matching.length === 0) continue;
      active.push(d.localDate);
      if (wantKinds) dayDisciplines.set(d.localDate, new Set(matching));
    }
    return {
      chain,
      result: computeChain(active, today, wso, targetResolver(chain.targetHistory), {
        repaired: inp.repairs.filter((r) => r.chainId === chain.id).map((r) => r.weekStart),
        repairAvailable: !repairUsed,
        pausedDays: sheltered,
        requirementsFor: requirementsResolver(chain.requirementsHistory),
        dayDisciplines,
        // Wagers are made on the main chain only.
        wagers: i === 0 ? wagerMap : null,
      }),
    };
  });
  const main = views[0] as ChainView;

  // ---- habits and the whole-life streak
  const habits = inp.habits;
  let life: ChainResult | null = null;
  if (profile.lifeTarget) {
    const lifeDays = new Set(inp.days.map((d) => d.localDate));
    for (const h of habits) if (h.kind !== "quit") for (const d of h.doneDays) lifeDays.add(d);
    const target = profile.lifeTarget;
    life = computeChain(lifeDays, today, wso, () => target, { pausedDays: sheltered });
  }

  // ---- days
  const days: DayActivity[] = [];
  let sessions = 0;
  let durationSec = 0;
  let distanceM = 0;
  let early = 0;
  let late = 0;
  const disciplines = new Set<string>();
  for (const d of inp.days) {
    sessions += d.sessions;
    durationSec += d.durationSec;
    distanceM += d.distanceM;
    early += d.early;
    late += d.late;
    for (const k in d.disciplines) disciplines.add(k);
    if (d.localDate <= today) days.push({ day: d.localDate, sessions: d.sessions, detailed: d.detailed > 0 });
  }

  // ---- exercises
  const names = new Map<string, string>();
  const patterns = new Set<string>();
  let tonnage = 0;
  let rpeSets = 0;
  let pushSets = 0;
  let pullSets = 0;
  const firstSeenByWeek = new Map<string, number>();
  for (const e of inp.exercises) {
    const meta = exerciseMeta(e.exerciseId, customs);
    names.set(e.exerciseId, meta.name);
    patterns.add(meta.pattern);
    if (E1RM_LOADS.has(meta.loadType)) tonnage += e.tonnage;
    rpeSets += e.rpeSets;
    if (PUSH_PATTERNS.has(meta.pattern)) pushSets += e.sets;
    else if (PULL_PATTERNS.has(meta.pattern)) pullSets += e.sets;
    const w = weekStart(e.firstSeen, wso);
    firstSeenByWeek.set(w, (firstSeenByWeek.get(w) ?? 0) + 1);
  }

  // ---- records
  const { events, bests } = inp.records;
  const rewardedDays = events.filter((e) => e.rewarded).map((e) => e.day);
  const prStreak = computePrStreak(rewardedDays, today);
  for (const key of bests.keys()) {
    const [kind, subject] = splitKey(key);
    if ((kind === "e1rm" || kind === "reps" || kind === "hold") && !names.has(subject))
      names.set(subject, exerciseMeta(subject, customs).name);
  }

  // ---- achievement context
  let gap = 0;
  for (let i = 1; i < days.length; i++) {
    gap = Math.max(gap, daysBetween((days[i - 1] as DayActivity).day, (days[i] as DayActivity).day) - 1);
  }
  const closed = main.result.weeks.slice(0, -1);
  let restful = 0;
  let bestRestful = 0;
  for (const c of closed) {
    if (c.status === "kept" && c.days <= c.target + 2) bestRestful = Math.max(bestRestful, ++restful);
    else restful = 0;
  }
  const repairedThenKept = closed.some((c, i) => {
    const next = closed.slice(i + 1, i + 5);
    return c.status === "repaired" && next.length === 4 && next.every((n) => n.status === "kept");
  });
  const nonQuit = habits.filter((h) => h.kind !== "quit");
  const context: AchievementContext = {
    ...emptyAchievementContext(),
    sessions,
    active_days: days.length,
    kept_weeks: main.result.weeks.filter((c) => c.status === "kept").length,
    longest_streak: Math.max(...views.map((v) => v.result.longest)),
    distinct_exercises: inp.exercises.length,
    distinct_patterns: [...patterns].filter((p) => p !== "other").length,
    distinct_disciplines: disciplines.size,
    tonnage_kg: tonnage,
    distance_km: distanceM / 1000,
    hours: durationSec / 3600,
    rewarded_prs: rewardedDays.length,
    rpe_sets: rpeSets,
    push_sets: pushSets,
    pull_sets: pullSets,
    longest_gap_return: gap,
    early_sessions: early,
    late_sessions: late,
    restful_run: bestRestful,
    repaired_then_kept: repairedThenKept,
    kudos_given: inp.counts.kudos,
    groups_joined: inp.counts.groups,
    challenges_finished: inp.counts.finished,
    body_metric_days: inp.counts.bodyDays,
    pr_streak: prStreak.longest,
    habit_best_days: Math.max(0, ...nonQuit.map((h) => h.doneDays.length)),
    habit_kept_weeks: habits.reduce((n, h) => n + h.chain.weeks.filter((c) => c.status === "kept").length, 0),
    habit_categories: new Set(habits.filter((h) => h.doneDays.length > 0).map((h) => h.category)).size,
    habit_best_clean: Math.max(0, ...habits.filter((h) => h.kind === "quit").map((h) => h.bestCleanRun ?? 0)),
  };

  // ---- quests
  const weekOf = (d: string) => weekStart(d, wso);
  const restByWeek = countBy(inp.restDays, weekOf);
  const wakingByWeek = countBy(new Set(inp.wakingDates), weekOf);
  const habitsByWeek = new Map<string, number>();
  const habitsKeptByWeek = new Map<string, number>();
  for (const h of habits) {
    for (const c of h.chain.weeks) {
      if (c.status === "paused") continue;
      habitsByWeek.set(c.weekStart, (habitsByWeek.get(c.weekStart) ?? 0) + 1);
      const kept = c.status === "kept" || (c.status === "open" && c.days >= c.target);
      habitsKeptByWeek.set(c.weekStart, (habitsKeptByWeek.get(c.weekStart) ?? 0) + Number(kept));
    }
  }
  // One pass over the days buckets everything a quest looks at by week.
  const patternOf = new Map<string, string>();
  const weekly = new Map<
    string,
    { active: Set<string>; patterns: Set<string>; rpe: number; short: number }
  >();
  for (const d of inp.days) {
    const w = weekOf(d.localDate);
    let f = weekly.get(w);
    if (f === undefined) {
      f = { active: new Set(), patterns: new Set(), rpe: 0, short: 0 };
      weekly.set(w, f);
    }
    f.active.add(d.localDate);
    f.rpe += d.rpeSets;
    f.short += d.short;
    for (const ex of d.exercises) {
      let pattern = patternOf.get(ex);
      if (pattern === undefined) {
        pattern = exerciseMeta(ex, customs).pattern;
        patternOf.set(ex, pattern);
      }
      f.patterns.add(pattern);
    }
  }
  const factsFor = (week: string) => {
    const f = weekly.get(week);
    return weekFacts({
      activeDays: f?.active ?? new Set(),
      patterns: f?.patterns ?? new Set(),
      rpeSets: f?.rpe ?? 0,
      shortSessions: f?.short ?? 0,
      newExercises: firstSeenByWeek.get(week) ?? 0,
      restDays: restByWeek.get(week) ?? 0,
      wakingWeighDays: wakingByWeek.get(week) ?? 0,
      habitsKept: habitsKeptByWeek.get(week) ?? 0,
      habitsTotal: habitsByWeek.get(week) ?? 0,
    });
  };
  const questStart = main.result.weeks[0]?.weekStart ?? today;
  let firstHabit: string | null = null;
  for (const h of habits) if (firstHabit === null || h.startedOn < firstHabit) firstHabit = h.startedOn;
  const quests = computeQuests(
    weeksBetween(questStart, today, wso),
    factsFor,
    inp.counts.firstWeigh,
    new Set(main.result.weeks.filter((c) => c.status === "paused").map((c) => c.weekStart)),
    firstHabit,
  );

  // ---- XP
  const items = computeXp(
    days,
    wso,
    targetResolver(main.chain.targetHistory),
    main.result.weeks.filter((c) => c.status === "kept").map((c) => c.weekStart),
    main.result.milestonesHit,
    rewardedDays,
    inp.achievements.map((a) => [a.tier, a.unlockedOn] as const),
  );
  items.push(
    ...habitXp(
      habits.map((h) => ({
        kind: h.kind,
        weeklyTarget: h.weeklyTarget,
        doneDays: h.doneDays,
        cells: h.chain.weeks,
      })),
      wso,
      today,
    ),
  );
  for (const qw of quests) {
    const end = addDays(qw.weekStart, 6);
    const paidOn = end < today ? end : today;
    for (const _ of questsDone(qw)) items.push({ source: "quest", amount: QUEST_XP, day: paidOn });
  }
  const xp = summarise(items, seasonId(today));

  // ---- heatmap
  const since = addDays(today, -(HEATMAP_DAYS - 1));
  const heatmap = inp.days
    .filter((d) => d.localDate >= since && d.localDate <= today)
    .map((d) => ({
      date: d.localDate,
      level: d.heat < 30 ? 1 : d.heat < 60 ? 2 : d.heat < 90 ? 3 : 4,
      sessions: d.sessions,
      disciplines: Object.keys(d.disciplines).sort(),
    }));

  return {
    profile,
    today,
    chains: views as [ChainView, ...ChainView[]],
    xp,
    level: levelProgress(xp.total),
    xpItems: items,
    events,
    bests,
    context,
    heatmap,
    days,
    dayRows,
    sessions,
    lastActive: days.length > 0 ? (days[days.length - 1] as DayActivity).day : null,
    repairUsedThisMonth: repairUsed,
    names,
    pauses: inp.pauses,
    pausedToday: spans.some((s) => spanActive(s, today)),
    quests,
    prStreak,
    wagers: inp.wagers,
    habits,
    life,
    sheltered,
    customs,
  };
}

function countBy(xs: Iterable<string>, key: (x: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Adds the XP of badges unlocked in this recompute (Python re-snapshots after inserting them). */
export function withAchievements(
  snap: Snapshot,
  unlocked: readonly { tier: string | null; day: string }[],
): Snapshot {
  if (unlocked.length === 0) return snap;
  const extra = computeXp(
    [],
    snap.profile.weekStartsOn,
    () => 0,
    [],
    [],
    [],
    unlocked.map((u) => [u.tier, u.day]),
  );
  const items = [...snap.xpItems, ...extra];
  const xp = summarise(items, seasonId(snap.today));
  return { ...snap, xpItems: items, xp, level: levelProgress(xp.total) };
}
