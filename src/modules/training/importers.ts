/**
 * Activity files to sessions (Python app/training/importers.py). Pure: bytes in, sessions out. The byte-level
 * readers live in src/heavy; this turns their tracks, records and rows into sessions with Python's rules.
 */

import { FormatError } from "../../heavy/bytes.ts";
import { parseCsv } from "../../heavy/csv.ts";
import { FIT_UNREADABLE, type FitRecord, type FitSummary, parseFit } from "../../heavy/fit.ts";
import { parseGpx } from "../../heavy/gpx.ts";
import { pyRound } from "../../lib/format.ts";
import { localParts, parseInstant, zone } from "../../lib/time.ts";

export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_SESSIONS = 5000;
const MAX_DURATION_S = 48 * 3600;
const MAX_DISTANCE_M = 1_000_000;

/** A user-facing reason the whole file can't be read (Python `ImportFormatError`). */
export class ImportFormatError extends Error {}

export const ALIASES: Readonly<Record<string, string>> = {
  strength: "strength",
  strength_training: "strength",
  weight_training: "strength",
  weights: "strength",
  lift: "strength",
  lifting: "strength",
  gym: "strength",
  run: "run",
  running: "run",
  trail_running: "run",
  treadmill: "run",
  treadmill_running: "run",
  jog: "run",
  ride: "ride",
  cycling: "ride",
  biking: "ride",
  bike: "ride",
  mountain_biking: "ride",
  virtual_ride: "ride",
  indoor_cycling: "ride",
  e_biking: "ride",
  swim: "swim",
  swimming: "swim",
  lap_swimming: "swim",
  open_water: "swim",
  open_water_swimming: "swim",
  walk: "walk",
  walking: "walk",
  hike: "walk",
  hiking: "walk",
  climb: "climb",
  climbing: "climb",
  rock_climbing: "climb",
  bouldering: "climb",
  row: "row",
  rowing: "row",
  indoor_rowing: "row",
  hiit: "hiit",
  conditioning: "hiit",
  cardio_training: "hiit",
  crossfit: "hiit",
  yoga: "yoga",
  pilates: "yoga",
  mobility: "yoga",
  flexibility_training: "yoga",
  sport: "sport",
  tennis: "sport",
  soccer: "sport",
  football: "sport",
  basketball: "sport",
  other: "other",
  generic: "other",
  training: "other",
};

export type Sample = readonly [ms: number, bpm: number];

export interface ParsedSession {
  /** Epoch ms. */
  startedAt: number;
  /** The session's own offset in minutes (for Python's "Session on <date>" wording). */
  offsetMin: number;
  discipline: string;
  durationSec: number | null;
  distanceM: number | null;
  elevationM: number | null;
  title: string | null;
  notes: string | null;
  effort: number | null;
  feel: number | null;
  splits: { m: number; sec: number }[];
  avgHr: number | null;
  maxHr: number | null;
  hrSamples: Sample[];
}

export interface ParseResult {
  format: "gpx" | "fit" | "csv";
  sessions: ParsedSession[];
  problems: string[];
}

const session = (
  s: Partial<ParsedSession> & Pick<ParsedSession, "startedAt" | "discipline">,
): ParsedSession => ({
  offsetMin: 0,
  durationSec: null,
  distanceM: null,
  elevationM: null,
  title: null,
  notes: null,
  effort: null,
  feel: null,
  splits: [],
  avgHr: null,
  maxHr: null,
  hrSamples: [],
  ...s,
});

const goodSorted = (samples: readonly Sample[]) =>
  samples.filter(([, b]) => b >= 30 && b <= 240).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

/** Time-weighted average and maximum, ignoring impossible readings. */
export function hrSummary(samples: readonly Sample[]): [number | null, number | null] {
  const good = goodSorted(samples);
  const first = good[0];
  if (first === undefined) return [null, null];
  if (good.length === 1) return [first[1], first[1]];
  let total = 0;
  let weighted = 0;
  for (let i = 0; i + 1 < good.length; i++) {
    const [t1, b1] = good[i] as Sample;
    const [t2] = good[i + 1] as Sample;
    const dt = Math.min(30, Math.max(0, (t2 - t1) / 1000));
    total += dt;
    weighted += b1 * dt;
  }
  const avg = total ? pyRound(weighted / total) : pyRound(good.reduce((n, [, b]) => n + b, 0) / good.length);
  return [avg, Math.max(...good.map(([, b]) => b))];
}

