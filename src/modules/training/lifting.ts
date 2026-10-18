/**
 * Set-by-set CSV exports from Strong, Hevy and FitNotes (Python app/training/lifting_import.py). Pure: rows are
 * regrouped into sessions, weights converted to kilograms, and names matched to the library.
 */

import type { CatalogExercise } from "../../catalog/exercises.ts";
import { FormatError } from "../../heavy/bytes.ts";
import { parseCsv } from "../../heavy/csv.ts";
import { pyRound } from "../../lib/format.ts";
import { isoInstant, when as whenIso } from "./importers.ts";

export const LB = 0.45359237;
const MAX_ROWS = 100_000;
const MAX_SETS_PER_SESSION = 400;

export class LiftingFormatError extends Error {}

export interface ParsedSet {
  exercise: string;
  setIndex: number;
  kind: string;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  durationSec: number | null;
  distanceM: number | null;
  superset: number | null;
}

export interface LiftingSession {
  startedAt: number;
  offsetMin: number;
  title: string | null;
  notes: string | null;
  durationSec: number | null;
  sets: ParsedSet[];
}

export interface LiftingResult {
  format: "strong" | "hevy" | "fitnotes";
  sessions: LiftingSession[];
  problems: string[];
}

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function detect(headers: readonly string[]): LiftingResult["format"] | null {
  const h = new Set(headers.map(norm));
  if (h.has("exercise_name") && h.has("set_order")) return "strong";
  if (h.has("exercise_title") && h.has("set_index") && h.has("start_time")) return "hevy";
  if (h.has("exercise") && h.has("category") && (h.has("weight_kgs") || h.has("weight_lbs")))
    return "fitnotes";
  return null;
}

const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Whether a CSV's header row is a Strong, Hevy or FitNotes export. */
export function isLiftingCsv(data: Uint8Array): boolean {
  const head = lenient.decode(data.subarray(0, 4096)).split(/\r\n|\r|\n/)[0];
  if (!head) return false;
  const delimiter = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ";" : ",";
  try {
    const row = parseCsv(new TextEncoder().encode(head), { delimiter })[0];
    return row !== undefined && detect(row) !== null;
  } catch {
    return false;
  }
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const commas = value.split(",").length - 1;
  const v =
    commas === 1 && !value.includes(".") ? value.trim().replace(",", ".") : value.trim().replaceAll(",", "");
  if (v === "") return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return null;
  return Number(v);
}

const int = (value: string | undefined) => {
  const n = num(value);
  return n === null ? null : pyRound(n);
};

function duration(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const v = value.trim().toLowerCase();
  if (/^[\d:.]+$/.test(v) && v.includes(":")) {
    const parts = v.split(":").map(Number);
    if (parts.some(Number.isNaN)) throw new RangeError("bad duration");
    while (parts.length < 3) parts.unshift(0);
    const [h, m, s] = parts.slice(-3) as [number, number, number];
    return Math.trunc(h * 3600 + m * 60 + s);
  }
  const units = [...v.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g)];
  if (units.length > 0) {
    const mult: Record<string, number> = { h: 3600, m: 60, s: 1 };
    return Math.trunc(units.reduce((n, u) => n + Number(u[1]) * (mult[u[2] ?? "s"] ?? 1), 0));
  }
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const HEVY = /^(\d{1,2}) (\w{3}) (\d{4}), (\d{1,2}):(\d{2})$/;

/** Hevy's `%d %b %Y, %H:%M`, else ISO / bare date (local midday). Throws RangeError like Python's ValueError. */
function when(value: string, tz: string): { ms: number; offsetMin: number } {
  const v = value.trim();
  if (/^\d{1,2} \w{3} \d{4},/.test(v)) {
    const m = HEVY.exec(v);
    const mon = m === null ? -1 : MONTHS.indexOf((m[2] ?? "").toLowerCase());
    if (m === null || mon < 0) throw new RangeError("bad hevy date");
    const iso = `${m[3]}-${String(mon + 1).padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}T${(m[4] ?? "").padStart(2, "0")}:${m[5]}:00`;
    const out = isoInstant(iso, tz);
    if (out === null) throw new RangeError("bad hevy date");
    return out;
  }
  return whenIso(v, tz);
}

function kind(value: string | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  if (["w", "warmup", "warm_up", "warm-up"].includes(v)) return "warmup";
  if (["d", "dropset", "drop_set", "drop"].includes(v)) return "drop";
  if (["f", "failure"].includes(v)) return "failure";
  return "work";
}

