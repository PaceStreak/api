/**
 * Patterns in a person's own data, found by arithmetic rather than a model (Python `app/insights/engine.py`,
 * spec/habits.md §2.4). Each candidate pairs a driver with an outcome; days are split by the driver and the
 * outcome's means compared. A pattern is reported only when both halves have enough days, the gap matters and a
 * Welch t-test says it is unlikely to be noise. Correlation, and the app says so.
 */
import { formatG, pyRound } from "../../lib/format.ts";

export const MIN_DAYS = 8;
export const MIN_T = 2.0;
export const MAX_INSIGHTS = 6;

type Kind = "rate" | "score" | "hours" | "grams" | "kcal" | "binary";

interface Series {
  key: string;
  label: string;
  kind: Kind;
  minGap: number;
}

const S = (key: string, label: string, kind: Kind, minGap = 0): Series => ({ key, label, kind, minGap });

export const SERIES: Readonly<Record<string, Series>> = {
  sleep_hours: S("sleep_hours", "sleep", "hours"),
  sleep: S("sleep", "sleep rating", "score", 0.4),
  energy: S("energy", "energy", "score", 0.4),
  mood: S("mood", "mood", "score", 0.4),
  trained: S("trained", "training", "binary", 0.1),
  habits: S("habits", "habits done", "rate", 0.1),
  protein_g: S("protein_g", "protein", "grams", 10),
  kcal: S("kcal", "calories", "kcal", 150),
};

export const PAIRS: readonly (readonly [string, string])[] = [
  ["sleep_hours", "habits"],
  ["sleep_hours", "trained"],
  ["sleep_hours", "mood"],
  ["sleep", "habits"],
  ["sleep", "trained"],
  ["sleep", "mood"],
  ["energy", "trained"],
  ["trained", "mood"],
  ["trained", "protein_g"],
  ["trained", "habits"],
  ["mood", "habits"],
  ["habits", "mood"],
  ["protein_g", "mood"],
];

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

/** Day -> value per series key; a day missing from a series is unknown, not zero. */
export type SeriesMap = Map<string, Map<string, number>>;

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Sample variance (n - 1), as `statistics.variance`. */
function variance(xs: readonly number[]): number {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

export function welchT(a: readonly number[], b: readonly number[]): number {
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (se === 0) return mean(a) !== mean(b) ? Number.POSITIVE_INFINITY : 0;
  return (mean(a) - mean(b)) / se;
}

/** Python `f"{v:.1f}"`: half-even on the exact binary value. */
const f1 = (v: number) => pyRound(v, 1).toFixed(1);

export function fmt(s: Series, v: number): string {
  switch (s.kind) {
    case "rate":
    case "binary":
      return `${pyRound(v * 100)}%`;
    case "score":
      return `${f1(v)}/5`;
    case "hours":
      return `${f1(v)} h`;
    case "grams":
      return `${pyRound(v)} g`;
    case "kcal":
      return `${pyRound(v)} kcal`;
  }
}

function condition(d: Series, threshold: number | null, high: boolean): string {
  const t = threshold ?? 0;
  switch (d.kind) {
    case "binary":
      return `days you ${high ? "trained" : "rested"}`;
    case "hours":
      return high ? `days after ${fmt(d, t)}+ of sleep` : "shorter nights";
    case "rate":
      return high ? `days with ${fmt(d, t)}+ of ${d.label}` : "other days";
    case "score":
      return high ? `days your ${d.label} was ${formatG(t)}+` : "other days";
    default:
      return high ? `days with ${fmt(d, t)}+ ${d.label}` : "other days";
  }
}

function sentence(d: Series, o: Series, threshold: number | null, hi: number, lo: number): string {
  const hiCond = condition(d, threshold, true);
  const loCond = condition(d, threshold, false);
  if (o.kind === "binary")
    return `You trained on ${fmt(o, hi)} of ${hiCond}, against ${fmt(o, lo)} of ${loCond}.`;
  if (o.kind === "rate")
    return `You kept ${fmt(o, hi)} of your habits on ${hiCond}, against ${fmt(o, lo)} on ${loCond}.`;
  return `Your ${o.label} averaged ${fmt(o, hi)} on ${hiCond}, against ${fmt(o, lo)} on ${loCond}.`;
}

/** The strongest patterns, strongest first, one per outcome, at most MAX_INSIGHTS. */
export function find(series: SeriesMap): Insight[] {
  const found: Insight[] = [];
  for (const [dKey, oKey] of PAIRS) {
    const dv = series.get(dKey);
    const ov = series.get(oKey);
    if (dv === undefined || ov === undefined) continue;
    const days = [...dv.keys()].filter((d) => ov.has(d)).sort();
    if (days.length < 2 * MIN_DAYS) continue;
    const driver = SERIES[dKey] as Series;
    const outcome = SERIES[oKey] as Series;
    const dval = (d: string) => dv.get(d) as number;
    let threshold: number | null = null;
    let isHigh: boolean[];
    if (driver.kind === "binary") isHigh = days.map((d) => dval(d) >= 0.5);
    else {
      let t = median(days.map(dval));
      if (driver.kind === "hours") t = pyRound(t * 2) / 2;
      else if (driver.kind === "score") t = Math.ceil(t);
      threshold = t;
      isHigh = days.map((d) => dval(d) >= t);
    }
    const high: number[] = [];
    const low: number[] = [];
    days.forEach((d, i) => {
      (isHigh[i] ? high : low).push(ov.get(d) as number);
    });
    if (high.length < MIN_DAYS || low.length < MIN_DAYS) continue;
    const hi = mean(high);
    const lo = mean(low);
    const gap = Math.abs(hi - lo);
    if ((outcome.kind === "grams" || outcome.kind === "kcal") && lo > 0) {
      // Food gaps matter relative to how much is eaten.
      if (gap < Math.max(outcome.minGap, 0.1 * lo)) continue;
    } else if (gap < outcome.minGap) continue;
    const t = welchT(high, low);
    if (Math.abs(t) < MIN_T) continue;
    found.push({
      driver: dKey,
      outcome: oKey,
      text: sentence(driver, outcome, threshold, hi, lo),
      high: pyRound(hi, 3),
      low: pyRound(lo, 3),
      days_high: high.length,
      days_low: low.length,
      strength: pyRound(Math.min(Math.abs(t), 99), 2),
    });
  }
  // Stable sort: PAIRS order breaks ties, as Python's sort did.
  found.sort((a, b) => b.strength - a.strength);
  const seen = new Set<string>();
  const best: Insight[] = [];
  for (const i of found) {
    if (seen.has(i.outcome)) continue;
    seen.add(i.outcome);
    best.push(i);
  }
  return best.slice(0, MAX_INSIGHTS);
}