const ZONE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9];

/** Seconds in each of five zones; gaps count 30 s at most. */
export function zoneSeconds(samples: readonly Sample[], maxHr: number): number[] {
  const out = [0, 0, 0, 0, 0];
  const good = goodSorted(samples);
  for (let i = 0; i + 1 < good.length; i++) {
    const [t1, b1] = good[i] as Sample;
    const [t2] = good[i + 1] as Sample;
    const dt = Math.min(30, Math.max(0, (t2 - t1) / 1000));
    const share = b1 / maxHr;
    const z = ZONE_FLOORS.filter((f) => share >= f).length - 1;
    if (z >= 0) out[z] = (out[z] ?? 0) + pyRound(dt);
  }
  return out;
}

/** Per-kilometre times from (cumulative metres, ms) points; crossings interpolated between samples. */
export function kmSplits(
  track: readonly (readonly [number | null, number | null])[],
): { m: number; sec: number }[] {
  const pts = track.filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
  const first = pts[0];
  const lastPt = pts[pts.length - 1];
  if (first === undefined || lastPt === undefined || pts.length < 2 || lastPt[0] - first[0] < 100) return [];
  const splits: { m: number; sec: number }[] = [];
  let mark = first[0] + 1000;
  let lastCross = first[1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [d0, t0] = pts[i] as readonly [number, number];
    const [d1, t1] = pts[i + 1] as readonly [number, number];
    while (d1 >= mark && mark > d0 && splits.length < 500) {
      const frac = d1 > d0 ? (mark - d0) / (d1 - d0) : 0;
      // Python's timedelta * float rounds to microseconds.
      const cross = t0 + Math.round((t1 - t0) * frac * 1000) / 1000;
      splits.push({ m: 1000, sec: pyRound((cross - lastCross) / 1000) });
      lastCross = cross;
      mark += 1000;
    }
  }
  const remainder = lastPt[0] - (mark - 1000);
  if (remainder >= 50) splits.push({ m: pyRound(remainder), sec: pyRound((lastPt[1] - lastCross) / 1000) });
  return splits;
}

export function disciplineFor(names: readonly (string | null | undefined)[], fallback = "other"): string {
  for (const name of names) {
    if (!name) continue;
    const key = String(name).trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    const hit = ALIASES[key];
    if (hit !== undefined) return hit;
  }
  return fallback;
}

const isoDate = (ms: number, offsetMin: number) =>
  new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);

/** Why a session cannot be imported, or null (Python `check`). */
export function check(s: ParsedSession, now: number): string | null {
  if (s.startedAt > now + 10 * 60_000) return "starts in the future";
  if (Number(isoDate(s.startedAt, s.offsetMin).slice(0, 4)) < 1990) return "is dated before 1990";
  if (s.durationSec !== null && !(s.durationSec >= 0 && s.durationSec <= MAX_DURATION_S))
    return "has an implausible duration";
  if (s.distanceM !== null && !(s.distanceM >= 0 && s.distanceM <= MAX_DISTANCE_M))
    return "has an implausible distance";
  return null;
}

/** "Session on <date in its own offset> <reason>." */
export const problemFor = (s: ParsedSession, reason: string) =>
  `Session on ${isoDate(s.startedAt, s.offsetMin)} ${reason}.`;

function sniff(filename: string, data: Uint8Array): "fit" | "gpx" | "csv" {
  const name = filename.toLowerCase();
  const fitTag = String.fromCharCode(...data.subarray(8, 12));
  if (name.endsWith(".fit") || fitTag === ".FIT") return "fit";
  if (name.endsWith(".gpx") || new TextDecoder("latin1").decode(data.subarray(0, 2048)).includes("<gpx"))
    return "gpx";
  if (name.endsWith(".csv")) return "csv";
  throw new ImportFormatError("Upload a .gpx, .fit or .csv file.");
}

