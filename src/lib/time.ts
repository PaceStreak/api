/**
 * Instants are epoch milliseconds everywhere inside the API; dates are `YYYY-MM-DD` strings (lexicographic order is
 * chronological). Time zones come from `Intl`, memoised per zone, so DST is always current.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

let active: Clock = systemClock;

/** The clock every new `Ctx` uses. Tests swap it with `setClock`; production never does. */
export function currentClock(): Clock {
  return active;
}

export function setClock(c: Clock): void {
  active = c;
}

export function fixedClock(ms: number): Clock & { set(ms: number): void; advance(ms: number): void } {
  let t = ms;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
    advance: (d) => {
      t += d;
    },
  };
}

/** Wire format for every timestamp: `2026-10-17T09:30:00.123Z` (DESIGN.md §4). */
export function toWire(ms: number): string;
export function toWire(ms: number | null): string | null;
export function toWire(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Parses an ISO-8601 instant (with `Z` or an offset) to ms; null when invalid or without a zone. */
export function parseInstant(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : ms;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

// ---- time zones ----------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
const validity = new Map<string, boolean>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** IANA zone names, aliases included (`US/Pacific`, `Etc/GMT+5`). */
export function isValidTimezone(tz: string): boolean {
  let ok = validity.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = tz.length > 0 && tz.length <= 64;
    } catch {
      ok = false;
    }
    validity.set(tz, ok);
  }
  return ok;
}

/** Unknown zones fall back to UTC (spec/core.md §7), never throw. */
export function zone(tz: string | null | undefined): string {
  return tz !== null && tz !== undefined && isValidTimezone(tz) ? tz : "UTC";
}

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  /** Python weekday: Monday = 0. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function localParts(ms: number, tz: string): LocalParts {
  const parts = formatter(zone(tz)).formatToParts(ms);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

export function localDate(ms: number, tz: string): string {
  return localParts(ms, tz).date;
}

export function localHour(ms: number, tz: string): number {
  return localParts(ms, tz).hour;
}

// ---- calendar arithmetic on YYYY-MM-DD ----------------------------------------------------------------------

function toUtc(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

export function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** Python `date.weekday()`: Monday = 0 ... Sunday = 6. */
export function pyWeekday(date: string): number {
  return (new Date(toUtc(date)).getUTCDay() + 6) % 7;
}

/** Start of the week containing `date`, for a week starting on `weekStartsOn` (0 = Monday). */
export function weekStart(date: string, weekStartsOn: number): string {
  const back = (((pyWeekday(date) - weekStartsOn) % 7) + 7) % 7;
  return addDays(date, -back);
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** `2026-Q4`. */
export function seasonId(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** First and last day of a season id. */
export function seasonBounds(id: string): [string, string] {
  const m = /^(\d{4})-Q([1-4])$/.exec(id);
  if (!m) throw new RangeError(`not a season: ${id}`);
  const year = Number(m[1]);
  const q = Number(m[2]);
  const first = fromUtc(Date.UTC(year, (q - 1) * 3, 1));
  const last = fromUtc(Date.UTC(year, q * 3, 1) - DAY_MS);
  return [first, last];
}