export function parseLifting(data: Uint8Array, tz: string, unit = "kg"): LiftingResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    throw new LiftingFormatError("CSV files need to be UTF-8.");
  }
  const sample = text.slice(0, 4096);
  const delimiter = (sample.match(/;/g)?.length ?? 0) > (sample.match(/,/g)?.length ?? 0) ? ";" : ",";
  let rows: string[][];
  try {
    rows = parseCsv(new TextEncoder().encode(text), { delimiter });
  } catch (err) {
    if (err instanceof FormatError) throw new LiftingFormatError(err.message);
    throw err;
  }
  const header = rows[0];
  if (header === undefined || header.length === 0)
    throw new LiftingFormatError("That CSV file has no header row.");
  const format = detect(header);
  if (format === null) throw new LiftingFormatError("That isn't a Strong, Hevy or FitNotes export.");
  const names = header.map(norm);
  const toKg = unit === "lb" ? LB : 1;
  const sessions = new Map<string, LiftingSession>();
  const order = new Map<string, Map<string, number>>();
  const problems: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    if (line > MAX_ROWS) throw new LiftingFormatError(`One upload can hold at most ${MAX_ROWS} rows.`);
    const cells = rows[i] as string[];
    const row = new Map<string, string>();
    names.forEach((n, k) => {
      const c = cells[k];
      if (c !== undefined && !row.has(n)) row.set(n, c);
    });
    const get = (k: string) => row.get(k);
    const need = (k: string) => {
      const v = row.get(k);
      if (v === undefined) throw new RangeError(`missing ${k}`);
      return v;
    };
    let key: string;
    let started: { ms: number; offsetMin: number };
    let name: string;
    let parsed: ParsedSet;
    let title: string | null = null;
    let notes: string | null = null;
    let dur: number | null = null;
    try {
      if (format === "strong") {
        started = when(need("date"), tz);
        key = String(started.ms);
        name = (get("exercise_name") ?? "").trim();
        const weight = num(get("weight"));
        const d = num(get("distance"));
        parsed = {
          exercise: name,
          setIndex: 0,
          kind: kind(get("set_order")),
          weightKg: weight === null ? null : weight * toKg,
          reps: int(get("reps")),
          rpe: num(get("rpe")),
          durationSec: int(get("seconds")),
          distanceM: d ? d * 1000 : null,
          superset: null,
        };
        title = get("workout_name") ?? null;
        notes = get("workout_notes") ?? null;
        dur = duration(get("duration"));
      } else if (format === "hevy") {
        started = when(need("start_time"), tz);
        key = String(started.ms);
        name = (get("exercise_title") ?? "").trim();
        let weight: number | null;
        const kgRaw = get("weight_kg");
        if (kgRaw !== undefined && kgRaw !== "") weight = num(kgRaw);
        else {
          const w = num(get("weight_lbs"));
          weight = w === null ? null : w * LB;
        }
        let dist = num(get("distance_km"));
        if (dist === null) {
          const mi = num(get("distance_miles"));
          if (mi !== null) dist = mi * 1.609344;
        }
        const superset = int(get("superset_id"));
        parsed = {
          exercise: name,
          setIndex: 0,
          kind: kind(get("set_type")),
          weightKg: weight,
          reps: int(get("reps")),
          rpe: num(get("rpe")),
          durationSec: int(get("duration_seconds")),
          distanceM: dist ? dist * 1000 : null,
          superset: superset === null ? null : superset + 1,
        };
        title = get("title") ?? null;
        notes = get("description") ?? null;
        const end = get("end_time");
        if (end) {
          try {
            const fin = when(end, tz);
            dur = Math.max(0, Math.trunc((fin.ms - started.ms) / 1000)) || null;
          } catch {
            dur = null;
          }
        }
      } else {
        const day = need("date").trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("bad date");
        started = whenIso(day, tz);
        key = day;
        name = (get("exercise") ?? "").trim();
        let weight: number | null;
        const kgRaw = get("weight_kgs");
        if (kgRaw !== undefined && kgRaw !== "") weight = num(kgRaw);
        else {
          const w = num(get("weight_lbs"));
          weight = w === null ? null : w * LB;
        }
        const dist = num(get("distance"));
        const factors: Record<string, number> = { km: 1000, m: 1, mi: 1609.344, miles: 1609.344, ft: 0.3048 };
        const factor = factors[(get("distance_unit") ?? "").trim().toLowerCase()] ?? 1000;
        parsed = {
          exercise: name,
          setIndex: 0,
          kind: "work",
          weightKg: weight,
          reps: int(get("reps")),
          rpe: null,
          durationSec: duration(get("time")),
          distanceM: dist ? dist * factor : null,
          superset: null,
        };
      }
    } catch {
      problems.push(`Row ${line} has a date or number that couldn't be read.`);
      continue;
    }
    if (!name) {
      problems.push(`Row ${line} has no exercise name.`);
      continue;
    }
    if (parsed.weightKg !== null && !(parsed.weightKg >= 0 && parsed.weightKg <= 1000)) {
      problems.push(`Row ${line} has an implausible weight.`);
      continue;
    }
    if (parsed.reps !== null && !(parsed.reps >= 0 && parsed.reps <= 1000)) {
      problems.push(`Row ${line} has an implausible number of reps.`);
      continue;
    }
    if (parsed.rpe !== null && !(parsed.rpe >= 1 && parsed.rpe <= 10)) parsed.rpe = null;
    let s = sessions.get(key);
    if (s === undefined) {
      s = {
        startedAt: started.ms,
        offsetMin: started.offsetMin,
        title: (title ?? "").trim().slice(0, 80) || null,
        notes: (notes ?? "").trim().slice(0, 2000) || null,
        durationSec: dur && dur <= 48 * 3600 ? dur : null,
        sets: [],
      };
      sessions.set(key, s);
      order.set(key, new Map());
    }
    if (s.sets.length >= MAX_SETS_PER_SESSION) continue;
    const counts = order.get(key) as Map<string, number>;
    parsed.setIndex = counts.get(name) ?? 0;
    counts.set(name, parsed.setIndex + 1);
    s.sets.push(parsed);
  }
  return { format, sessions: [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt), problems };
}

