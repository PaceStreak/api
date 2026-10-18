/**
 * Personal records (Python `app/game/records.py`). Pure. Every PR is self-relative.
 *
 * - Plausibility: a gain above PR_MAX_GAIN_PCT is recorded but flagged, earns nothing and is never broadcast.
 * - Cooldown: one rewarded PR per record key per PR_COOLDOWN_DAYS.
 */
import { pyRound } from "../../../lib/format.ts";
import { daysBetween } from "./days.ts";

export const PR_MAX_GAIN_PCT = 15.0;
export const PR_COOLDOWN_DAYS = 7;
export const MAX_E1RM_REPS = 12;
/** Pace bands: a run at least this long gets a pace record for the band (whole-session average). */
export const RUN_BANDS: readonly [number, string][] = [
  [5_000, "5k"],
  [10_000, "10k"],
  [21_097, "half"],
  [42_195, "marathon"],
];

/** Epley; sets past a dozen reps are not graded. */
export function e1rm(weightKg: number, reps: number): number {
  if (reps <= 0 || weightKg <= 0 || reps > MAX_E1RM_REPS) return 0;
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
}

export interface Observation {
  key: string;
  value: number;
  day: string;
  workoutId: string;
  higherIsBetter?: boolean;
  /** Imported history sets bests but never pays. */
  rewardable?: boolean;
}

export interface PrEvent {
  key: string;
  value: number;
  previous: number;
  gainPct: number;
  day: string;
  workoutId: string;
  flagged: boolean;
  rewarded: boolean;
}

export interface Best {
  value: number;
  day: string;
  workoutId: string;
}

export const higherIsBetter = (key: string) => !key.startsWith("pace_");
const better = (a: number, b: number, higher: boolean) => (higher ? a > b : a < b);

/**
 * Walks history chronologically and emits an event each time a record moves. Within one day only the day's best
 * value per key counts, so three heavier sets in one session are one PR. Events come out sorted by (day, key).
 */
export function detect(observations: Iterable<Observation>): { events: PrEvent[]; bests: Map<string, Best> } {
  const byDay = new Map<string, Observation>();
  for (const obs of observations) {
    const slot = `${obs.day}\u0000${obs.key}`;
    const existing = byDay.get(slot);
    if (existing === undefined || better(obs.value, existing.value, obs.higherIsBetter ?? true))
      byDay.set(slot, obs);
  }
  // Slot strings sort by (day, key): dates are fixed width and NUL sorts before every key character.
  const slots = [...byDay.keys()].sort();
  const bests = new Map<string, Best>();
  const lastRewarded = new Map<string, string>();
  const events: PrEvent[] = [];
  for (const slot of slots) {
    const obs = byDay.get(slot) as Observation;
    const { key, day } = obs;
    const higher = obs.higherIsBetter ?? true;
    const prior = bests.get(key);
    if (prior === undefined) {
      bests.set(key, { value: obs.value, day, workoutId: obs.workoutId });
      continue;
    }
    if (!better(obs.value, prior.value, higher)) continue;
    const delta = higher ? obs.value - prior.value : prior.value - obs.value;
    const gain = prior.value ? (delta / prior.value) * 100 : 0;
    const flagged = gain > PR_MAX_GAIN_PCT;
    const last = lastRewarded.get(key);
    const cooled = last === undefined || daysBetween(last, day) >= PR_COOLDOWN_DAYS;
    const rewarded = (obs.rewardable ?? true) && !flagged && cooled;
    if (rewarded) lastRewarded.set(key, day);
    events.push({
      key,
      value: obs.value,
      previous: prior.value,
      gainPct: pyRound(gain, 2),
      day,
      workoutId: obs.workoutId,
      flagged,
      rewarded,
    });
    bests.set(key, { value: obs.value, day, workoutId: obs.workoutId });
  }
  return { events, bests };
}

const LABELS: Record<string, (name: string, subject: string) => string> = {
  e1rm: (n) => `${n} · estimated 1RM`,
  reps: (n) => `${n} · most reps`,
  hold: (n) => `${n} · longest hold`,
  distance: (_, s) => `Longest ${s}`,
  pace_5k: () => "Fastest 5k pace",
  pace_10k: () => "Fastest 10k pace",
  pace_half: () => "Fastest half-marathon pace",
  pace_marathon: () => "Fastest marathon pace",
};

export function splitKey(key: string): [string, string] {
  const i = key.indexOf(":");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

export function recordLabel(key: string, names: ReadonlyMap<string, string>): string {
  const [kind, subject] = splitKey(key);
  const f = LABELS[kind];
  return f === undefined ? key : f(names.get(subject) ?? subject, subject);
}