export function parse(
  filename: string,
  data: Uint8Array,
  tz: string,
  discipline: string | null,
): ParseResult {
  if (data.length > MAX_BYTES) throw new ImportFormatError("That file is larger than 15 MB.");
  if (data.length === 0) throw new ImportFormatError("That file is empty.");
  const kind = sniff(filename, data);
  const result =
    kind === "fit"
      ? parseFitFile(data, discipline)
      : kind === "gpx"
        ? parseGpxFile(data, discipline)
        : parseCsvFile(data, tz, discipline);
  if (result.sessions.length > MAX_SESSIONS)
    throw new ImportFormatError(`One upload can hold at most ${MAX_SESSIONS} sessions.`);
  return result;
}

// ---- GPX ------------------------------------------------------------------------------------------------------

/** Python `float(text)`: surrounding whitespace allowed, otherwise strict. */
function pyFloat(s: string | null): number {
  if (s === null) throw new TypeError("None");
  const t = s.trim().replaceAll("_", "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) && !/^[+-]?(inf|infinity|nan)$/i.test(t))
    throw new RangeError(`not a float: ${s}`);
  return /inf/i.test(t)
    ? t.startsWith("-")
      ? -Infinity
      : Infinity
    : /nan/i.test(t)
      ? Number.NaN
      : Number(t);
}

/** Python `datetime.fromisoformat` (Z accepted), naive read as UTC; ms and offset minutes. */
function isoInstant(value: string, naiveZone = "UTC"): { ms: number; offsetMin: number } | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      value.trim(),
    );
  if (m === null) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "", off] = m;
  const base = `${y}-${mo}-${d}T${h}:${mi}:${s}.${(`${frac}000`).slice(0, 3)}`;
  if (off === undefined) {
    const utc = Date.parse(`${base}Z`);
    if (Number.isNaN(utc)) return null;
    if (naiveZone === "UTC") return { ms: utc, offsetMin: 0 };
    // Wall time in `naiveZone`: find the instant whose local parts match.
    let guess = utc;
    for (let i = 0; i < 3; i++) {
      const p = localParts(guess, naiveZone);
      const shown = Date.parse(
        `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${s}.${(`${frac}000`).slice(0, 3)}Z`,
      );
      guess += utc - shown;
    }
    return { ms: guess, offsetMin: Math.round((utc - guess) / 60_000) };
  }
  const ms = parseInstant(`${base}${off.toUpperCase() === "Z" ? "Z" : off.length === 3 ? `${off}:00` : off}`);
  if (ms === null) return null;
  const offsetMin =
    off.toUpperCase() === "Z"
      ? 0
      : (off.startsWith("-") ? -1 : 1) *
        (Number(off.slice(1, 3)) * 60 + Number(off.replace(":", "").slice(3, 5) || 0));
  return { ms, offsetMin };
}

