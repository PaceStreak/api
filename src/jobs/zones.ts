/**
 * Local-hour matching without SQL time-zone support (spec/misc.md §4 "Hour matching"). Postgres evaluated
 * `EXTRACT(hour FROM timezone(tz, now()))` per row; here each distinct zone is resolved once per call through the
 * memoised `Intl` formatters in lib/time.ts, so a 5,000-row candidate set costs one format per zone, not per row.
 * Working in whole zones (not UTC offsets) keeps DST and the +5:30/+5:45 zones exact.
 */
import { localHour, zone } from "../lib/time.ts";

/** Local hour (0-23) for every distinct zone in `zones` at `now`. Invalid zones resolve as UTC (lib/time `zone`). */
export function hoursByZone(zones: Iterable<string | null | undefined>, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const tz of zones) {
    const key = tz ?? "UTC";
    if (!out.has(key)) out.set(key, localHour(now, zone(key)));
  }
  return out;
}

/** Rows grouped by their zone's local hour at `now`. Hours with no rows are absent. */
export function groupByLocalHour<T>(
  rows: readonly T[],
  tzOf: (row: T) => string | null | undefined,
  now: number,
): Map<number, T[]> {
  const hours = hoursByZone(
    rows.map((r) => tzOf(r)),
    now,
  );
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const h = hours.get(tzOf(row) ?? "UTC") ?? 0;
    const list = groups.get(h);
    if (list === undefined) groups.set(h, [row]);
    else list.push(row);
  }
  return groups;
}

/**
 * Rows whose local hour at `now` equals `hourOf(row)` (a per-row target such as `reminder_hour`, or a constant).
 * This is the JS form of `_local_hour_is(col)`.
 */
export function atLocalHour<T>(
  rows: readonly T[],
  tzOf: (row: T) => string | null | undefined,
  hourOf: (row: T) => number | null | undefined,
  now: number,
): T[] {
  const hours = hoursByZone(
    rows.map((r) => tzOf(r)),
    now,
  );
  return rows.filter((r) => {
    const target = hourOf(r);
    return target !== null && target !== undefined && hours.get(tzOf(r) ?? "UTC") === target;
  });
}

/**
 * The zones among `zones` whose local hour at `now` is `hour`: a prefilter for `WHERE timezone IN (...)` when the
 * target hour is a constant (digest and backup at 9, buddies at 17). Chunk the result for D1's 100-parameter limit.
 */
export function zonesAtHour(zones: Iterable<string>, hour: number, now: number): string[] {
  const out: string[] = [];
  for (const [tz, h] of hoursByZone(zones, now)) if (h === hour) out.push(tz);
  return out;
}
