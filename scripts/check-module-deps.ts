/**
 * Enforces the module boundaries from DESIGN.md §2:
 *   1. A file in src/modules/X may import from src/modules/Y (Y != X) only through src/modules/Y/service.ts.
 *   2. src/lib, src/db, src/catalog and src/heavy never import from src/modules.
 *   3. Nothing in src/modules touches the raw D1 binding (`env.DB`): handlers use Ctx.db and AuthedBatch.
 *
 * Usage: tsx scripts/check-module-deps.ts            check ./src, then self-test against the fixture
 *        tsx scripts/check-module-deps.ts <root>     check <root>/src only
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const RAW_DB_RE = /\benv\s*\.\s*DB\b|\[\s*["']DB["']\s*\]/;
const PURE_DIRS = ["lib", "db", "catalog", "heavy"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function resolveTarget(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  return abs.endsWith(".ts") ? abs : `${abs}.ts`;
}

export function checkTree(root: string): Violation[] {
  const src = path.join(root, "src");
  const modulesDir = path.join(src, "modules");
  const violations: Violation[] = [];
  for (const file of walk(src)) {
    const rel = path.relative(src, file).split(path.sep);
    const text = readFileSync(file, "utf8");
    const area = rel[0] ?? "";
    const ownModule = area === "modules" ? rel[1] : undefined;

    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec === undefined) continue;
      const target = resolveTarget(file, spec);
      if (target === null || !target.startsWith(modulesDir + path.sep)) continue;
      const targetRel = path.relative(modulesDir, target).split(path.sep);
      const targetModule = targetRel[0];
      const line = lineOf(text, m.index + (m[0].length - m[0].trimStart().length));
      const where = path.relative(root, file);
      if (PURE_DIRS.includes(area)) {
        violations.push({
          file: where,
          line,
          rule: "pure-imports-module",
          detail: `${area}/ imports ${spec}`,
        });
      } else if (ownModule !== undefined && targetModule !== ownModule) {
        const isService = targetRel.length === 2 && targetRel[1] === "service.ts";
        if (!isService) {
          violations.push({
            file: where,
            line,
            rule: "cross-module-non-service",
            detail: `modules/${ownModule} imports ${spec}; only modules/${targetModule}/service.ts is public`,
          });
        }
      }
    }

    if (ownModule !== undefined) {
      const lines = text.split("\n");
      lines.forEach((l, i) => {
        if (RAW_DB_RE.test(l)) {
          violations.push({
            file: path.relative(root, file),
            line: i + 1,
            rule: "raw-d1",
            detail: "modules must use ctx.db / AuthedBatch, never env.DB",
          });
        }
      });
    }
  }
  return violations;
}

function report(vs: Violation[]): void {
  for (const v of vs) console.error(`${v.file}:${v.line}  [${v.rule}] ${v.detail}`);
}

const arg = process.argv[2];
const repo = path.resolve(import.meta.dirname, "..");
if (arg !== undefined) {
  const vs = checkTree(path.resolve(arg));
  report(vs);
  process.exit(vs.length === 0 ? 0 : 1);
}

const vs = checkTree(repo);
report(vs);
// Self-test: the fixture holds one violation of each rule. If the checker stops finding them, it is broken.
const fixture = checkTree(path.join(repo, "test/fixtures/check-module-deps"));
const rules = new Set(fixture.map((v) => v.rule));
const expected = ["pure-imports-module", "cross-module-non-service", "raw-d1"];
const missing = expected.filter((r) => !rules.has(r));
if (missing.length > 0) {
  console.error(`check-module-deps self-test failed: fixture violations not detected: ${missing.join(", ")}`);
  process.exit(2);
}
if (vs.length > 0) process.exit(1);
console.log("module dependencies ok");
