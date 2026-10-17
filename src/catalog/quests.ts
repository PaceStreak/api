/**
 * The weekly quest pool (Python `app/game/quests.py`, spec/game.md). Quests reward habits, never magnitude; the
 * morning weigh-in quest pays for weighing at a consistent time, never for what the scale says.
 * Progress and week computation live in the game module; this file holds the data and the deterministic pick.
 */

export const QUEST_XP = 15;
export const QUESTS_PER_WEEK = 3;
export const PR_BLOCK_DAYS = 28;
/** A Monday. PR blocks are [anchor + 28k, anchor + 28k + 27]. */
export const PR_BLOCK_ANCHOR = "2024-01-01";

export interface QuestDef {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly goal: number;
}

function q(id: string, title: string, description: string, goal: number): QuestDef {
  return Object.freeze({ id, title, description, goal });
}

/** Order is load-bearing: `questsFor` indexes into it. */
export const QUEST_POOL: readonly QuestDef[] = Object.freeze([
  q("early_week", "Early start", "Train in the first three days of the week.", 1),
  q("balanced", "Balanced week", "A push, a pull and a leg movement this week.", 3),
  q("rpe", "Honest effort", "Rate how hard 8 working sets were (RPE).", 8),
  q("short_counts", "A short one counts", "Log a session of 20 minutes or less.", 1),
  q("new_exercise", "Something new", "Try an exercise you've never logged.", 1),
  q("rest_day", "Rest on purpose", "Log a rest day. Recovery is training.", 1),
  q("morning_weigh", "Same time, every time", "Weigh in after waking on 5 days.", 5),
  q("habit_week", "Every habit, kept", "Keep the weekly target on all your habits.", 1),
]);

export const QUEST_BY_ID: ReadonlyMap<string, QuestDef> = new Map(QUEST_POOL.map((d) => [d.id, d]));

const MS_PER_DAY = 86_400_000;
/** Python `date(1, 1, 1).toordinal()` is 1; 1970-01-01 is ordinal 719163. */
const EPOCH_ORDINAL = 719_163;

/** Python `date.toordinal()` for a `YYYY-MM-DD` string. */
export function dateOrdinal(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY + EPOCH_ORDINAL;
}

/**
 * This week's three quests (Python `quests_for`). Deterministic in the week start and in what the person tracks,
 * so they never reshuffle on a recompute. The weigh-in quest only joins the pool for someone who weighs in, the
 * habit quest only for someone with habits.
 */
export function questsFor(weekStart: string, weighs: boolean, hasHabits = false): QuestDef[] {
  const pool = QUEST_POOL.filter(
    (d) => (weighs || d.id !== "morning_weigh") && (hasHabits || d.id !== "habit_week"),
  );
  const seed = Math.floor(dateOrdinal(weekStart) / 7);
  const picked: QuestDef[] = [];
  for (let i = seed; picked.length < QUESTS_PER_WEEK; i++) {
    const d = pool[(((i * 5 + seed) % pool.length) + pool.length) % pool.length];
    if (d !== undefined && !picked.includes(d)) picked.push(d);
  }
  return picked;
}
