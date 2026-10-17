/**
 * Unicode case- and accent-insensitive folding for search and name ordering (DESIGN.md §4).
 * Every `*_fold` column holds `fold(source)`; write them only through `withFold()` (src/db/batch.ts).
 */
export function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function foldOrNull(s: string | null | undefined): string | null {
  return s === null || s === undefined ? null : fold(s);
}

/**
 * A LIKE pattern for `col_fold LIKE ? ESCAPE '\'`. The term is folded and `\`, `%`, `_` are escaped, so user input
 * never acts as a wildcard. `prefix` uses the column's index; `contains` cannot.
 */
export function likePattern(term: string, mode: "prefix" | "contains"): string {
  const escaped = fold(term).replace(/[\\%_]/g, (c) => `\\${c}`);
  return mode === "prefix" ? `${escaped}%` : `%${escaped}%`;
}
