/**
 * Habit history from other apps (Python `app/habits/importer.py`, spec/habits.md §2.3).
 *
 * Two shapes cover the exports in the wild:
 * - Wide: a date column, then one column per habit. Loop Habit Tracker's `Checkmarks.csv` (alone or inside its
 *   export zip) uses 2 for "done by hand", 1 "implied", 0 "not done", -1 "unknown"; only 2 counts. Any other wide
 *   file counts a positive number as done and keeps it as the amount.
 * - Long: one row per habit per day with a date and a habit-name column; a value column, if present, is the amount.
 *
 * Only ISO dates are read: 03/04/2026 means a different day in different countries.
 */
import { bytesToBinary, FormatError } from "../../heavy/bytes.ts";
import { parseCsv } from "../../heavy/csv.ts";
import { listZip, readZipEntry } from "../../heavy/zip.ts";

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_HABITS = 60;
const TOO_BIG = "That file is over 5 MB";
const ISO = /^(\d{4})[-/](\d{2})[-/](\d{2})/;
const DATE_COLUMNS = ["date", "day", "entry_date", "completed_at", "completion_date", "timestamp", "time"];
const NAME_COLUMNS = ["habit", "habit_name", "name", "title", "task", "task_title", "habit name"];
const VALUE_COLUMNS = ["value", "amount", "count", "quantity", "duration", "minutes", "progress"];

/** The message is shown to the user as a 422 detail. */
export class HabitImportError extends Error {}

export interface ImportedHabit {
  name: string;
  /** Day -> amount, in first-seen order. */
  days: Map<string, number>;
  /** Every amount a plain tick, so it becomes a check habit. */
  binary: boolean;
}

/** Python `str.casefold()` for the cases that matter in habit names. */
export const casefold = (s: string) => s.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
/** Python's `strip()` and `[:n]` count code points. */
const cpSlice = (s: string, n: number) => Array.from(s).slice(0, n).join("");

