/**
 * Weekly quests, the PR streak, shared streaks and smart reminders (Python `quests.py`, `joint.py`,
 * `reminders.py`). Pure. The quest pool and the deterministic pick live in src/catalog/quests.ts.
 */
import { PR_BLOCK_ANCHOR, PR_BLOCK_DAYS, type QuestDef, questsFor } from "../../../catalog/quests.ts";
import { addDays, daysBetween, weekStart } from "./days.ts";

export interface WeekFacts {
  activeDays: ReadonlySet<string>;
  patterns: ReadonlySet<string>;
  rpeSets: number;
  shortSessions: number;
  newExercises: number;
  restDays: number;
  wakingWeighDays: number;
  habitsKept: number;
  habitsTotal: number;
}

export function weekFacts(f: Partial<WeekFacts> = {}): WeekFacts {
  return {
    activeDays: new Set(),
    patterns: new Set(),
    rpeSets: 0,
    shortSessions: 0,
    newExercises: 0,
    restDays: 0,
    wakingWeighDays: 0,
    habitsKept: 0,
    habitsTotal: 0,
    ...f,
  };
}

const any = (s: ReadonlySet<string>, xs: readonly string[]) => xs.some((x) => s.has(x));

export function progressOf(q: QuestDef, f: WeekFacts, week: string): number {
  switch (q.id) {
    case "early_week": {
      const cut = addDays(week, 3);
      for (const d of f.activeDays) if (d < cut) return 1;
      return 0;
    }
    case "balanced":
      return (
        Number(any(f.patterns, ["push_h", "push_v"])) +
        Number(any(f.patterns, ["pull_h", "pull_v"])) +
        Number(any(f.patterns, ["squat", "hinge", "lunge"]))
      );
    case "rpe":
      return f.rpeSets;
    case "short_counts":
      return f.shortSessions;
    case "new_exercise":
      return f.newExercises;
    case "rest_day":
      return f.restDays;
    case "morning_weigh":
      return f.wakingWeighDays;
    case "habit_week":
      return Number(f.habitsTotal > 0 && f.habitsKept >= f.habitsTotal);
    default:
      return 0;
  }
}

export interface QuestWeek {
  weekStart: string;
  quests: [QuestDef, number][];
}

export const questsDone = (qw: QuestWeek) => qw.quests.filter(([q, p]) => p >= q.goal).map(([q]) => q);

export function computeQuests(
  weeks: readonly string[],
  factsFor: (week: string) => WeekFacts,
  firstWeighIn: string | null,
  paused: ReadonlySet<string>,
  firstHabit: string | null = null,
): QuestWeek[] {
  const out: QuestWeek[] = [];
  for (const w of weeks) {
    if (paused.has(w)) continue;
    const facts = factsFor(w);
    const picks = questsFor(
      w,
      firstWeighIn !== null && firstWeighIn < w,
      firstHabit !== null && firstHabit < w,
    );
    out.push({ weekStart: w, quests: picks.map((q) => [q, progressOf(q, facts, w)]) });
  }
  return out;
}

export function weeksBetween(first: string, last: string, weekStartsOn: number): string[] {
  const out: string[] = [];
  for (let w = weekStart(first, weekStartsOn); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}

// ---- PR streak ------------------------------------------------------------------------------------------------

/** Floor division: blocks before the anchor are negative. */
export const blockOf = (day: string) => Math.floor(daysBetween(PR_BLOCK_ANCHOR, day) / PR_BLOCK_DAYS);
export const blockStart = (index: number) => addDays(PR_BLOCK_ANCHOR, index * PR_BLOCK_DAYS);

export interface PrStreak {
  current: number;
  longest: number;
  thisBlockHasPr: boolean;
  blockEnds: string;
}

/** Consecutive 28-day blocks with a rewarded PR; the block in progress never breaks the run. */
export function computePrStreak(prDays: Iterable<string>, today: string): PrStreak {
  const blocks = new Set<number>();
  for (const d of prDays) if (d <= today) blocks.add(blockOf(d));
  const now = blockOf(today);
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const b of [...blocks].sort((a, c) => a - c)) {
    run = prev !== null && b === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = b;
  }
  let current = 0;
  for (let b = blocks.has(now) ? now : now - 1; blocks.has(b); b--) current++;
  return { current, longest, thisBlockHasPr: blocks.has(now), blockEnds: addDays(blockStart(now + 1), -1) };
}

// ---- shared streaks (joint.py) --------------------------------------------------------------------------------

const JOINT_COUNTS: ReadonlySet<string> = new Set(["kept", "frozen", "repaired"]);

export interface JointWeek {
  status: "kept" | "missed" | "paused" | "open";
  kept: number;
  counted: number;
}

export interface JointResult {
  current: number;
  longest: number;
  /** Oldest first; the last entry is the week in progress. */
  weeks: JointWeek[];
}

/**
 * A shared week judged from each member's own verdicts (oldest first, current week last), lined up by recency.
 * A week is kept when at least `threshold` of the counted (non-paused) members kept theirs.
 */
export function jointStreak(
  members: readonly (readonly string[])[],
  threshold: number,
  maxWeeks: number | null = null,
): JointResult {
  let depth = 0;
  for (const m of members) depth = Math.max(depth, m.length);
  if (maxWeeks !== null) depth = Math.min(depth, Math.max(1, maxWeeks));
  const weeks: JointWeek[] = [];
  for (let back = depth - 1; back >= 0; back--) {
    const statuses = members.filter((m) => back < m.length).map((m) => m[m.length - 1 - back] as string);
    const counted = statuses.filter((s) => s !== "paused");
    const kept = counted.filter((s) => JOINT_COUNTS.has(s)).length;
    let status: JointWeek["status"];
    if (counted.length === 0) status = "paused";
    else if (kept >= threshold * counted.length - 1e-9) status = "kept";
    else if (back === 0) status = "open";
    else status = "missed";
    weeks.push({ status, kept, counted: counted.length });
  }
  let run = 0;
  let longest = 0;
  for (const w of weeks) {
    if (w.status === "kept") {
      run++;
      longest = Math.max(longest, run);
    } else if (w.status === "missed") run = 0;
  }
  return { current: run, longest, weeks };
}

// ---- smart reminders (reminders.py) ---------------------------------------------------------------------------

export const REMINDER_MIN_SESSIONS = 6;
export const REMINDER_LEAD_HOURS = 1;

export function inQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return quietStart <= hour && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

/** An hour before the most common training hour (ties go to the earlier hour), or null. */
export function learnReminderHour(
  hours: Iterable<number>,
  quietStart: number,
  quietEnd: number,
): number | null {
  const counts = new Map<number, number>();
  let n = 0;
  for (const h of hours) {
    const k = ((h % 24) + 24) % 24;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    n++;
  }
  if (n < REMINDER_MIN_SESSIONS) return null;
  let usual = 24;
  let best = 0;
  for (const [h, c] of counts) if (c > best || (c === best && h < usual)) [usual, best] = [h, c];
  const reminder = (((usual - REMINDER_LEAD_HOURS) % 24) + 24) % 24;
  return inQuietHour(reminder, quietStart, quietEnd) ? null : reminder;
}

export const reminderHour = (mode: string, fixed: number, learned: number | null) =>
  mode === "smart" && learned !== null ? learned : fixed;