const haversine = (a: readonly [number, number], b: readonly [number, number]) => {
  const r = Math.PI / 180;
  const [lat1, lon1, lat2, lon2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const h =
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

function guessFromSpeed(distanceM: number, durationS: number): string {
  if (!distanceM || !durationS) return "other";
  const kmh = (distanceM / durationS) * 3.6;
  return kmh < 6.5 ? "walk" : kmh < 17 ? "run" : "ride";
}

export function parseGpxFile(data: Uint8Array, discipline: string | null = null): ParseResult {
  let tracks: ReturnType<typeof parseGpx>;
  try {
    tracks = parseGpx(data);
  } catch (err) {
    if (err instanceof FormatError) throw new ImportFormatError(err.message);
    throw err;
  }
  const sessions: ParsedSession[] = [];
  const problems: string[] = [];
  tracks.forEach((track, i) => {
    const points: {
      lat: number;
      lon: number;
      ele: number | null;
      t: { ms: number; offsetMin: number } | null;
    }[] = [];
    const hr: Sample[] = [];
    for (const p of track.points) {
      try {
        const lat = pyFloat(p.lat);
        const lon = pyFloat(p.lon);
        const ele = p.ele ? pyFloat(p.ele) : null;
        let t: { ms: number; offsetMin: number } | null = null;
        if (p.time) {
          t = isoInstant(p.time);
          if (t === null) throw new RangeError("bad time");
        }
        points.push({ lat, lon, ele, t });
        if (p.hr && t !== null) hr.push([t.ms, Math.trunc(pyFloat(p.hr))]);
      } catch {
        // Python skipped a point on TypeError/ValueError.
      }
    }
    const timed = points.filter((p) => p.t !== null);
    const start = timed[0]?.t;
    const end = timed[timed.length - 1]?.t;
    if (start == null || end == null) {
      problems.push(`Track ${i + 1} has no timestamps, so it can't be dated.`);
      return;
    }
    let distance = 0;
    const trackPts: [number, number][] = [];
    points.forEach((p, k) => {
      const prev = points[k - 1];
      if (prev !== undefined) distance += haversine([prev.lat, prev.lon], [p.lat, p.lon]);
      if (p.t !== null) trackPts.push([distance, p.t.ms]);
    });
    let climb = 0;
    let pending = 0;
    const elevations = points.flatMap((p) => (p.ele === null ? [] : [p.ele]));
    for (let k = 0; k + 1 < elevations.length; k++) {
      pending = Math.max(0, pending + ((elevations[k + 1] as number) - (elevations[k] as number)));
      if (pending >= 3) {
        climb += pending;
        pending = 0;
      }
    }
    const duration = Math.max(0, Math.trunc((end.ms - start.ms) / 1000));
    const [avg, max] = hrSummary(hr);
    sessions.push(
      session({
        startedAt: start.ms,
        offsetMin: start.offsetMin,
        discipline: discipline || disciplineFor([track.type], guessFromSpeed(distance, duration)),
        durationSec: duration || null,
        distanceM: distance ? pyRound(distance, 1) : null,
        elevationM: elevations.length > 0 ? pyRound(climb, 1) : null,
        title: (track.name ?? "").slice(0, 80) || null,
        splits: kmSplits(trackPts),
        avgHr: avg,
        maxHr: max,
        hrSamples: hr,
      }),
    );
  });
  if (sessions.length === 0 && problems.length === 0) problems.push("The file has no tracks.");
  return { format: "gpx", sessions, problems };
}

// ---- FIT ------------------------------------------------------------------------------------------------------

export function parseFitFile(data: Uint8Array, discipline: string | null = null): ParseResult {
  const { messages, error } = parseFit(data);
  const sessions: ParsedSession[] = [];
  const problems: string[] = [];
  const records: [number, number][] = [];
  const beats: Sample[] = [];
  for (const m of messages) {
    if (m.kind === "record") {
      const r = m as FitRecord;
      if (r.timestamp !== null && r.heartRate !== null) beats.push([r.timestamp, Math.trunc(r.heartRate)]);
      if (r.timestamp !== null && r.distance !== null) records.push([r.distance, r.timestamp]);
      continue;
    }
    if (m.kind !== "session") continue;
    const s = m as FitSummary;
    if (s.startTime === null) {
      problems.push("A session in the file has no start time.");
      continue;
    }
    const elapsed = s.totalTimerTime || s.totalElapsedTime || null;
    const windowEnd = s.startTime + ((elapsed ?? 0) + 60) * 1000;
    const mine = beats.filter(([t]) => s.startTime !== null && t >= s.startTime && t <= windowEnd);
    let [avg, peak] = hrSummary(mine);
    avg = s.avgHeartRate || avg;
    peak = s.maxHeartRate || peak;
    sessions.push(
      session({
        startedAt: s.startTime,
        discipline: discipline || disciplineFor([s.subSport, s.sport]),
        durationSec: elapsed ? Math.trunc(elapsed) : null,
        distanceM: s.totalDistance || null,
        elevationM: s.totalAscent || null,
        avgHr: avg ? Math.trunc(avg) : null,
        maxHr: peak ? Math.trunc(peak) : null,
        hrSamples: mine,
        splits: kmSplits(
          records.filter(([, t]) => s.startTime !== null && t >= s.startTime && t <= windowEnd),
        ),
      }),
    );
  }
  if (error !== null) {
    if (sessions.length === 0) throw new ImportFormatError(FIT_UNREADABLE);
    problems.push("The file ended early; sessions before that point were read.");
  }
  if (sessions.length === 0 && problems.length === 0) problems.push("The file has no sessions in it.");
  return { format: "fit", sessions, problems };
}

// ---- CSV ------------------------------------------------------------------------------------------------------

const CSV_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  date: ["date", "started_at", "start", "start_time", "activity_date", "datetime"],
  discipline: ["discipline", "type", "activity_type", "sport", "activity"],
  duration: ["duration", "elapsed_time", "moving_time", "time"],
  duration_min: ["duration_min", "duration_minutes", "minutes"],
  distance_km: ["distance_km", "km", "distance"],
  distance_mi: ["distance_mi", "miles"],
  distance_m: ["distance_m", "metres", "meters"],
  elevation_m: ["elevation_m", "elevation", "elevation_gain", "ascent"],
  title: ["title", "name", "activity_name"],
  notes: ["notes", "description", "comment"],
  effort: ["effort", "rpe"],
  feel: ["feel"],
};

function pick(row: ReadonlyMap<string, string>, field: string): string | null {
  for (const alias of CSV_COLUMNS[field] ?? []) {
    const v = row.get(alias);
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return null;
}

const num = (v: string | null) => (v === null ? null : pyFloat(v.replaceAll(",", "")));

function duration(v: string | null): number | null {
  if (v === null) return null;
  if (v.includes(":")) {
    const parts = v.split(":").map(pyFloat);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts.slice(-3) as [number, number, number];
    return Math.trunc(h * 3600 + m * 60 + s);
  }
  return Math.trunc(pyFloat(v));
}

/** Python `_when`: ISO with or without offset (naive = local), or a bare date at local midday. */
export function when(value: string, tz: string): { ms: number; offsetMin: number } {
  const z = zone(tz);
  let v = value;
  if (value.length <= 10 || isoInstant(value, z) === null) {
    const day = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new RangeError("bad date");
    v = `${day}T12:00:00`;
  }
  const out = isoInstant(v, z);
  if (out === null) throw new RangeError("bad date");
  return out;
}

export function parseCsvFile(data: Uint8Array, tz: string, discipline: string | null = null): ParseResult {
  let rows: string[][];
  try {
    rows = parseCsv(data);
  } catch (err) {
    if (err instanceof FormatError) throw new ImportFormatError(err.message);
    throw err;
  }
  const header = rows[0];
  if (header === undefined || header.length === 0)
    throw new ImportFormatError("That CSV file has no header row.");
  const names = header.map((h) => h.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_"));
  if (!(CSV_COLUMNS.date ?? []).some((a) => names.includes(a)))
    throw new ImportFormatError("The CSV needs a 'date' column.");
  const sessions: ParsedSession[] = [];
  const problems: string[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (line - 1 > MAX_SESSIONS)
      throw new ImportFormatError(`One upload can hold at most ${MAX_SESSIONS} sessions.`);
    const row = new Map<string, string>();
    names.forEach((n, k) => {
      const c = cells[k];
      if (c !== undefined && !row.has(n)) row.set(n, c);
    });
    try {
      const date = pick(row, "date");
      if (date === null) throw new RangeError("no date");
      let dur = duration(pick(row, "duration"));
      const minutes = dur === null ? num(pick(row, "duration_min")) : null;
      if (minutes !== null) dur = Math.trunc(minutes * 60);
      let distance = num(pick(row, "distance_m"));
      const km = num(pick(row, "distance_km"));
      if (km !== null) distance = km * 1000;
      const mi = num(pick(row, "distance_mi"));
      if (mi !== null) distance = mi * 1609.344;
      const effort = num(pick(row, "effort"));
      const feel = num(pick(row, "feel"));
      const at = when(date, tz);
      sessions.push(
        session({
          startedAt: at.ms,
          offsetMin: at.offsetMin,
          discipline: discipline || disciplineFor([pick(row, "discipline")]),
          durationSec: dur,
          distanceM: distance,
          elevationM: num(pick(row, "elevation_m")),
          title: (pick(row, "title") ?? "").slice(0, 80) || null,
          notes: (pick(row, "notes") ?? "").slice(0, 1000) || null,
          effort: effort !== null && effort >= 1 && effort <= 10 ? Math.trunc(effort) : null,
          feel: feel !== null && feel >= 1 && feel <= 5 ? Math.trunc(feel) : null,
        }),
      );
    } catch (err) {
      if (err instanceof ImportFormatError) throw err;
      problems.push(`Row ${line} could not be read.`);
    }
  });
  return { format: "csv", sessions, problems };
}

export { isoInstant, pyFloat };
