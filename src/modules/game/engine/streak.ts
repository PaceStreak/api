/**
 * Week-based streaks (Python `app/game/streak.py`, spec/game.md §2.2). Pure: no I/O, no clock, `today` is passed
 * in. Dates are `YYYY-MM-DD` strings throughout, which compare chronologically as strings.
 *
 * The unit is the kept week: a week is kept when the distinct days trained reach that week's target (and every
 * requirement in force). The open week never breaks anything; a repair or an automatically spent freeze forgives
 * a missed week; a pause covering at least PAUSE_MIN_DAYS of a week shelters it.
 */
import type { WeekStatus } from "../../../db/schema/game.ts";
import { pyRound } from "../../../lib/format.ts";
import { addDays, daysBetween, weekStart } from "./days.ts";

export const FREEZE_EVERY = 4;
export const FREEZE_CAP = 2;
export const LOOKBACK_WEEKS = 260;
export const REPAIR_WINDOW_WEEKS = 2;
export const MILESTONES: ReadonlySet<number> = new Set([4, 8, 12, 26, 52, 104, 156]);
/** A pause must cover most of a week to shelter it. */
export const PAUSE_MIN_DAYS = 4;

export interface Requirement {
  disciplines: ReadonlySet<string>;
  days: number;
}

export interface WeekCell {
  weekStart: string;
  days: number;
  target: number;
  status: WeekStatus;
  run: number;
  /** The weakest requirement's completion, 0-1; 1 without requirements. */
  ratio: number;
}

export const COUNTING: ReadonlySet<WeekStatus> = new Set(["kept", "frozen", "repaired"]);

/** 0-100 adherence, capped at the target; with requirements the weakest part of the week decides. */
export function cellScore(c: Pick<WeekCell, "days" | "target" | "ratio">): number {
  const base = c.target ? Math.min(1, c.days / c.target) : 1;
  return pyRound(Math.min(base, c.ratio) * 100);
}

export interface ChainResult {
  current: number;
  longest: number;
  weeks: WeekCell[];
  freezesAvailable: number;
  thisWeekDays: number;
  thisWeekTarget: number;
  daysLeft: number;
  needed: number;
  atRisk: boolean;
  willFreeze: boolean;
  repairableWeek: string | null;
  runStarted: string | null;
  consistency: number;
  milestonesHit: [number, string][];
  pausedNow: boolean;
  consistency12: number;
  consistency52: number;
  requirementsProgress: [Requirement, number][];
  wagersWon: string[];
}

export type TargetFor = (week: string) => number;
export type RequirementsFor = (week: string) => Requirement[];

/**
 * Target in force for a week. Weeks before the first point use the first target, so a chain created today
 * still judges last month's sessions by something sensible. No points means `fallback`.
 */
