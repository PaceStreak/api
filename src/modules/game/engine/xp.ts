/**
 * XP and levels (Python `app/game/xp.py`, `levels.py`). Pure. Rewards showing up and logging honestly, never
 * lifting heavier or doing more: two people of very different strength earn identical XP for the same week.
 */
import { pyRound } from "../../../lib/format.ts";
import { seasonBounds } from "../../../lib/time.ts";
import { addDays, weekStart } from "./days.ts";
import type { TargetFor } from "./streak.ts";

export const DAY_XP = 20;
export const SECOND_SESSION_XP = 5;
export const EXTRA_DAY_XP = 5;
export const DETAIL_XP = 5;
export const KEPT_WEEK_XP = 50;
export const PR_XP = 25;
export const ACHIEVEMENT_XP: Readonly<Record<string, number>> = {
  single: 50,
  bronze: 50,
  silver: 100,
  gold: 200,
};
export const MILESTONE_XP: ReadonlyMap<number, number> = new Map([
  [4, 100],
  [8, 150],
  [12, 250],
  [26, 500],
  [52, 1000],
  [104, 1500],
  [156, 2000],
]);
export const HABIT_DAY_XP = 5;
export const HABIT_DAY_CAP = 20;
export const HABIT_KEPT_WEEK_XP = 10;

export interface DayActivity {
  day: string;
  sessions: number;
  detailed: boolean;
}

export interface XpItem {
  source: string;
  amount: number;
  day: string;
}

/** Training XP. `days` order decides item order (it is the order `/me/xp` breaks ties in). */
export function computeXp(
  days: readonly DayActivity[],
  weekStartsOn: number,
  targetFor: TargetFor,
  keptWeeks: readonly string[],
  milestones: readonly (readonly [number, string])[],
  prDays: readonly string[],
  achievements: readonly (readonly [string | null, string])[],
): XpItem[] {
  const items: XpItem[] = [];
  const byWeek = new Map<string, DayActivity[]>();
  for (const a of days) {
    const w = weekStart(a.day, weekStartsOn);
    const list = byWeek.get(w);
    if (list === undefined) byWeek.set(w, [a]);
    else list.push(a);
  }
  for (const [week, weekDays] of byWeek) {
    const allowance = targetFor(week) + 1;
    // The snapshot passes days in date order; sort only when a caller did not.
    const inOrder = weekDays.every((a, i) => i === 0 || (weekDays[i - 1] as DayActivity).day <= a.day);
    const sorted = inOrder
      ? weekDays
      : [...weekDays].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    sorted.forEach((a, index) => {
      items.push({ source: "training_day", amount: index < allowance ? DAY_XP : EXTRA_DAY_XP, day: a.day });
      if (a.sessions > 1) items.push({ source: "second_session", amount: SECOND_SESSION_XP, day: a.day });
      if (a.detailed) items.push({ source: "detail", amount: DETAIL_XP, day: a.day });
    });
  }
  for (const w of keptWeeks) items.push({ source: "kept_week", amount: KEPT_WEEK_XP, day: addDays(w, 6) });
  for (const [length, w] of milestones) {
    const amount = MILESTONE_XP.get(length) ?? 0;
    if (amount) items.push({ source: "milestone", amount, day: addDays(w, 6) });
  }
  for (const d of prDays) items.push({ source: "pr", amount: PR_XP, day: d });
  for (const [tier, d] of achievements)
    items.push({ source: "achievement", amount: ACHIEVEMENT_XP[tier ?? "single"] ?? 50, day: d });
  return items;
}

export interface HabitXpInput {
  kind: string;
  weeklyTarget: number;
  doneDays: readonly string[];
  cells: readonly { weekStart: string; status: string }[];
}

/**
 * Habit XP with caps so it cannot be farmed: each habit pays for at most its weekly target of days a week, all
 * habits together at most HABIT_DAY_CAP a day, a kept habit week pays HABIT_KEPT_WEEK_XP. A habit being broken
 * ("quit") pays only for kept weeks.
 */
export function habitXp(habits: readonly HabitXpInput[], weekStartsOn: number, today: string): XpItem[] {
  const perDay = new Map<string, number>();
  const items: XpItem[] = [];
  for (const h of habits) {
    if (h.kind !== "quit") {
      const byWeek = new Map<string, string[]>();
      for (const d of h.doneDays) {
        const w = weekStart(d, weekStartsOn);
        const list = byWeek.get(w);
        if (list === undefined) byWeek.set(w, [d]);
        else list.push(d);
      }
      for (const list of byWeek.values()) {
        for (const d of [...list].sort().slice(0, Math.max(0, h.weeklyTarget)))
          perDay.set(d, (perDay.get(d) ?? 0) + HABIT_DAY_XP);
      }
    }
    for (const c of h.cells) {
      const end = addDays(c.weekStart, 6);
      if (c.status === "kept" && end < today)
        items.push({ source: "habit_week", amount: HABIT_KEPT_WEEK_XP, day: end });
    }
  }
  for (const [d, amount] of perDay)
    items.push({ source: "habit_day", amount: Math.min(HABIT_DAY_CAP, amount), day: d });
  return items;
}

export interface XpSummary {
  total: number;
  season: number;
  by_source: Record<string, number>;
}

export function summarise(items: readonly XpItem[], season: string): XpSummary {
  const [first, last] = seasonBounds(season);
  let total = 0;
  let seasonXp = 0;
  const bySource: Record<string, number> = {};
  for (const i of items) {
    total += i.amount;
    // Season ids change four times a year: compare the quarter by its month range instead of formatting one.
    if (i.day >= first && i.day <= last) seasonXp += i.amount;
    bySource[i.source] = (bySource[i.source] ?? 0) + i.amount;
  }
  return { total, season: seasonXp, by_source: bySource };
}

// ---- levels ---------------------------------------------------------------------------------------------------

/** XP needed to go from level n to n+1. */
export const xpForLevel = (n: number) => pyRound(80 * n ** 1.6);

export function levelForXp(total: number): number {
  let level = 1;
  let acc = 0;
  for (;;) {
    acc += xpForLevel(level);
    if (total < acc) return level;
    level++;
  }
}

export function xpToReach(level: number): number {
  let sum = 0;
  for (let n = 1; n < level; n++) sum += xpForLevel(n);
  return sum;
}

const TITLES: readonly [number, string][] = [
  [50, "Veteran"],
  [35, "Seasoned"],
  [20, "Committed"],
  [10, "Consistent"],
  [5, "Regular"],
  [1, "Novice"],
];

export function titleForLevel(level: number): string {
  for (const [min, title] of TITLES) if (level >= min) return title;
  return "Novice";
}

export interface LevelProgress {
  level: number;
  title: string;
  total_xp: number;
  into_level: number;
  level_span: number;
  to_next: number;
}

export function levelProgress(total: number): LevelProgress {
  const level = levelForXp(total);
  const span = xpForLevel(level);
  const into = total - xpToReach(level);
  return {
    level,
    title: titleForLevel(level),
    total_xp: total,
    into_level: into,
    level_span: span,
    to_next: Math.max(0, span - into),
  };
}
