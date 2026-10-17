/** ISO-8601 weeks (Monday start), replacing Postgres `date_trunc('week', ...)`. Dates are `YYYY-MM-DD`. */
import { addDays, pyWeekday, weekStart } from "./time.ts";

/** Monday of the ISO week containing `date`: `date_trunc('week', date)`. */
export function mondayOf(date: string): string {
  return weekStart(date, 0);
}

export interface IsoWeek {
  year: number;
  week: number;
}

/** ISO week-numbering year and week (the week containing the year's first Thursday is week 1). */
export function isoWeek(date: string): IsoWeek {
  const thursday = addDays(date, 3 - pyWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const jan1 = `${year}-01-01`;
  const ordinal = Math.round((Date.parse(thursday) - Date.parse(jan1)) / 86_400_000);
  return { year, week: Math.floor(ordinal / 7) + 1 };
}

/** `2026-W42`. */
export function isoWeekKey(date: string): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
