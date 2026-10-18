/**
 * Response shapes built from a Snapshot (Python `router.py`, `recap.py`, `review.py`, `monthly.py`). Pure.
 * Recaps and reviews report attendance, never volume: no tonnage, total distance or calories.
 */
import {
  isTiered,
  RULE_BY_ID,
  RULES,
  progress as ruleProgress,
  TIERS,
} from "../../../catalog/achievements.ts";
import { DISCIPLINE_BY_ID, MUSCLES } from "../../../catalog/exercises.ts";
import { QUEST_XP } from "../../../catalog/quests.ts";
import { pyRound } from "../../../lib/format.ts";
import { seasonBounds, seasonId } from "../../../lib/time.ts";
import { addDays, pyWeekday, weekStart } from "./days.ts";
import { recordLabel, splitKey } from "./records.ts";
import { type ChainView, exerciseMeta, type PauseIn, type Snapshot } from "./snapshot.ts";
import { type ChainResult, COUNTING, cellScore, effectiveEnd, spanActive, targetResolver } from "./streak.ts";

export function weeksPayload(r: ChainResult, weeks = 26) {
  return r.weeks.slice(-weeks).map((c) => ({
    week_start: c.weekStart,
    days: c.days,
    target: c.target,
    status: c.status,
    score: cellScore(c),
  }));
}

/** The chain's own `target` column in Python: the latest point of its history, 3 without one. */
export function chainTarget(v: ChainView): number {
  const h = v.chain.targetHistory;
  const last = h[h.length - 1];
  return last === undefined ? 3 : Math.trunc(Number(last.target));
}

export function chainPayload(v: ChainView, weeks = 26) {
  const r = v.result;
  return {
    id: v.chain.id,
    name: v.chain.name,
    disciplines: v.chain.disciplines,
    target: chainTarget(v),
    current: r.current,
    longest: r.longest,
    freezes_available: r.freezesAvailable,
    this_week_days: r.thisWeekDays,
    this_week_target: r.thisWeekTarget,
    days_left: r.daysLeft,
    needed: r.needed,
    at_risk: r.atRisk,
    will_freeze: r.willFreeze,
    repairable_week: r.repairableWeek,
    run_started: r.runStarted,
    consistency: r.consistency,
    consistency_12: r.consistency12,
    consistency_52: r.consistency52,
    paused_now: r.pausedNow,
    requirements: r.requirementsProgress.map(([req, done]) => ({
      disciplines: [...req.disciplines].sort(),
      days: req.days,
      done,
    })),
    weeks: weeksPayload(r, weeks),
  };
}

export function pausePayload(p: PauseIn, today: string) {
  const span = { startsOn: p.startsOn, endsOn: p.endsOn };
  return {
    id: p.id,
    starts_on: p.startsOn,
    ends_on: p.endsOn,
    effective_end: effectiveEnd(span),
    reason: p.reason,
    note: p.note,
    active: spanActive(span, today),
    upcoming: p.startsOn > today,
  };
}

export function questsPayload(snap: Snapshot) {
  if (!snap.profile.gamificationEnabled) return null;
  const thisWeek = weekStart(snap.today, snap.profile.weekStartsOn);
  const current = snap.quests.find((q) => q.weekStart === thisWeek);
  let completed = 0;
  for (const qw of snap.quests) for (const [q, p] of qw.quests) if (p >= q.goal) completed++;
  return {
    week_start: thisWeek,
    xp_each: QUEST_XP,
    paused: current === undefined,
    items: (current?.quests ?? []).map(([q, p]) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      goal: q.goal,
      progress: Math.min(p, q.goal),
      done: p >= q.goal,
    })),
    completed_total: completed,
  };
}

export const prStreakPayload = (snap: Snapshot) => ({
  current: snap.prStreak.current,
  longest: snap.prStreak.longest,
  this_block_has_pr: snap.prStreak.thisBlockHasPr,
  block_ends: snap.prStreak.blockEnds,
});

export interface WagerOption {
  week: "this" | "next";
  week_start: string;
  days: number;
  blocked: string | null;
}