export function parseDate(text: string): string | null {
  const m = ISO.exec(text.trim());
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

const DIGITS = String.raw`\d(?:_?\d)*`;
const FLOAT = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGITS}(?:\.(?:${DIGITS})?)?|\.${DIGITS})(?:[eE][+-]?${DIGITS})?)$`,
);

/**
 * Python `float(text.strip().replace(",", "."))`. Infinities and NaN (which Python accepts) are refused: no habit
 * amount means either.
 */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(/,/g, ".");
  if (!FLOAT.test(s)) return null;
  const n = Number(s.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

function decodeText(data: Uint8Array): string {
  try {
    const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? data.subarray(3) : data);
  } catch {
    // Python then tries utf-16 (BOM-aware, little-endian without one), then latin-1, which always succeeds.
  }
  try {
    if (data.length % 2 === 0) {
      if (data[0] === 0xfe && data[1] === 0xff)
        return new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }).decode(data.subarray(2));
      const le = data[0] === 0xff && data[1] === 0xfe;
      return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(
        le ? data.subarray(2) : data,
      );
    }
  } catch {
    // fall through to latin-1
  }
  return bytesToBinary(data);
}

function csvText(filename: string, data: Uint8Array): string {
  if (data.length > MAX_BYTES) throw new HabitImportError(TOO_BIG);
  let bytes = data;
  if (filename.toLowerCase().endsWith(".zip") || (data[0] === 0x50 && data[1] === 0x4b)) {
    let names: string[];
    try {
      names = listZip(data)
        .map((e) => e.name)
        .filter((n) => n.toLowerCase().endsWith(".csv"));
    } catch (err) {
      if (err instanceof FormatError) throw new HabitImportError(err.message);
      throw err;
    }
    // Loop's export keeps every habit's ticks in the top-level file.
    let chosen =
      names.find((n) => n.toLowerCase() === "checkmarks.csv") ??
      names.find((n) => n.toLowerCase().endsWith("checkmarks.csv"));
    if (chosen === undefined) {
      if (names.length !== 1)
        throw new HabitImportError("Couldn't tell which file in the zip holds the history");
      chosen = names[0] as string;
    }
    try {
      bytes = readZipEntry(data, chosen, MAX_BYTES, () => new HabitImportError(TOO_BIG));
    } catch (err) {
      if (err instanceof FormatError) throw new HabitImportError(err.message);
      throw err;
    }
  }
  return decodeText(bytes);
}

/**
 * A small `csv.Sniffer` stand-in over `,`, `;` and tab: the delimiter that appears the same non-zero number of
 * times (outside quotes) on the most of the first lines wins, Python's preference order breaking ties. Falls
 * back to a comma, like Python's `csv.excel`.
 */
export function sniffDelimiter(sample: string): string {
  const lines = sample.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (lines.length > 1 && !/[\r\n]$/.test(sample)) lines.pop(); // the sample may end mid-line
  const counts = (line: string, d: string) => {
    let n = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    return n;
  };
  let best = ",";
  let bestScore = 0;
  for (const d of [",", "\t", ";"]) {
    const per = lines.map((l) => counts(l, d));
    const first = per[0] ?? 0;
    if (first === 0) continue;
    const score = per.filter((n) => n === first).length / per.length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function findColumn(header: readonly string[], options: readonly string[]): number | null {
  const lowered = header.map((h) => h.trim().toLowerCase());
  for (const o of options) {
    const i = lowered.indexOf(o);
    if (i !== -1) return i;
  }
  return null;
}

function long(rows: readonly string[][], dCol: number, nCol: number, vCol: number | null): ImportedHabit[] {
  const habits = new Map<string, ImportedHabit>();
  for (const row of rows) {
    if (Math.max(dCol, nCol) >= row.length) continue;
    const day = parseDate(row[dCol] as string);
    const name = cpSlice((row[nCol] as string).trim(), 60);
    if (day === null || !name) continue;
    let amount = 1;
    if (vCol !== null && vCol < row.length) {
      const value = parseNumber(row[vCol] as string);
      if (value === null || value <= 0) continue;
      amount = value;
    }
    const key = casefold(name);
    let h = habits.get(key);
    if (h === undefined) {
      h = { name, days: new Map(), binary: true };
      habits.set(key, h);
    }
    h.days.set(day, (h.days.get(day) ?? 0) + amount);
  }
  for (const h of habits.values()) h.binary = [...h.days.values()].every((v) => v === 1);
  return [...habits.values()];
}

const LOOP_VALUES = new Set([-1, 0, 1, 2, 3]);

function wide(rows: readonly string[][], header: readonly string[], dCol: number): ImportedHabit[] {
  const out: ImportedHabit[] = [];
  header.forEach((name, col) => {
    if (col === dCol || !name.trim()) return;
    const values: [string, number][] = [];
    for (const row of rows) {
      if (col >= row.length) continue;
      const day = parseDate(row[dCol] ?? "");
      const value = parseNumber(row[col] as string);
      if (day !== null && value !== null) values.push([day, value]);
    }
    const seen = new Set(values.map(([, v]) => v));
    const loopStyle = seen.has(2) && [...seen].every((v) => LOOP_VALUES.has(v));
    const habit: ImportedHabit = { name: cpSlice(name.trim(), 60), days: new Map(), binary: true };
    for (const [day, value] of values) {
      if (loopStyle) {
        if (value === 2) habit.days.set(day, 1);
      } else if (value > 0) habit.days.set(day, value);
    }
    habit.binary = loopStyle || [...habit.days.values()].every((v) => v === 1);
    out.push(habit);
  });
  return out;
}

export function parse(filename: string, data: Uint8Array): ImportedHabit[] {
  const text = csvText(filename, data);
  const delimiter = sniffDelimiter(text.slice(0, 4096));
  let all: string[][];
  try {
    all = parseCsv(new TextEncoder().encode(text), { delimiter });
  } catch (err) {
    if (err instanceof FormatError) throw new HabitImportError(err.message);
    throw err;
  }
  const rows = all.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) throw new HabitImportError("That file has no rows to import");
  const [header, ...body] = rows as [string[], ...string[][]];
  const dCol = findColumn(header, DATE_COLUMNS);
  if (dCol === null) throw new HabitImportError("Couldn't find a date column. It needs a header named Date.");
  if (!body.slice(0, 50).some((r) => dCol < r.length && parseDate(r[dCol] as string) !== null))
    throw new HabitImportError("Dates must be written year first, like 2026-09-30");
  const nCol = findColumn(header, NAME_COLUMNS);
  const habits = (
    nCol !== null ? long(body, dCol, nCol, findColumn(header, VALUE_COLUMNS)) : wide(body, header, dCol)
  ).filter((h) => h.days.size > 0);
  if (habits.length === 0) throw new HabitImportError("Nothing in that file was marked done");
  if (habits.length > MAX_FILE_HABITS)
    throw new HabitImportError(`More than ${MAX_FILE_HABITS} habits in one file`);
  return habits;
}