// ---- matching names to the library ----------------------------------------------------------------------------

const EQUIPMENT_WORDS: Readonly<Record<string, string>> = {
  barbell: "barbell",
  dumbbell: "dumbbell",
  dumbbells: "dumbbell",
  cable: "cable",
  machine: "machine",
  "smith machine": "smith",
  smith: "smith",
  kettlebell: "kettlebell",
  band: "band",
  bodyweight: "bodyweight",
  weighted: "bodyweight",
  assisted: "machine",
  "ez bar": "barbell",
  "trap bar": "barbell",
  plate: "dumbbell",
};

const SYNONYMS: Readonly<Record<string, string>> = {
  squat: "back squat",
  "bench press": "bench press",
  "overhead press": "overhead press",
  "military press": "overhead press",
  "shoulder press": "dumbbell shoulder press",
  "bent over row": "barbell row",
  "bent over one arm row": "one arm dumbbell row",
  deadlift: "deadlift",
  "romanian deadlift": "romanian deadlift",
  "pull up": "pull up",
  "chin up": "chin up",
  "lat pulldown": "lat pulldown",
  "seated row": "seated cable row",
  "bicep curl": "dumbbell curl",
  "biceps curl": "dumbbell curl",
  "triceps pushdown": "triceps pushdown",
  "triceps extension": "overhead triceps extension",
  "lateral raise": "lateral raise",
  "leg press": "leg press",
  "leg extension": "leg extension",
  "lying leg curl": "lying leg curl",
  "seated leg curl": "seated leg curl",
  "calf raise": "standing calf raise",
  "standing calf raise": "standing calf raise",
  "hip thrust": "hip thrust",
  plank: "plank",
  crunch: "crunch",
  "push up": "push up",
  dip: "dip",
  dips: "dip",
  lunge: "forward lunge",
  lunges: "forward lunge",
  curl: "dumbbell curl",
  skullcrusher: "skull crusher",
  rdl: "romanian deadlift",
  ohp: "overhead press",
  "face pull": "face pull",
  shrug: "shrug",
  "incline bench press": "incline bench press",
  "flat dumbbell bench press": "dumbbell bench press",
};

const EQUIPMENT_PREFIX: Readonly<Record<string, string>> = { smith: "smith machine" };
const FILLER = new Set(["flat", "standard", "regular", "the", "a"]);
const BRACKET = /^(.*?)\s*\(([^)]*)\)\s*$/s;

const keyOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "")
    .join(" ");

function splitName(name: string): [string, string | null] {
  const m = BRACKET.exec(name);
  if (m === null) return [keyOf(name), null];
  return [keyOf(m[1] ?? ""), EQUIPMENT_WORDS[keyOf(m[2] ?? "")] ?? null];
}

