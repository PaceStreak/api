/**
 * App contract extraction (DESIGN.md §15). Reads `PaceStreak/app`'s `src/` and lists every call the app makes to
 * the API as `METHOD /v1/path`, with `${...}` path segments normalised to `:param` and query strings dropped.
 * `test/contract/routes.test.ts` asserts that each one is a mounted Hono route.
 *
 * Call sites understood (all in non-test app files):
 *   - `api(path, opts?)`: the method is `opts.method`, else POST when the options carry `body`/`form`/`blob`, else
 *     GET (the app's own default in src/lib/api.ts);
 *   - `get|post|put|patch|del(path, ...)` when imported from the app's `lib/api`;
 *   - `useCachedQuery(key, path)` (GET), `sendOrQueue[WithResult](path, "PUT"|"DELETE")`,
 *     `deleteWithUndo({ path })` (DELETE), `["name", "/path"]` tuples in `OFFLINE_ESSENTIALS` (GET);
 *   - raw `fetch(\`${API_BASE}/v1/...\`, { method })`.
 * A call whose path is not a literal must sit in one of the known forwarding helpers (FORWARDERS); anywhere else it
 * is reported as an error, so a new dynamic call site cannot slip past the check.
 *
 * It also vendors the app's `src/lib/types.ts` as `test/contract/app-types.ts`, which the response schemas in
 * test/contract/schemas.ts are type-checked against (`satisfies`).
 *
 * Usage: tsx scripts/extract-app-routes.ts [--app ../app] [--check]
 *   --check: fail (exit 1) when the committed files differ from what the app would produce (CI, with the app
 *   checked out at its `main` or `api-next`).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const OUT_ROUTES = path.join(root, "test/contract/app-routes.json");
const OUT_TYPES = path.join(root, "test/contract/app-types.ts");

/** Files whose non-literal `api(...)` calls only forward a path their callers pass as a literal. */
const FORWARDERS = new Set([
  "src/lib/api.ts",
  "src/lib/queries.ts",
  "src/lib/requests.ts",
  "src/lib/undo.ts",
]);

export interface CallSite {
  method: string;
  path: string;
  where: string;
}

// ---- a small lexer: enough of JS/TS to skip comments and read string and template literals --------------------

/** Blank out comments (keeping offsets and newlines), leaving strings and templates intact. */
export function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const templateDepth: number[] = []; // brace depth at which each open `${` resumes its template
  let braces = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const skipString = (q: string) => {
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  const skipTemplate = (): void => {
    // at the character after "`" or after the "}" closing a substitution
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        templateDepth.push(braces);
        braces++;
        return;
      } else i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") skipString(c);
    else if (c === "`") {
      i++;
      skipTemplate();
    } else if (c === "{") {
      braces++;
      i++;
    } else if (c === "}") {
      braces--;
      i++;
      if (templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braces) {
        templateDepth.pop();
        skipTemplate();
      }
    } else i++;
  }
  return out.join("");
}

/** The file being read, for resolving a substitution's identifier to its `const`. */
let fileSrc = "";

