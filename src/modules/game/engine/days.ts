/**
 * Fast calendar arithmetic on `YYYY-MM-DD` for the engine's hot loops. A snapshot does tens of thousands of date
 * operations over a few thousand distinct days, so conversions are memoised both ways (per isolate, bounded:
 * every date ever seen is one entry). Semantics match src/lib/time.ts exactly (property-tested).
 */

const toNum = new Map<string, number>();
const toStr = new Map<number, string>();
const MAX_ENTRIES = 200_000;

/** Days since 1970-01-01. */
export function dayNum(date: string): number {
  const hit = toNum.get(date);
  if (hit !== undefined) return hit;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (date.length !== 10 || !Number.isInteger(y + m + d)) throw new RangeError(`not a date: ${date}`);
  const n = Date.UTC(y, m - 1, d) / 86_400_000;
  if (toNum.size > MAX_ENTRIES) toNum.clear();
  toNum.set(date, n);
  return n;
}

export function dayStr(n: number): string {
  const hit = toStr.get(n);
  if (hit !== undefined) return hit;
  const s = new Date(n * 86_400_000).toISOString().slice(0, 10);
  if (toStr.size > MAX_ENTRIES) toStr.clear();
  toStr.set(n, s);
  return s;
}

export const addDays = (date: string, n: number) => (n === 0 ? date : dayStr(dayNum(date) + n));
export const daysBetween = (a: string, b: string) => dayNum(b) - dayNum(a);
/** Python `weekday()`: Monday = 0. 1970-01-01 was a Thursday (3). */
export const pyWeekday = (date: string) => (((dayNum(date) + 3) % 7) + 7) % 7;
/** One memo per week-start preference: the hottest call in the engine becomes a single map lookup. */
const weekMemo: Map<string, string>[] = Array.from({ length: 7 }, () => new Map());

export function weekStart(date: string, weekStartsOn: number): string {
  const memo = weekMemo[weekStartsOn];
  const hit = memo?.get(date);
  if (hit !== undefined) return hit;
  const back = (((pyWeekday(date) - weekStartsOn) % 7) + 7) % 7;
  const out = addDays(date, -back);
  if (memo !== undefined) {
    if (memo.size > MAX_ENTRIES) memo.clear();
    memo.set(date, out);
  }
  return out;
}