/** The wager for this week or next, if any, and whether one can be made (spec/game.md §1.1 wager_state). */
export function wagerState(snap: Snapshot) {
  const main = snap.chains[0];
  const thisWeek = weekStart(snap.today, snap.profile.weekStartsOn);
  const nextWeek = addDays(thisWeek, 7);
  const byWeek = new Map(snap.wagers.map((w) => [w.weekStart, w]));
  const won = new Set(main.result.wagersWon);
  const thisCell = main.result.weeks[main.result.weeks.length - 1];
  const thisDays = thisCell?.days ?? 0;
  const targetFor = targetResolver(main.chain.targetHistory);

  const entry = (week: string) => {
    const w = byWeek.get(week);
    if (w === undefined) return null;
    const status =
      won.has(week) || (week === thisWeek && thisDays >= w.days) ? "won" : week >= thisWeek ? "open" : "lost";
    return { week_start: week, days: w.days, done: week === thisWeek ? thisDays : null, status };
  };
  const blocked = (week: string): string | null => {
    if (snap.wagers.some((w) => w.weekStart.slice(0, 7) === week.slice(0, 7))) return "One wager a month.";
    if (targetFor(week) + 1 > 7) return "Your target is already every day.";
    if (week === thisWeek && thisDays > 0) return "Wagers are made before the week's first session.";
    if (week === thisWeek && thisCell?.status === "paused") return "Not during a pause.";
    return null;
  };
  let lastClosed: string | null = null;
  for (const w of snap.wagers) if (w.weekStart < thisWeek) lastClosed = w.weekStart;
  const options: WagerOption[] = (
    [
      ["this", thisWeek],
      ["next", nextWeek],
    ] as const
  ).map(([week, start]) => {
    const why = blocked(start);
    return {
      week,
      week_start: start,
      days: Math.min(7, targetFor(start) + 1),
      blocked: !byWeek.has(start) && why === null ? null : (why ?? "Already made."),
    };
  });
  return {
    current: entry(thisWeek),
    next: entry(nextWeek),
    last: lastClosed === null ? null : entry(lastClosed),
    options,
    freezes_available: main.result.freezesAvailable,
  };
}

export function statsPayload(snap: Snapshot) {
  const c = snap.context;
  const sid = seasonId(snap.today);
  const [start, end] = seasonBounds(sid);
  const life = snap.life;
  return {
    today: snap.today,
    week_starts_on: snap.profile.weekStartsOn,
    gamification_enabled: snap.profile.gamificationEnabled,
    level: snap.level,
    xp: snap.xp,
    season: { id: sid, starts_on: start, ends_on: end },
    chains: snap.chains.map((v) => chainPayload(v)),
    repair_available: !snap.repairUsedThisMonth,
    paused_today: snap.pausedToday,
    pauses: snap.pauses.slice(-12).map((p) => pausePayload(p, snap.today)),
    training_days: snap.profile.trainingDays,
    heatmap: snap.heatmap,
    totals: {
      sessions: c.sessions,
      active_days: c.active_days,
      hours: pyRound(c.hours, 1),
      distance_km: pyRound(c.distance_km, 1),
      tonnage_kg: pyRound(c.tonnage_kg),
      records: c.rewarded_prs,
      disciplines: c.distinct_disciplines,
      exercises: c.distinct_exercises,
    },
    last_active: snap.lastActive,
    quests: questsPayload(snap),
    life:
      life === null
        ? null
        : {
            target: snap.profile.lifeTarget,
            current: life.current,
            longest: life.longest,
            this_week_days: life.thisWeekDays,
            needed: life.needed,
            days_left: life.daysLeft,
            freezes_available: life.freezesAvailable,
            weeks: weeksPayload(life, 26),
          },
    habits: {
      count: snap.habits.length,
      done_today: snap.habits.filter((h) => h.doneDays.includes(snap.today)).length,
      kept_this_week: snap.habits.filter((h) => h.chain.thisWeekDays >= h.chain.thisWeekTarget).length,
    },
    pr_streak: prStreakPayload(snap),
    wager: wagerState(snap),
  };
}

// ---- recap, review ------------------------------------------------------------------------------------------

export const VERDICTS: Readonly<Record<string, string>> = {
  kept: "Week kept.",
  frozen: "A freeze covered it.",
  repaired: "Repaired.",
  paused: "Paused. Rest up, the streak will wait.",
  missed: "Missed. It happens, and this week is a fresh one.",
  open: "Still open.",
};