const CHOICE = /^.*\?\s*["']([\w-]+)["']\s*:\s*["']([\w-]+)["']\s*$/;

/**
 * The fixed words a substitution can produce: `cond ? "a" : "b"`, an identifier bound in the same file to such an
 * expression (`const kind = ... ? "following" : "followers"`), or one typed as a union of string literals. Null for
 * anything else.
 */
export function choices(expr: string): string[] | null {
  const e = expr.trim();
  const direct = CHOICE.exec(e);
  if (direct) return [direct[1] as string, direct[2] as string];
  if (!/^[A-Za-z_$][\w$]*$/.test(e)) return null;
  const bound = new RegExp(`\\bconst\\s+${e}\\s*=\\s*([^;\\n]+)`).exec(fileSrc);
  const via = bound ? CHOICE.exec(bound[1] ?? "") : null;
  if (via) return [via[1] as string, via[2] as string];
  // A parameter typed as a union of literals: `decision: "accept" | "decline"`.
  const typed = new RegExp(`\\b${e}\\??\\s*:\\s*((?:"[\\w-]+"\\s*\\|\\s*)+"[\\w-]+")`).exec(fileSrc);
  return typed ? [...(typed[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1] as string) : null;
}

/**
 * The literal starting at `i` (a quote or backtick), with `${...}` replaced by "\uE000", or by "\uE001a|b\uE002" when
 * it can only be one of a few words (see `choices`); null when not a literal.
 */
export function readLiteral(src: string, i: number): { value: string; end: number } | null {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let value = "";
  let k = i + 1;
  while (k < src.length && src[k] !== q) {
    if (src[k] === "\\") {
      value += src[k + 1];
      k += 2;
    } else if (q === "`" && src[k] === "$" && src[k + 1] === "{") {
      let depth = 1;
      k += 2;
      const exprStart = k;
      while (k < src.length && depth > 0) {
        const c = src[k];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          const inner = readLiteral(src, k);
          if (inner) {
            k = inner.end;
            continue;
          }
        }
        k++;
      }
      const alt = choices(src.slice(exprStart, k - 1));
      value += alt ? `\uE001${alt.join("|")}\uE002` : "\uE000";
    } else value += src[k++];
  }
  return { value, end: k + 1 };
}

/** The argument text of a call whose "(" is at `open`, split on top-level commas. */
export function callArgs(src: string, open: number): { args: string[]; argStarts: number[]; end: number } {
  const args: string[] = [];
  const argStarts: number[] = [];
  let depth = 0;
  let start = open + 1;
  let k = open;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '"' || c === "'" || c === "`") {
      const lit = readLiteral(src, k);
      if (lit) k = lit.end - 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, k));
      argStarts.push(start);
      start = k + 1;
    }
  }
  const last = src.slice(start, k);
  if (last.trim() !== "") {
    args.push(last);
    argStarts.push(start);
  }
  return { args, argStarts, end: k + 1 };
}

/** A path literal normalised: `${...}` segments become `:param`, the query string and a trailing `${...}` go. */
export function normalisePath(raw: string): string {
  let p = raw.split("?")[0] ?? "";
  // A substitution that does not fill a whole segment at the end is a query suffix (`/x${qs}`): drop it.
  p = p.replace(/([^/])\uE000+$/, "$1");
  return p
    .split("/")
    .map((seg) => (seg.includes("\uE000") ? ":param" : seg))
    .join("/")
    .replace(/\/+$/, "");
}

function literalArg(src: string, start: number): string | null {
  let k = start;
  while (/\s/.test(src[k] ?? "")) k++;
  return readLiteral(src, k)?.value ?? null;
}

/** Whether an expression is a conditional at its top level (a `?` outside any bracket, string or `?.`/`??`). */
function topLevelTernary(expr: string): boolean {
  let depth = 0;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k];
    if (c === '"' || c === "'" || c === "`") {
      const lit = readLiteral(expr, k);
      if (lit) k = lit.end - 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "?" && depth === 0 && expr[k + 1] !== "." && expr[k + 1] !== "?" && expr[k - 1] !== "?")
      return true;
  }
  return false;
}

/**
 * The methods a call's options can produce. A ternary (`reaction ? { body } : { method: "DELETE" }`) gives each
 * branch's method; a branch with a body and no method is POST, one with neither is GET.
 */