// Python's sorted(..., key=len, reverse=True) is stable on dict order.
const WORDS_BY_LENGTH = Object.keys(EQUIPMENT_WORDS)
  .map((w, i) => [w, i] as const)
  .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
  .map(([w]) => w);

function stripEquipment(key: string): [string, string | null] {
  let found: string | null = null;
  let k = key;
  for (const word of WORDS_BY_LENGTH) {
    const re = new RegExp(`\\b${word}\\b`, "g");
    if (re.test(k)) {
      found ??= EQUIPMENT_WORDS[word] ?? null;
      k = k.replace(new RegExp(`\\b${word}\\b`, "g"), " ");
    }
  }
  return [
    k
      .split(" ")
      .filter((w) => w !== "" && !FILLER.has(w))
      .join(" "),
    found,
  ];
}

const indexes = new WeakMap<readonly CatalogExercise[], Map<string, CatalogExercise[]>>();

function indexOf(exercises: readonly CatalogExercise[]): Map<string, CatalogExercise[]> {
  let index = indexes.get(exercises);
  if (index === undefined) {
    index = new Map();
    for (const e of exercises) {
      for (const label of [e.name, ...e.aliases]) {
        const k = keyOf(label);
        const list = index.get(k);
        if (list === undefined) index.set(k, [e]);
        else list.push(e);
      }
    }
    indexes.set(exercises, index);
  }
  return index;
}

/** The library id for a name written by another app, or null (Python `match_exercise`). */
export function matchExercise(name: string, exercises: readonly CatalogExercise[]): string | null {
  const index = indexOf(exercises);
  const whole = index.get(keyOf(name));
  if (whole?.[0] !== undefined) return whole[0].id;
  const bracket = BRACKET.exec(name);
  if (bracket !== null) {
    const joined = index.get(keyOf(`${bracket[2]} ${bracket[1]}`));
    if (joined?.[0] !== undefined) return joined[0].id;
  }
  const [b0, tagged] = splitName(name);
  const [base, inner] = stripEquipment(b0);
  const equipment = tagged ?? inner;
  const stemsRaw = [base];
  const syn = SYNONYMS[base];
  if (syn !== undefined) stemsRaw.push(stripEquipment(syn)[0]);
  const single = SYNONYMS[base.slice(0, -1)];
  if (base.endsWith("s") && single !== undefined) stemsRaw.push(stripEquipment(single)[0]);
  const stems = [...new Set(stemsRaw)].filter((s) => s !== "");
  const hits: CatalogExercise[] = [];
  for (const stem of stems) {
    const variants = [stem];
    if (equipment && equipment !== "bodyweight")
      variants.unshift(`${EQUIPMENT_PREFIX[equipment] ?? equipment} ${stem}`);
    variants.push(SYNONYMS[stem] ?? "");
    for (const v of variants) hits.push(...(index.get(v) ?? []));
  }
  if (hits.length === 0) return null;
  if (equipment) return hits.find((e) => e.equipment === equipment)?.id ?? null;
  return hits[0]?.id ?? null;
}

const RULES: readonly [readonly string[], string, readonly string[]][] = [
  [["squat", "lunge", "leg press", "step up"], "squat", ["quads", "glutes"]],
  [["deadlift", "rdl", "hip thrust", "good morning", "swing", "leg curl"], "hinge", ["hamstrings", "glutes"]],
  [["bench", "chest press", "push up", "fly", "dip"], "push_h", ["chest", "triceps"]],
  [["overhead press", "shoulder press", "military", "arnold"], "push_v", ["front_delts", "triceps"]],
  [["pulldown", "pull up", "chin up", "pullover"], "pull_v", ["lats"]],
  [["row"], "pull_h", ["upper_back", "lats"]],
  [["raise", "shrug", "face pull"], "shoulders", ["side_delts"]],
  [["curl"], "arms", ["biceps"]],
  [["extension", "pushdown", "skull", "kickback"], "arms", ["triceps"]],
  [["calf"], "calves", ["calves"]],
  [["plank", "crunch", "sit up", "leg raise", "ab "], "core", ["abs"]],
  [["carry", "walk"], "carry", ["forearms"]],
];

/** Pattern, equipment and muscles for an unmatched name, so a created custom exercise lands somewhere sensible. */
export function guessPattern(name: string): [string, string, string[]] {
  const [base, equipment] = splitName(name);
  for (const [words, pattern, muscles] of RULES) {
    if (words.some((w) => `${base} `.includes(w))) return [pattern, equipment ?? "machine", [...muscles]];
  }
  return ["core", equipment ?? "machine", ["abs"]];
}