export function targetResolver(
  history: readonly { from: string; target: number }[],
  fallback = 3,
): TargetFor {
  const points = [...history]
    .map((h) => [h.from, Math.trunc(Number(h.target))] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return (week) => {
    const first = points[0];
    if (first === undefined) return fallback;
    let current = first[1];
    for (const [start, target] of points) {
      if (start <= week) current = target;
      else break;
    }
    return current;
  };
}

/** Requirements in force for a week. Unlike targets, weeks before the first point have none. */
export function requirementsResolver(
  history: readonly {
    from: string;
    requirements?: readonly { disciplines: readonly string[]; days: number }[];
  }[],
): RequirementsFor {
  const points = [...history]
    .map(
      (h) =>
        [
          h.from,
          (h.requirements ?? []).map((r) => ({
            disciplines: new Set(r.disciplines),
            days: Math.trunc(r.days),
          })),
        ] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return (week) => {
    let current: Requirement[] = [];
    for (const [start, reqs] of points) {
      if (start <= week) current = reqs;
      else break;
    }
    return current;
  };
}

function meanScore(cells: readonly WeekCell[]): number {
  if (cells.length === 0) return 0;
  let sum = 0;
  for (const c of cells) sum += cellScore(c);
  return pyRound(sum / cells.length);
}

export interface ChainOptions {
  repaired?: Iterable<string>;
  repairAvailable?: boolean;
  pausedDays?: Iterable<string>;
  requirementsFor?: RequirementsFor | null;
  /** Disciplines trained per day; only consulted when requirements apply. */
  dayDisciplines?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Week start -> promised days. */
  wagers?: ReadonlyMap<string, number> | null;
}

export function computeChain(
  activeDays: Iterable<string>,
  today: string,
  weekStartsOn: number,
  targetFor: TargetFor,
  opts: ChainOptions = {},
): ChainResult {
  // A Set passed in (a habit's done days, often ~1,800 for a five-year quit habit) is only read: no copy.
  const days: ReadonlySet<string> = activeDays instanceof Set ? activeDays : new Set(activeDays);
  const dayDisciplines = opts.dayDisciplines ?? new Map<string, ReadonlySet<string>>();
  const requirementsFor = opts.requirementsFor ?? null;
  const requirementDays = (week: string, req: Requirement): number => {
    let n = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(week, i);
      if (d > today) continue;
      const ds = dayDisciplines.get(d);
      if (ds === undefined) continue;
      for (const x of ds) {
        if (req.disciplines.has(x)) {
          n++;
          break;
        }
      }
    }
    return n;
  };

  const repairedWeeks = new Set(opts.repaired ?? []);
  const currentWeek = weekStart(today, weekStartsOn);

  const pausedPerWeek = new Map<string, number>();
  for (const d of new Set(opts.pausedDays ?? [])) {
    const w = weekStart(d, weekStartsOn);
    pausedPerWeek.set(w, (pausedPerWeek.get(w) ?? 0) + 1);
  }
  const pausedWeeks = new Set([...pausedPerWeek].filter(([, n]) => n >= PAUSE_MIN_DAYS).map(([w]) => w));

  const perWeek = new Map<string, number>();
  let earliest: string | null = null;
  for (const d of days) {
    if (d > today) continue;
    const w = weekStart(d, weekStartsOn);
    perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
    if (earliest === null || w < earliest) earliest = w;
  }
  const floor = addDays(currentWeek, -7 * (LOOKBACK_WEEKS - 1));
  let start = earliest ?? currentWeek;
  if (start < floor) start = floor;

  const wagers = opts.wagers ?? new Map<string, number>();
  const cells: WeekCell[] = [];
  const milestones: [number, string][] = [];
  const wagersWon: string[] = [];
  let freezes = 0;
  let keptTowardFreeze = 0;
  let run = 0;
  let longest = 0;
  let runStarted: string | null = null;

  for (let w = start; w <= currentWeek; w = addDays(w, 7)) {
    const count = perWeek.get(w) ?? 0;
    const target = Math.max(1, targetFor(w));
    const reqs = requirementsFor ? requirementsFor(w) : [];
    let ratio = 1;
    for (const r of reqs) {
      if (r.days > 0) ratio = Math.min(ratio, Math.min(1, requirementDays(w, r) / r.days));
    }
    let status: WeekStatus;
    if (count >= target && ratio >= 1) status = "kept";
    else if (pausedWeeks.has(w)) status = "paused";
    else if (w === currentWeek) status = "open";
    else if (repairedWeeks.has(w)) status = "repaired";
    else if (freezes > 0 && run > 0) {
      status = "frozen";
      freezes--;
    } else status = "missed";

    if (status === "kept" && w !== currentWeek) {
      keptTowardFreeze++;
      if (keptTowardFreeze >= FREEZE_EVERY) {
        keptTowardFreeze = 0;
        freezes = Math.min(FREEZE_CAP, freezes + 1);
      }
      const promised = wagers.get(w);
      if (promised !== undefined && count >= promised) {
        wagersWon.push(w);
        freezes = Math.min(FREEZE_CAP, freezes + 1);
      }
    }
    if (COUNTING.has(status)) {
      if (run === 0) runStarted = w;
      run++;
      if (MILESTONES.has(run)) milestones.push([run, w]);
    } else if (status === "missed") {
      run = 0;
      runStarted = null;
    }
    longest = Math.max(longest, run);
    cells.push({ weekStart: w, days: count, target, status, run, ratio });
  }

  const thisWeek = cells[cells.length - 1] as WeekCell;
  const weekEnd = addDays(currentWeek, 6);
  const daysLeft = daysBetween(today, weekEnd) + (days.has(today) ? 0 : 1);
  const thisWeekPaused = thisWeek.status === "paused";
  const progress: [Requirement, number][] = (requirementsFor ? requirementsFor(currentWeek) : []).map((r) => [
    r,
    requirementDays(currentWeek, r),
  ]);
  let owed = 0;
  for (const [r, done] of progress) owed += Math.max(0, r.days - done);
  const shortfall = Math.max(thisWeek.target - thisWeek.days, owed);
  const needed = thisWeekPaused || thisWeek.status === "kept" ? 0 : Math.max(0, shortfall);

  let repairable: string | null = null;
  if (opts.repairAvailable) {
    const closed = cells.slice(0, -1).slice(-REPAIR_WINDOW_WEEKS);
    for (let i = closed.length - 1; i >= 0; i--) {
      const c = closed[i] as WeekCell;
      if (c.status === "missed") {
        repairable = c.weekStart;
        break;
      }
    }
  }

  const closedCells = cells.slice(0, -1).filter((c) => c.status !== "paused");
  return {
    current: run,
    longest,
    weeks: cells,
    freezesAvailable: freezes,
    thisWeekDays: thisWeek.days,
    thisWeekTarget: thisWeek.target,
    daysLeft,
    needed,
    atRisk: needed > 0 && needed >= daysLeft,
    willFreeze: needed > daysLeft && freezes > 0 && run > 0,
    repairableWeek: repairable,
    runStarted,
    consistency: meanScore(closedCells.slice(-4)),
    milestonesHit: milestones,
    pausedNow: thisWeekPaused,
    consistency12: meanScore(closedCells.slice(-12)),
    consistency52: meanScore(closedCells.slice(-52)),
    requirementsProgress: progress,
    wagersWon,
  };
}

// ---- pauses (Python app/training/pauses.py) -------------------------------------------------------------------

export const PAUSE_MAX_DAYS = 84;
export const PAUSE_BACKDATE_DAYS = 14;
export const PAUSE_LEAD_DAYS = 30;
export const PAUSE_BUDGET_DAYS = 120;
export const PAUSE_BUDGET_WINDOW = 365;

export interface Span {
  startsOn: string;
  /** Inclusive; null while open. */
  endsOn: string | null;
}

/** An open pause runs to the cap; a closed one ends at the earlier of its end and the cap. */
export function effectiveEnd(s: Span): string {
  const cap = addDays(s.startsOn, PAUSE_MAX_DAYS - 1);
  return s.endsOn === null || s.endsOn > cap ? cap : s.endsOn;
}

export function spanDays(s: Span): string[] {
  const end = effectiveEnd(s);
  const out: string[] = [];
  for (let d = s.startsOn; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const spanActive = (s: Span, today: string) => s.startsOn <= today && today <= effectiveEnd(s);
const overlaps = (a: Span, b: Span) => a.startsOn <= effectiveEnd(b) && b.startsOn <= effectiveEnd(a);

export function pausedDays(spans: Iterable<Span>): Set<string> {
  const out = new Set<string>();
  for (const s of spans) for (const d of spanDays(s)) out.add(d);
  return out;
}

export function pauseDaysUsed(spans: Iterable<Span>, today: string): number {
  const since = addDays(today, -(PAUSE_BUDGET_WINDOW - 1));
  let n = 0;
  for (const d of pausedDays(spans)) if (d >= since) n++;
  return n;
}

/** The user-facing reason a new pause breaks a rule, or null when it is allowed (for the training unit). */
export function pauseError(next: Span, existing: readonly Span[], today: string): string | null {
  if (next.startsOn < addDays(today, -PAUSE_BACKDATE_DAYS))
    return `A pause can start at most ${PAUSE_BACKDATE_DAYS} days ago.`;
  if (next.startsOn > addDays(today, PAUSE_LEAD_DAYS))
    return `A pause can be planned at most ${PAUSE_LEAD_DAYS} days ahead.`;
  if (next.endsOn !== null) {
    if (next.endsOn < next.startsOn) return "A pause cannot end before it starts.";
    if (daysBetween(next.startsOn, next.endsOn) + 1 > PAUSE_MAX_DAYS)
      return `One pause can last at most ${Math.floor(PAUSE_MAX_DAYS / 7)} weeks.`;
  }
  if (existing.some((s) => overlaps(next, s))) return "That overlaps a pause you already have.";
  if (pauseDaysUsed([...existing, next], today) > PAUSE_BUDGET_DAYS)
    return `Pauses are limited to ${PAUSE_BUDGET_DAYS} days a year. Set an end date, or end an earlier pause sooner.`;
  return null;
}

/** Inclusive end when a pause is ended today (today is the first day back); null means delete it instead. */
export function pauseEndFor(s: Span, today: string): string | null {
  if (s.startsOn >= today) return null;
  const yesterday = addDays(today, -1);
  const end = effectiveEnd(s);
  return yesterday < end ? yesterday : end;
}