function methodsFromOptions(opts: string | undefined, fallback: string): string[] {
  if (opts === undefined) return [fallback];
  const explicit = [...opts.matchAll(/\bmethod\s*:\s*["'`](\w+)["'`]/g)].map((m) =>
    (m[1] as string).toUpperCase(),
  );
  const hasBody = /\b(body|form|blob)\b/.test(opts);
  if (explicit.length === 0) {
    if (/\bmethod\s*[:,}]/.test(opts)) return ["DYNAMIC"];
    return [hasBody ? "POST" : fallback];
  }
  const ternary = topLevelTernary(opts);
  if (ternary && explicit.length < 2) explicit.push(hasBody ? "POST" : fallback);
  return [...new Set(explicit)];
}

/** Local names bound to the app's lib/api helpers in this file. */
function apiImports(src: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][./]*(?:lib\/)?api["']/g)) {
    for (const spec of (m[1] ?? "").split(",")) {
      const [orig, alias] = spec.trim().split(/\s+as\s+/);
      if (orig) names.set((alias ?? orig).trim(), orig.trim());
    }
  }
  return names;
}

const VERB: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE" };

export function extractFile(rel: string, text: string): { calls: CallSite[]; errors: string[] } {
  const src = stripComments(text);
  fileSrc = src;
  const calls: CallSite[] = [];
  const errors: string[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const imported = apiImports(src);
  const isApiModule = rel === "src/lib/api.ts";
  const callee = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(/g;
  for (const m of src.matchAll(callee)) {
    const name = m[1] ?? "";
    const open = (m.index ?? 0) + m[0].length - 1;
    const where = `${rel}:${lineOf(m.index ?? 0)}`;
    const add = (method: string, raw: string | null) => {
      if (raw === null) {
        if (!FORWARDERS.has(rel)) errors.push(`${where}: ${name}() with a non-literal path`);
        return;
      }
      const alt = /\uE001([^\uE002]*)\uE002/.exec(raw);
      if (alt) {
        for (const word of (alt[1] ?? "").split("|")) add(method, raw.replace(alt[0], word));
        return;
      }
      if (!raw.startsWith("/")) {
        errors.push(`${where}: ${name}() path does not start with "/": ${JSON.stringify(raw)}`);
        return;
      }
      if (method === "DYNAMIC") {
        // `{ method }` from a parameter typed as a union of literals (`method: "POST" | "DELETE"`): the nearest
        // such annotation before the call gives every method it can be.
        const before = src.slice(0, m.index ?? 0);
        const unions = [...before.matchAll(/\bmethod\??\s*:\s*((?:"[A-Z]+"\s*\|\s*)*"[A-Z]+")/g)];
        const union = unions[unions.length - 1]?.[1];
        if (union === undefined) {
          if (!FORWARDERS.has(rel)) errors.push(`${where}: ${name}() with a non-literal method`);
          return;
        }
        for (const u of union.matchAll(/"([A-Z]+)"/g))
          calls.push({ method: u[1] as string, path: `/v1${normalisePath(raw)}`, where });
        return;
      }
      calls.push({ method, path: `/v1${normalisePath(raw)}`, where });
    };
    const verb = isApiModule ? undefined : imported.get(name);
    if (name === "api" && (isApiModule || imported.get("api") === "api")) {
      const { args, argStarts } = callArgs(src, open);
      if (args.length === 0 || argStarts[0] === undefined) continue;
      const raw = literalArg(src, argStarts[0]);
      for (const method of methodsFromOptions(args[1], "GET")) add(method, raw);
    } else if (verb !== undefined && verb in VERB) {
      const { argStarts } = callArgs(src, open);
      if (argStarts[0] === undefined) continue;
      add(VERB[verb] as string, literalArg(src, argStarts[0]));
    } else if (name === "useCachedQuery") {
      const { argStarts } = callArgs(src, open);
      if (argStarts[1] !== undefined) add("GET", literalArg(src, argStarts[1]));
    } else if (name === "sendOrQueue" || name === "sendOrQueueWithResult") {
      const { args, argStarts } = callArgs(src, open);
      if (argStarts[0] === undefined) continue;
      const method = literalArg(src, argStarts[1] ?? 0) ?? (args[1] ? "DYNAMIC" : "GET");
      add(method.toUpperCase(), literalArg(src, argStarts[0]));
    } else if (name === "deleteWithUndo") {
      const { args } = callArgs(src, open);
      const pm = /\bpath\s*:\s*/.exec(args[0] ?? "");
      if (!pm) {
        errors.push(`${where}: deleteWithUndo() without a path`);
        continue;
      }
      const lit = readLiteral(args[0] ?? "", pm.index + pm[0].length);
      add("DELETE", lit?.value ?? null);
    } else if (name === "fetch") {
      const { args, argStarts } = callArgs(src, open);
      if (argStarts[0] === undefined) continue;
      const raw = literalArg(src, argStarts[0]);
      if (raw === null || !/^\uE000\/v1(\/|\uE000|$)/.test(raw)) continue; // not an API_BASE fetch
      if (raw === "\uE000/v1\uE000") continue; // api() itself
      for (const method of methodsFromOptions(args[1], "GET"))
        calls.push({ method, path: normalisePath(raw.slice(1)), where });
    }
  }
  // ["name", "/path"] tuples in the offline warm-up list.
  const warm = /OFFLINE_ESSENTIALS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (warm) {
    const base = warm.index + warm[0].indexOf("[");
    for (const t of (warm[1] ?? "").matchAll(/\[\s*"[^"]*"\s*,\s*"(\/[^"]*)"\s*\]/g))
      calls.push({
        method: "GET",
        path: `/v1${normalisePath(t[1] ?? "")}`,
        where: `${rel}:${lineOf(base + (t.index ?? 0))}`,
      });
  }
  return { calls, errors };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
      out.push(full);
  }
  return out;
}

export function extractApp(appDir: string): { calls: CallSite[]; errors: string[] } {
  const calls: CallSite[] = [];
  const errors: string[] = [];
  for (const file of walk(path.join(appDir, "src"))) {
    const rel = path.relative(appDir, file).split(path.sep).join("/");
    const got = extractFile(rel, readFileSync(file, "utf8"));
    calls.push(...got.calls);
    errors.push(...got.errors);
  }
  return { calls, errors };
}

/** `{"METHOD /path": ["file:line", ...]}`, sorted. */
export function routeTable(calls: readonly CallSite[]): Record<string, string[]> {
  const table = new Map<string, string[]>();
  for (const c of calls) {
    const key = `${c.method} ${c.path}`;
    table.set(key, [...(table.get(key) ?? []), c.where]);
  }
  return Object.fromEntries([...table.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const TYPES_HEADER =
  "// Vendored from PaceStreak/app src/lib/types.ts by scripts/extract-app-routes.ts. Do not edit by hand.\n" +
  "";

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--app");
  const appDir = path.resolve(root, at >= 0 ? (argv[at + 1] ?? "") : (process.env.APP_DIR ?? "../app"));
  if (!existsSync(path.join(appDir, "src/lib/api.ts"))) {
    console.error(`no app checkout at ${appDir} (pass --app DIR or set APP_DIR)`);
    process.exit(2);
  }
  const { calls, errors } = extractApp(appDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const routes = `${JSON.stringify(routeTable(calls), null, 2)}\n`;
  const types = TYPES_HEADER + readFileSync(path.join(appDir, "src/lib/types.ts"), "utf8");
  if (argv.includes("--check")) {
    const stale = [
      [OUT_ROUTES, routes],
      [OUT_TYPES, types],
    ].filter(([f, want]) => !existsSync(f as string) || readFileSync(f as string, "utf8") !== want);
    for (const [f] of stale)
      console.error(`${path.relative(root, f as string)} is stale: rerun scripts/extract-app-routes.ts`);
    if (stale.length > 0) process.exit(1);
    console.log(`app contract: ${Object.keys(JSON.parse(routes)).length} routes, up to date`);
    return;
  }
  writeFileSync(OUT_ROUTES, routes);
  writeFileSync(OUT_TYPES, types);
  console.log(`app contract: ${calls.length} call sites, ${Object.keys(JSON.parse(routes)).length} routes`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
