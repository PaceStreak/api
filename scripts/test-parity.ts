/**
 * Pytest-name parity (DESIGN.md §15). Every `def test_*` in docs/rewrite/python-tests must be accounted for by:
 *   - a TS test whose title is the name without `test_` (snake_case), or contains the full `test_name`, or
 *   - a `// parity-dropped: test_name: <reason>` comment anywhere under test/ or src/ (Argon2, Fernet, RS256,
 *     Redis-specific tests and the like).
 * Intentional behaviour changes keep a test whose title starts with `changed: ` and names the pytest test.
 *
 * Ratchet: fails when more names are missing than `maxMissing` in test/parity.json, or when a TS title or comment
 * names a pytest test that does not exist. Lower `maxMissing` in the same commit that ports tests.
 *
 * Usage: tsx scripts/test-parity.ts [--list] [--strict]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PY_DIR = path.join(root, "docs/rewrite/python-tests");

function walk(dir: string, accept: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "fixtures") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** pytest name -> python file. */
export function pytestNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of readdirSync(PY_DIR)
    .filter((f) => /^test_.*\.py$/.test(f))
    .sort()) {
    const text = readFileSync(path.join(PY_DIR, file), "utf8");
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm)) {
      if (m[1] !== undefined) names.set(m[1], file);
    }
  }
  return names;
}

const TITLE_RE = /\b(?:it|test)(?:\.(?:skip|only|todo|concurrent|fails))*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const DROPPED_RE = /\/\/\s*parity-dropped:\s*(test_\w+)\s*:\s*(\S.*)$/gm;
const NAME_IN_TITLE_RE = /\btest_\w+/g;

export interface Claims {
  covered: Set<string>;
  dropped: Map<string, string>;
  unknown: string[];
}

export function claims(known: ReadonlyMap<string, string>): Claims {
  const covered = new Set<string>();
  const dropped = new Map<string, string>();
  const unknown: string[] = [];
  const files = [
    ...walk(path.join(root, "test"), (f) => f.endsWith(".ts")),
    ...walk(path.join(root, "src"), (f) => f.endsWith(".test.ts")),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const m of text.matchAll(TITLE_RE)) {
      const title = m[2] ?? "";
      const plain = title.replace(/^changed:\s*/, "");
      if (known.has(`test_${plain}`)) covered.add(`test_${plain}`);
      for (const n of title.matchAll(NAME_IN_TITLE_RE)) {
        if (known.has(n[0])) covered.add(n[0]);
        else unknown.push(`${rel}: title names unknown pytest test ${n[0]}`);
      }
    }
    for (const m of text.matchAll(DROPPED_RE)) {
      const name = m[1] ?? "";
      if (known.has(name)) dropped.set(name, m[2] ?? "");
      else unknown.push(`${rel}: parity-dropped names unknown pytest test ${name}`);
    }
  }
  return { covered, dropped, unknown };
}

const args = new Set(process.argv.slice(2));
const known = pytestNames();
const { covered, dropped, unknown } = claims(known);
const missing = [...known.keys()].filter((n) => !covered.has(n) && !dropped.has(n));
const cfg = JSON.parse(readFileSync(path.join(root, "test/parity.json"), "utf8")) as { maxMissing: number };

const byFile = new Map<string, number>();
for (const n of missing) byFile.set(known.get(n) ?? "?", (byFile.get(known.get(n) ?? "?") ?? 0) + 1);

console.log(
  `pytest parity: ${known.size} names, ${covered.size} ported, ${dropped.size} dropped, ${missing.length} missing (ratchet ${cfg.maxMissing})`,
);
if (args.has("--list")) {
  for (const [file, n] of [...byFile].sort()) console.log(`  ${file}: ${n} missing`);
  for (const n of missing) console.log(`    ${known.get(n)}::${n}`);
}
for (const u of unknown) console.error(u);

const limit = args.has("--strict") ? 0 : cfg.maxMissing;
if (unknown.length > 0 || missing.length > limit) {
  if (missing.length > limit) console.error(`${missing.length} pytest names missing; allowed ${limit}`);
  process.exit(1);
}
if (missing.length < cfg.maxMissing) {
  console.log(`ratchet: lower maxMissing in test/parity.json to ${missing.length}`);
}
