/**
 * Structural shapes for the golden responses (DESIGN.md §15): keys and JSON types, never values.
 *
 *   "string" | "number" | "boolean" | "null"   scalars
 *   [shape]                                    an array; the element shapes merged ([] when empty)
 *   { key: shape }                             an object with fixed keys
 *   { "*": shape }                             an object keyed by data (dates, ids, slugs): any keys, one shape
 *
 * `null` and `[]` are wildcards in a comparison: a value that happens to be absent today (a cursor at the end, a
 * week without records) must not fail the test, while a missing key, an extra key or a changed type does.
 */
export type Shape = string | Shape[] | { [k: string]: Shape };

const STRUCT_KEY = /^[a-z_][a-z0-9_]*$/;

/**
 * Members that are maps keyed by data even when today's keys look like identifiers (XP sources, tiers, reaction
 * counts, label tables, a feed event's kind-specific `data`): always compared as `{ "*": shape }`.
 */
const MAP_MEMBERS = new Set([
  "by_source",
  "categories",
  "coverage",
  "data",
  "equipment",
  "muscles",
  "patterns",
  "rarity",
  "reactions",
  "unlocked",
]);

export function shapeOf(v: unknown, key = ""): Shape {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const merged = v.reduce<Shape | undefined>(
      (acc, x) => (acc === undefined ? shapeOf(x) : merge(acc, shapeOf(x))),
      undefined,
    );
    return merged === undefined ? [] : [merged];
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 0 && !MAP_MEMBERS.has(key) && entries.every(([k]) => STRUCT_KEY.test(k)))
      return Object.fromEntries(
        entries
          .map(([k, x]) => [k, shapeOf(x, k)])
          .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)),
      );
    if (entries.length === 0) return {};
    const merged = entries.reduce<Shape | undefined>(
      (acc, [, x]) => (acc === undefined ? shapeOf(x) : merge(acc, shapeOf(x))),
      undefined,
    );
    return { "*": merged ?? "null" };
  }
  return typeof v;
}

/** The union of two shapes of the same position (array elements, record values). */
export function merge(a: Shape, b: Shape): Shape {
  if (a === "null") return b;
  if (b === "null") return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    return [merge(a[0] as Shape, b[0] as Shape)];
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, Shape> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k] as Shape, v) : v;
    return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : 1)));
  }
  return a === b ? a : `${a}|${b}`;
}

const isObj = (s: Shape): s is { [k: string]: Shape } => typeof s === "object" && !Array.isArray(s);

/** Differences between a golden shape and an actual one, as `path: expected X, got Y` lines. */
export function diff(want: Shape, got: Shape, at = "$"): string[] {
  if (want === "null" || got === "null") return [];
  if (typeof want === "string" || typeof got === "string") {
    if (typeof want === "string" && typeof got === "string") {
      const w = new Set(want.split("|"));
      return got.split("|").every((t) => w.has(t)) ? [] : [`${at}: expected ${want}, got ${got}`];
    }
    return [`${at}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
  }
  if (Array.isArray(want) || Array.isArray(got)) {
    if (!(Array.isArray(want) && Array.isArray(got))) return [`${at}: array vs object`];
    if (want.length === 0 || got.length === 0) return [];
    return diff(want[0] as Shape, got[0] as Shape, `${at}[]`);
  }
  if ("*" in want || "*" in got) {
    if (!("*" in want))
      return Object.keys(got).length === 0 ? [] : [`${at}: expected fixed keys, got a keyed map`];
    if (!("*" in got)) {
      // A map that happens to hold only identifier-like keys today still has to match the value shape.
      return Object.entries(got).flatMap(([k, v]) => diff(want["*"] as Shape, v, `${at}.${k}`));
    }
    return diff(want["*"] as Shape, got["*"] as Shape, `${at}.*`);
  }
  if (Object.keys(want).length === 0 || Object.keys(got).length === 0) return [];
  const out: string[] = [];
  for (const k of Object.keys(want)) if (!(k in got)) out.push(`${at}.${k}: missing`);
  for (const k of Object.keys(got)) if (!(k in want)) out.push(`${at}.${k}: not in the golden response`);
  for (const k of Object.keys(want))
    if (k in got) out.push(...diff(want[k] as Shape, got[k] as Shape, `${at}.${k}`));
  return out;
}