/** Python `str.title()`: upper-case the first letter of every run of letters, lower-case the rest. */
export function pyTitle(s: string): string {
  return s.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export const disciplineName = (d: string) => DISCIPLINE_BY_ID.get(d)?.name ?? pyTitle(d);

/** Counter.most_common: by count, ties in first-seen order. */
function mostCommon(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** Workouts in [first, last] from the day aggregates: dates trained and sessions per discipline. */
function workoutsIn(snap: Snapshot, first: string, last: string) {
  const dates: string[] = [];
  const byDiscipline = new Map<string, number>();
  let sessions = 0;
  for (const d of snap.dayRows.values()) {
    if (d.localDate < first || d.localDate > last) continue;
    dates.push(d.localDate);
    sessions += d.sessions;
    for (const [k, n] of Object.entries(d.disciplines)) byDiscipline.set(k, (byDiscipline.get(k) ?? 0) + n);
  }
  dates.sort();
  return { dates, byDiscipline, sessions };
}

const disciplinesOut = (byDiscipline: Map<string, number>) =>
  mostCommon(byDiscipline).map(([id, n]) => ({ id, name: disciplineName(id), sessions: n }));

type Badge = { id: string; title: string; tier: string | null };

function badgesIn(
  snap: Snapshot,
  held: readonly { achievementId: string; tier: string | null; unlockedOn: string }[],
  first: string,
  last: string,
): Badge[] {
  if (!snap.profile.gamificationEnabled) return [];
  const out: Badge[] = [];
  for (const a of held) {
    if (a.unlockedOn < first || a.unlockedOn > last) continue;
    const rule = RULE_BY_ID.get(a.achievementId);
    if (rule !== undefined) out.push({ id: rule.id, title: rule.title, tier: a.tier });
  }
  return out;
}

export const lastClosedWeek = (snap: Snapshot) =>
  addDays(weekStart(snap.today, snap.profile.weekStartsOn), -7);

export function buildRecap(
  snap: Snapshot,
  held: readonly { achievementId: string; tier: string | null; unlockedOn: string }[],
  anyDay: string,
) {
  const week = weekStart(anyDay, snap.profile.weekStartsOn);
  const end = addDays(week, 6);
  const main = snap.chains[0];
  const cell = main.result.weeks.find((c) => c.weekStart === week);
  const previous = main.result.weeks.find((c) => c.weekStart === addDays(week, -7));
  const w = workoutsIn(snap, week, end);
  if (cell === undefined && w.sessions === 0) return null;
  const status = cell?.status ?? "missed";
  return {
    week_start: week,
    week_end: end,
    status,
    verdict: VERDICTS[status] ?? "",
    days: cell?.days ?? w.dates.length,
    target: cell?.target ?? chainTarget(main),
    sessions: w.sessions,
    trained_on: w.dates,
    disciplines: disciplinesOut(w.byDiscipline),
    previous_days: previous?.days ?? null,
    streak: main.result.current,
    longest: main.result.longest,
    freezes_available: main.result.freezesAvailable,
    records: snap.events
      .filter((e) => e.rewarded && week <= e.day && e.day <= end)
      .map((e) => ({ label: recordLabel(e.key, snap.names), day: e.day })),
    badges: badgesIn(snap, held, week, end),
    this_week_target: main.result.thisWeekTarget,
  };
}

export type Recap = NonNullable<ReturnType<typeof buildRecap>>;

/** (title, body) for the notification version of a recap (the worker's weekly digest). */
export function digestLines(r: Recap): [string, string] {
  const plural = (n: number) => (n !== 1 ? "s" : "");
  const lines = [
    `${r.sessions} session${plural(r.sessions)} on ${r.days} day${plural(r.days)} against a target of ${r.target}. ${r.verdict}`,
    `Streak: ${r.streak} week${plural(r.streak)}.`,
  ];
  if (r.records.length) lines.push(`${r.records.length} new personal record${plural(r.records.length)}.`);
  if (r.badges.length) lines.push(`${r.badges.length} new badge${plural(r.badges.length)}.`);
  return [`Your week: ${r.verdict.split(".")[0]}`, lines.join("\n")];
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function buildYear(
  snap: Snapshot,
  held: readonly { achievementId: string; tier: string | null; unlockedOn: string }[],
  year: number,
) {
  const y = String(year).padStart(4, "0");
  const start = `${y}-01-01`;
  const dec31 = `${y}-12-31`;
  const end = dec31 < snap.today ? dec31 : snap.today;
  if (start > snap.today) return null;
  const w = workoutsIn(snap, start, end);
  if (w.sessions === 0) return null;
  const main = snap.chains[0].result;
  const weeks = main.weeks.filter((c) => c.weekStart.slice(0, 4) === y && c.status !== "open");
  const scored = weeks.filter((c) => c.status !== "paused");
  const perMonth = new Map<number, number>();
  const perWeekday = new Map<string, number>();
  for (const d of w.dates) {
    const m = Number(d.slice(5, 7));
    perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
    const wd = String(pyWeekday(d));
    perWeekday.set(wd, (perWeekday.get(wd) ?? 0) + 1);
  }
  const [bestMonth, bestMonthDays] = [...perMonth].sort((a, b) => b[1] - a[1])[0] ?? [1, 0];
  const [favourite] = mostCommon(perWeekday)[0] ?? ["0", 0];
  const records = snap.events.filter((e) => e.rewarded && e.day.slice(0, 4) === y);
  const top = [...records].sort((a, b) => b.gainPct - a.gainPct).slice(0, 5);
  return {
    year,
    complete: end === dec31,
    first_day: w.dates[0],
    days_trained: w.dates.length,
    sessions: w.sessions,
    weeks_kept: weeks.filter((c) => COUNTING.has(c.status)).length,
    weeks_closed: weeks.length,
    weeks_paused: weeks.filter((c) => c.status === "paused").length,
    consistency: scored.length ? pyRound(scored.reduce((n, c) => n + cellScore(c), 0) / scored.length) : 0,
    longest_streak: Math.max(0, ...weeks.map((c) => c.run)),
    best_month: { month: MONTHS[bestMonth - 1], days: bestMonthDays },
    favourite_weekday: WEEKDAYS[Number(favourite)],
    months: MONTHS.map((m, i) => ({ month: m.slice(0, 3), days: perMonth.get(i + 1) ?? 0 })),
    disciplines: disciplinesOut(w.byDiscipline),
    records_count: records.length,
    top_records: top.map((e) => ({ label: recordLabel(e.key, snap.names), gain_pct: e.gainPct, day: e.day })),
    badges: badgesIn(snap, held, start, end),
    milestones: main.milestonesHit
      .filter(([, wk]) => wk.slice(0, 4) === y)
      .map(([length, wk]) => ({ weeks: length, week_start: wk })),
  };
}

export function recordHistory(snap: Snapshot, key: string) {
  const best = snap.bests.get(key);
  if (best === undefined) return null;
  const events = snap.events.filter((e) => e.key === key);
  const points: Record<string, unknown>[] = [];
  const first = events[0];
  if (first !== undefined) points.push({ value: first.previous, day: null, kind: "first" });
  for (const e of events)
    points.push({
      value: e.value,
      day: e.day,
      kind: e.flagged ? "flagged" : "record",
      gain_pct: e.gainPct,
      workout_id: e.workoutId,
    });
  if (events.length === 0)
    points.push({ value: best.value, day: best.day, kind: "first", workout_id: best.workoutId });
  const [kind, subject] = splitKey(key);
  return {
    key,
    kind,
    subject,
    label: recordLabel(key, snap.names),
    current: best.value,
    since: best.day,
    points,
  };
}

export function xpBreakdown(snap: Snapshot) {
  const recent = [...snap.xpItems].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, 40);
  const weekly = new Map<string, number>();
  for (const i of snap.xpItems) {
    const w = weekStart(i.day, snap.profile.weekStartsOn);
    weekly.set(w, (weekly.get(w) ?? 0) + i.amount);
  }
  return {
    level: snap.level,
    by_source: snap.xp.by_source,
    season_xp: snap.xp.season,
    recent: recent.map((i) => ({ source: i.source, amount: i.amount, date: i.day })),
    weekly: [...weekly].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-26),
  };
}

export function achievementsPayload(
  snap: Snapshot,
  held: readonly { achievementId: string; tier: string | null; unlockedOn: string }[],
  population: number,
  counts: readonly { achievementId: string; tier: string | null; n: number }[],
) {
  const byRule = new Map<string, Record<string, string>>();
  for (const a of held) {
    const m = byRule.get(a.achievementId) ?? {};
    m[a.tier ?? "single"] = a.unlockedOn;
    byRule.set(a.achievementId, m);
  }
  const holders = new Map(counts.map((c) => [`${c.achievementId}:${c.tier ?? "single"}`, c.n]));
  const pop = population || 1;
  return {
    achievements: RULES.map((rule) => {
      const unlocked = byRule.get(rule.id) ?? {};
      const secret = rule.hidden && Object.keys(unlocked).length === 0;
      const tiers = isTiered(rule) ? [...TIERS] : ["single"];
      return {
        id: rule.id,
        title: secret ? "Hidden" : rule.title,
        description: secret ? "Keep training - some things are found, not chased." : rule.description,
        category: rule.category,
        hidden: rule.hidden,
        secret,
        tiered: isTiered(rule),
        unit: rule.unit,
        thresholds: secret ? [] : [...rule.thresholds],
        tier_names: [...rule.tier_names],
        unlocked,
        progress: secret ? null : ruleProgress(rule, snap.context),
        rarity: Object.fromEntries(
          tiers.map((t) => [t, pyRound(((holders.get(`${rule.id}:${t}`) ?? 0) / pop) * 100, 1)]),
        ),
      };
    }),
    unlocked_count: held.length,
  };
}

// ---- monthly recap ------------------------------------------------------------------------------------------

export function monthBounds(month: string): [string, string] {
  const first = `${month}-01`;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [first, last];
}

export function buildMonth(
  snap: Snapshot,
  month: string,
  lifts: readonly { key: string; localDate: string; value: number }[],
  before: readonly { key: string; best: number }[],
) {
  const [first, last] = monthBounds(month);
  const w = workoutsIn(snap, first, last);
  if (w.sessions === 0) return null;
  const during = new Map<string, number>();
  const days = new Map<string, Set<string>>();
  for (const r of lifts) {
    const ex = r.key.slice(5);
    during.set(ex, Math.max(during.get(ex) ?? 0, r.value));
    const s = days.get(ex) ?? new Set<string>();
    s.add(r.localDate);
    days.set(ex, s);
  }
  const then = new Map(before.map((b) => [b.key.slice(5), b.best]));
  const ranked = [...days.keys()].sort((a, b) => {
    const d = (days.get(b)?.size ?? 0) - (days.get(a)?.size ?? 0);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
  const out = ranked.slice(0, 5).map((ex) => {
    const now = during.get(ex) ?? 0;
    const prev = then.get(ex) ?? 0;
    return {
      exercise_id: ex,
      name: exerciseMeta(ex, snap.customs).name,
      sessions: days.get(ex)?.size ?? 0,
      best_e1rm: pyRound(now, 1),
      previous_best: prev ? pyRound(prev, 1) : null,
      change_pct: prev ? pyRound(((now - prev) / prev) * 100, 1) : null,
    };
  });
  const weeks = snap.chains[0].result.weeks.filter(
    (c) => first <= addDays(c.weekStart, 6) && c.weekStart <= last,
  );
  const steadiest = out[0];
  return {
    month,
    starts_on: first,
    ends_on: last,
    complete: last < snap.today,
    sessions: w.sessions,
    active_days: w.dates.length,
    weeks_kept: weeks.filter((c) => c.status === "kept").length,
    weeks: weeks.filter((c) => c.status !== "open").length,
    records: snap.events.filter((e) => e.rewarded && first <= e.day && e.day <= last).length,
    lifts: out,
    steadiest: steadiest !== undefined && steadiest.sessions > 1 ? steadiest.name : null,
    pr_streak: snap.prStreak.current,
  };
}

// ---- progress -----------------------------------------------------------------------------------------------

export interface ProgressRows {
  workouts: readonly {
    d: string;
    discipline: string;
    n: number;
    minutes: number;
    distance_m: number;
    feel_sum: number;
    feel_n: number;
    effort_sum: number;
    effort_n: number;
  }[];
  sets: readonly { d: string; exercise_id: string; sets: number; tonnage: number }[];
  body: readonly {
    d: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    waist_cm: number | null;
    resting_hr: number | null;
    sleep_hours: number | null;
    has_metric: number;
    has_weight: number;
  }[];
}

export function buildProgress(snap: Snapshot, weeks: number, rows: ProgressRows) {
  const wso = snap.profile.weekStartsOn;
  const thisWeek = weekStart(snap.today, wso);
  const first = addDays(thisWeek, -7 * (weeks - 1));
  type Bucket = {
    sessions: number;
    days: Set<string>;
    minutes: number;
    distance: number;
    tonnage: number;
    sets: number;
    byDiscipline: Record<string, number>;
    feel: [number, number];
    effort: [number, number];
  };
  const series = new Map<string, Bucket>();
  for (let i = 0; i < weeks; i++)
    series.set(addDays(first, 7 * i), {
      sessions: 0,
      days: new Set(),
      minutes: 0,
      distance: 0,
      tonnage: 0,
      sets: 0,
      byDiscipline: {},
      feel: [0, 0],
      effort: [0, 0],
    });
  for (const r of rows.workouts) {
    const b = series.get(weekStart(r.d, wso));
    if (b === undefined) continue;
    b.sessions += r.n;
    b.days.add(r.d);
    b.minutes += r.minutes;
    b.distance += r.distance_m / 1000;
    b.byDiscipline[r.discipline] = (b.byDiscipline[r.discipline] ?? 0) + r.n;
    b.feel = [b.feel[0] + r.feel_sum, b.feel[1] + r.feel_n];
    b.effort = [b.effort[0] + r.effort_sum, b.effort[1] + r.effort_n];
  }
  const muscleWeek = new Map<string, number>();
  const muscle4w = new Map<string, number>();
  const last7 = addDays(snap.today, -6);
  const last28 = addDays(snap.today, -27);
  for (const r of rows.sets) {
    const b = series.get(weekStart(r.d, wso));
    if (b === undefined) continue;
    b.sets += r.sets;
    b.tonnage += r.tonnage;
    const meta = exerciseMeta(r.exercise_id, snap.customs);
    for (const [target, since] of [
      [muscleWeek, last7],
      [muscle4w, last28],
    ] as const) {
      if (r.d < since) continue;
      for (const m of meta.primary) target.set(m, (target.get(m) ?? 0) + r.sets);
      for (const m of meta.secondary) target.set(m, (target.get(m) ?? 0) + 0.5 * r.sets);
    }
  }
  const cells = new Map(snap.chains[0].result.weeks.map((c) => [c.weekStart, c]));
  return {
    weeks: [...series].map(([ws, b]) => ({
      week_start: ws,
      sessions: b.sessions,
      active_days: b.days.size,
      minutes: b.minutes,
      distance_km: pyRound(b.distance, 2),
      tonnage_kg: pyRound(b.tonnage),
      sets: b.sets,
      by_discipline: b.byDiscipline,
      feel: b.feel[1] ? pyRound(b.feel[0] / b.feel[1], 1) : null,
      effort: b.effort[1] ? pyRound(b.effort[0] / b.effort[1], 1) : null,
      target: cells.get(ws)?.target ?? null,
      status: cells.get(ws)?.status ?? null,
    })),
    muscles: Object.entries(MUSCLES).map(([id, name]) => ({
      id,
      name,
      last_7_days: pyRound(muscleWeek.get(id) ?? 0, 1),
      weekly_avg_4w: pyRound((muscle4w.get(id) ?? 0) / 4, 1),
    })),
    body: rows.body
      .filter((r) => r.d >= first)
      .map((r) => ({
        date: r.d,
        weight_kg: r.has_weight && r.weight_kg !== null ? pyRound(r.weight_kg, 2) : null,
        body_fat_pct: r.has_metric ? r.body_fat_pct : null,
        waist_cm: r.has_metric ? r.waist_cm : null,
        resting_hr: r.has_metric ? r.resting_hr : null,
        sleep_hours: r.has_metric ? r.sleep_hours : null,
      })),
  };
}
