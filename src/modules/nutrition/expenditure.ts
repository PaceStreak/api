/**
 * Adaptive energy expenditure (Python `app/nutrition/expenditure.py`, spec/misc.md §1): what someone actually
 * burns, from what they ate and what the scale did. If the weight trend fell by Δ kg over the window, the body
 * covered 7,700 kcal per kg from storage, so expenditure is the average intake plus that deficit. The trend is a
 * least-squares line through the daily weigh-in means. Pure: the service reads the rows.
 *
 * Suggestions are deliberately gentle: losing at most 0.5% of body weight a week, never under 1,200 kcal, never
 * more than 750 kcal below expenditure.
 */
import { pyRound } from "../../lib/format.ts";
import { daysBetween } from "../../lib/time.ts";

export const KCAL_PER_KG = 7700;
export const WINDOW_DAYS = 28;
export const MIN_FOOD_DAYS = 14;
export const MIN_WEIGH_DAYS = 8;
export const MIN_SPAN_DAYS = 14;
export const FLOOR_KCAL = 1200;
export const MAX_DEFICIT = 750;
export const LOSE_RATE = 0.005;
export const GAIN_RATE = 0.0025;
export const MAINTAIN_BAND_KG = 1.0;

export interface Estimate {
  status: "ok" | "not_enough" | "inconsistent";
  food_days: number;
  weigh_days: number;
  tdee: number | null;
  avg_intake: number | null;
  trend_kg_per_week: number | null;
  trend_kg: number | null;
  confidence: "low" | "good" | null;
}

export interface Suggestion {
  goal: "maintain" | "lose" | "gain";
  kcal: number;
  rate_kg_per_week: number;
}

/** Compensated (Neumaier) sum: closer to Python `statistics.mean`, which sums exactly. */
function fsum(xs: Iterable<number>): number {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

const mean = (xs: readonly number[]) => fsum(xs) / xs.length;

export function slope(points: readonly (readonly [number, number])[]): number {
  const mx = mean(points.map((p) => p[0]));
  const my = mean(points.map((p) => p[1]));
  const den = fsum(points.map(([x]) => (x - mx) ** 2));
  return den ? fsum(points.map(([x, y]) => (x - mx) * (y - my))) / den : 0;
}

const empty = (status: Estimate["status"], food_days: number, weigh_days: number): Estimate => ({
  status,
  food_days,
  weigh_days,
  tdee: null,
  avg_intake: null,
  trend_kg_per_week: null,
  trend_kg: null,
  confidence: null,
});

/**
 * `intake` is kcal per logged day and `weights` the day's mean weigh-in, both over the window ending `end`
 * (yesterday: today isn't over). Keys are `YYYY-MM-DD`.
 */
export function estimate(
  intake: ReadonlyMap<string, number>,
  weights: ReadonlyMap<string, number>,
  end: string,
): Estimate {
  const foodDays = intake.size;
  const weighDays = weights.size;
  const sorted = [...weights].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = first !== undefined && last !== undefined ? daysBetween(first[0], last[0]) : 0;
  if (foodDays < MIN_FOOD_DAYS || weighDays < MIN_WEIGH_DAYS || span < MIN_SPAN_DAYS || last === undefined)
    return empty("not_enough", foodDays, weighDays);
  const perDay = slope(sorted.map(([d, kg]) => [daysBetween(end, d), kg] as const));
  const avgIntake = mean([...intake.values()]);
  const tdee = avgIntake - perDay * KCAL_PER_KG;
  // Usually meals that weren't logged. A number this far out would mislead.
  if (!(tdee >= 1000 && tdee <= 6000)) return empty("inconsistent", foodDays, weighDays);
  const recent = sorted.filter(([d]) => daysBetween(d, end) < 7).map(([, kg]) => kg);
  const latest = recent.length > 0 ? mean(recent) : last[1];
  return {
    status: "ok",
    food_days: foodDays,
    weigh_days: weighDays,
    tdee: pyRound(tdee),
    avg_intake: pyRound(avgIntake),
    trend_kg_per_week: pyRound(perDay * 7, 2),
    trend_kg: pyRound(latest, 1),
    confidence: foodDays >= 21 && weighDays >= 12 ? "good" : "low",
  };
}

/** A calorie target toward the weight goal, or maintenance without one. */
export function suggest(est: Estimate, targetKg: number | null): Suggestion | null {
  if (est.status !== "ok" || est.tdee === null || est.trend_kg === null) return null;
  const tdee = est.tdee;
  if (targetKg === null || Math.abs(targetKg - est.trend_kg) <= MAINTAIN_BAND_KG)
    return { goal: "maintain", kcal: tdee, rate_kg_per_week: 0 };
  let kcal: number;
  let goal: Suggestion["goal"];
  if (targetKg < est.trend_kg) {
    const rate = -LOSE_RATE * est.trend_kg;
    kcal = Math.max(FLOOR_KCAL, tdee - MAX_DEFICIT, tdee + (rate * KCAL_PER_KG) / 7);
    goal = "lose";
  } else {
    const rate = GAIN_RATE * est.trend_kg;
    kcal = tdee + (rate * KCAL_PER_KG) / 7;
    goal = "gain";
  }
  kcal = pyRound(kcal / 10) * 10;
  return { goal, kcal, rate_kg_per_week: pyRound(((kcal - tdee) * 7) / KCAL_PER_KG, 2) };
}
