/**
 * Habit streaks and strength (Python `app/habits/engine.py`, spec/habits.md §2.1). Pure: logs in, verdicts out.
 *
 * A habit's streak is the training streak's week rule (game `computeChain`): a week is kept when the habit was
 * done on `weekly_target` days. Quit habits count clean days: a day is clean unless a slip is logged on it, and
 * only days from the habit's start count. Strength is a slow average of how much of each week's target was met.
 */
import { pyRound } from "../../lib/format.ts";
import { type ChainResult, computeChain, type WeekCell } from "../game/service.ts";

/** Weight of each new week in the strength average: about a month's memory. */
export const STRENGTH_ALPHA = 0.25;

export interface HabitDay {
  day: string;
  amount: number;
  note?: string | null;
}

export interface HabitView {
  doneDays: Set<string>;
  chain: ChainResult;
  strength: number;
  total: number;
  todayAmount: number;
  cleanRun: number | null;
  bestCleanRun: number | null;
  lastSlip: string | null;
}

// Day numbers (days since 1970-01-01) keep the per-day loops of quit habits cheap.
const DAY = 86_400_000;
const num = (d: string) =>
  Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY;
const str = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
/** Python `weekday()`: Monday = 0. 1970-01-01 was a Thursday. */
const weekdayOf = (n: number) => (((n + 3) % 7) + 7) % 7;

export function isDone(kind: string, amount: number, dailyGoal: number | null): boolean {
  if (kind === "quit") return amount <= 0;
  if (kind === "check") return amount > 0;
  return amount >= (dailyGoal || 1);
}

export function doneDays(
  kind: string,
  dailyGoal: number | null,
  logs: readonly HabitDay[],
  startedOn: string,
  today: string,
): Set<string> {
  const out = new Set<string>();
  if (kind !== "quit") {
    for (const e of logs) {
      if (startedOn <= e.day && e.day <= today && isDone(kind, e.amount, dailyGoal)) out.add(e.day);
    }
    return out;
  }
  const slips = new Set<string>();
  for (const e of logs) if (e.amount > 0) slips.add(e.day);
  for (let d = num(startedOn), end = num(today); d <= end; d++) {
    const s = str(d);
    if (!slips.has(s)) out.add(s);
  }
  return out;
}

/** Whether a habit is planned for `day` (Monday = bit 0; no mask = every day). */
export function scheduled(daysMask: number | null, day: string): boolean {
  return daysMask === null || ((daysMask >> weekdayOf(num(day))) & 1) === 1;
}

/**
 * A habit started mid-week can only be done on the days left in that week, so its first week asks for no more
 * than those (counting only planned days when it has a schedule).
 */
export function firstWeekTarget(
  weeklyTarget: number,
  startedOn: string,
  week: string,
  daysMask: number | null = null,
): number {
  const w = num(week);
  const s = num(startedOn);
  if (w <= s && s < w + 7) {
    let possible = 0;
    for (let d = s; d < w + 7; d++)
      if (daysMask === null || ((daysMask >> weekdayOf(d)) & 1) === 1) possible++;
    return Math.max(1, Math.min(weeklyTarget, possible || 1));
  }
  return weeklyTarget;
}

/** The days a single-habit pause covers, up to today. */
export function pauseDays(pausedFrom: string | null, pausedUntil: string | null, today: string): Set<string> {
  const out = new Set<string>();
  if (pausedFrom === null) return out;
  const end = pausedUntil !== null && pausedUntil < today ? pausedUntil : today;
  for (let d = num(pausedFrom), e = num(end); d <= e; d++) out.add(str(d));
  return out;
}

/**
 * 0-100: a slow average of how much of each week's target was met. Paused weeks are skipped, and the week in
 * progress only counts once it is met.
 */
export function strength(weeks: readonly WeekCell[]): number {
  const values: number[] = [];
  for (const c of weeks) {
    if (c.status !== "paused" && (c.status !== "open" || c.days >= c.target))
      values.push(Math.min(1, c.days / c.target));
  }
  const first = values[0];
  if (first === undefined) {
    for (let i = weeks.length - 1; i >= 0; i--) {
      const c = weeks[i] as WeekCell;
      if (c.status === "open") return pyRound(Math.min(1, c.days / c.target) * 100);
    }
    return 0;
  }
  let score = first;
  for (let i = 1; i < values.length; i++) score += STRENGTH_ALPHA * ((values[i] as number) - score);
  return pyRound(score * 100);
}

export interface ViewInput {
  kind: string;
  dailyGoal: number | null;
  weeklyTarget: number;
  startedOn: string;
  logs: readonly HabitDay[];
  today: string;
  weekStartsOn: number;
  pausedDays: ReadonlySet<string>;
  daysMask?: number | null;
}

export function viewHabit(h: ViewInput): HabitView {
  const mask = h.daysMask ?? null;
  const done = doneDays(h.kind, h.dailyGoal, h.logs, h.startedOn, h.today);
  const chain = computeChain(
    done,
    h.today,
    h.weekStartsOn,
    (week) => firstWeekTarget(h.weeklyTarget, h.startedOn, week, mask),
    { pausedDays: h.pausedDays },
  );
  const byDay = new Map<string, number>();
  for (const e of h.logs) byDay.set(e.day, e.amount);
  let total = 0;
  if (h.kind !== "quit") for (const [d, a] of byDay) if (d <= h.today) total += a;
  const view: HabitView = {
    doneDays: done,
    chain,
    strength: strength(chain.weeks),
    total: pyRound(total, 2),
    todayAmount: byDay.get(h.today) ?? 0,
    cleanRun: null,
    bestCleanRun: null,
    lastSlip: null,
  };
  if (h.kind === "quit") {
    for (const [d, a] of byDay) {
      if (a > 0 && h.startedOn <= d && d <= h.today && (view.lastSlip === null || d > view.lastSlip))
        view.lastSlip = d;
    }
    const start = num(h.startedOn);
    const end = num(h.today);
    let run = 0;
    for (let d = end; d >= start && done.has(str(d)); d--) run++;
    let best = 0;
    let current = 0;
    for (let d = start; d <= end; d++) {
      current = done.has(str(d)) ? current + 1 : 0;
      if (current > best) best = current;
    }
    view.cleanRun = run;
    view.bestCleanRun = best;
  }
  return view;
}

/** Python `_fit_schedule`: picking days sets the target to their count unless a smaller one was chosen. */
export function fitSchedule(
  h: { kind: string; daysMask: number | null; weeklyTarget: number },
  explicitTarget: boolean,
): void {
  if (h.kind === "quit") {
    h.daysMask = null;
    return;
  }
  if (h.daysMask === null) return;
  let planned = 0;
  for (let m = h.daysMask; m > 0; m >>= 1) planned += m & 1;
  if (!explicitTarget || h.weeklyTarget > planned) h.weeklyTarget = planned;
}
