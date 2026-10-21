/**
 * Writes openapi.json: an OpenAPI 3.1 description of every route src/routes.ts mounts. Node only, run by
 * `pnpm openapi`; nothing in src/ imports it, so the Worker bundle is untouched.
 *
 * It walks the real Hono router rather than a hand-kept list. To see which Zod schema each route validates with,
 * it instruments three modules as Node loads them (module.registerHooks, this process only): the `json`/`query`/
 * `param` factories in src/lib/validation.ts, the guards in src/modules/auth/middleware.ts and `ipRateLimit` in
 * src/lib/ratelimit.ts each record the middleware they return, with their arguments, in a WeakMap. Each route's
 * middleware functions are then looked up there. Response bodies come from the contract schemas
 * (test/contract/endpoints.ts), which the golden test already holds against real responses; other routes get an
 * untyped JSON body. Success statuses are read from the handler's source (`c.json(x, 201)`, `c.body(null, 204)`).
 *
 * The script fails, writing nothing, when any mounted route is missing from the output or the document does not
 * pass scripts/openapi-check.ts. CI regenerates the file and fails on a diff, so it cannot drift silently.
 *
 * Usage: pnpm openapi
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { checkSpec, type MountedRoute, mountedRoutes, toOpenApiPath } from "./openapi-check.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- instrumentation -------------------------------------------------------------------------------------------

interface Mark {
  kind: "json" | "query" | "param" | "guard" | "optionalAuth" | "ipRateLimit";
  args: unknown[];
  role?: "user" | "moderator" | "admin";
}
const MARKS = new WeakMap<object, Mark>();
(globalThis as { __openapiMarks?: WeakMap<object, Mark> }).__openapiMarks = MARKS;

const RECORD = `const __m=globalThis.__openapiMarks;const __w=(kind,f,role)=>(...args)=>{const mw=f(...args);__m.set(mw,{kind,args,role});return mw};`;
const PATCHES: Record<string, { replace?: [RegExp, string][]; append: string }> = {
  "/src/lib/validation.ts": {
    append: `json=__w("json",json);query=__w("query",query);param=__w("param",param);`,
  },
  "/src/lib/ratelimit.ts": { append: `ipRateLimit=__w("ipRateLimit",ipRateLimit);` },
  "/src/modules/auth/middleware.ts": {
    replace: [[/\bconst (auth|moderator|admin|optionalAuth)=/g, "let $1="]],
    append:
      `auth=__w("guard",auth,"user");moderator=__w("guard",moderator,"moderator");admin=__w("guard",admin,"admin");` +
      `optionalAuth=__w("optionalAuth",optionalAuth);`,
  },
};
const patched = new Set<string>();

registerHooks({
  resolve(specifier, context, next) {
    // Workers-only modules that the mailers import; never called while generating.
    if (specifier.startsWith("cloudflare:")) {
      return {
        url: "data:text/javascript,export class EmailMessage{};export function connect(){}",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    const key = Object.keys(PATCHES).find((k) => url.startsWith("file:") && url.endsWith(k));
    if (key === undefined) return result;
    const patch = PATCHES[key] as (typeof PATCHES)[string];
    let source = String(result.source);
    for (const [re, to] of patch.replace ?? []) source = source.replace(re, to);
    const at = source.lastIndexOf("//# sourceMappingURL=");
    const tail = `;{${RECORD}${patch.append}}\n`;
    source = at < 0 ? source + tail : source.slice(0, at) + tail + source.slice(at);
    patched.add(key);
    return { ...result, source };
  },
});

// Loaded by computed URL so tsc (Node types) does not type-check the Workers sources through these imports.
const load = (rel: string) => import(new URL(rel, import.meta.url).href) as Promise<Record<string, unknown>>;
type Mounter = (app: unknown) => void;
const { createApp } = (await load("../src/app.ts")) as { createApp: (mount: Mounter) => unknown };
const { mountRoutes } = (await load("../src/routes.ts")) as { mountRoutes: Mounter };
const { endpoints } = (await load("../test/contract/endpoints.ts")) as {
  endpoints: { name: string; schema: z.ZodType }[];
};
const contractSchemas = await load("../test/contract/schemas.ts");
for (const key of Object.keys(PATCHES)) {
  if (!patched.has(key)) throw new Error(`openapi: ${key} was not instrumented; has it moved?`);
}

// ---- the router ------------------------------------------------------------------------------------------------

type HonoLike = { routes: { method: string; path: string; handler: (...a: never[]) => unknown }[] };

interface Mount {
  prefix: string;
  app: HonoLike;
  exportName: string;
  module: string;
  file: string;
}

/** Every `export const xRoutes = new Hono` in src/modules, with its module and file. */
async function moduleExports(): Promise<Map<object, Omit<Mount, "prefix" | "app">>> {
  const out = new Map<object, Omit<Mount, "prefix" | "app">>();
  const modulesDir = path.join(root, "src/modules");
  for (const module of readdirSync(modulesDir)) {
    for (const name of readdirSync(path.join(modulesDir, module))) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const file = path.join(modulesDir, module, name);
      const text = readFileSync(file, "utf8");
      if (!/export const \w+ = new Hono/.test(text)) continue;
      const mod = (await import(file)) as Record<string, unknown>;
      for (const m of text.matchAll(/export const (\w+) = new Hono/g)) {
        const exportName = m[1] as string;
        out.set(mod[exportName] as object, { exportName, module, file });
      }
    }
  }
  return out;
}

const exportsByApp = await moduleExports();
const mounts: Mount[] = [];
mountRoutes({
  route(prefix: string, app: HonoLike) {
    const where = exportsByApp.get(app);
    if (where === undefined) throw new Error(`openapi: the app mounted at ${prefix} is not a module export`);
    mounts.push({ prefix, app, ...where });
  },
});

/** Hono's mergePath for the shapes used here: a sub-app's "/" is the prefix itself. */
const join = (prefix: string, sub: string) => (sub === "/" ? prefix : `${prefix.replace(/\/$/, "")}${sub}`);

const real = createApp(mountRoutes) as unknown as HonoLike;
const mounted: MountedRoute[] = mountedRoutes(real.routes);

// ---- source: doc comments ---------------------------------------------------------------------------------------

/** The comment directly above `.get("/x", ...)` in the export's chain, keyed `METHOD /x`. */
function docComments(file: string, exportName: string): Map<string, string> {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`export const ${exportName} = new Hono`);
  const next = text.indexOf("export const ", start + 1);
  const lines = text.slice(start, next < 0 ? undefined : next).split("\n");
  const out = new Map<string, string>();
  lines.forEach((line, i) => {
    const m = /^\s*\.(get|post|put|patch|delete)\(\s*"([^"]*)"/.exec(line);
    if (!m) return;
    const comment: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const t = (lines[j] as string).trim();
      if (t.startsWith("//")) comment.unshift(t.replace(/^\/\/\s?/, ""));
      else if (t.startsWith("*") || t.startsWith("/**")) {
        const body = t
          .replace(/^\/\*\*\s?/, "")
          .replace(/\*\/$/, "")
          .replace(/^\*\s?/, "")
          .trim();
        if (body) comment.unshift(body);
      } else break;
    }
    if (comment.length > 0) out.set(`${(m[1] as string).toUpperCase()} ${m[2]}`, comment.join(" "));
  });
  return out;
}

// ---- schemas ----------------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
const components: Record<string, JsonSchema> = {};
const schemaNames = new Map<object, string>();

/** Names for the Zod schemas modules export, so a schema used by several routes is one component. */
async function nameSchemas(): Promise<void> {
  const modulesDir = path.join(root, "src/modules");
  for (const module of readdirSync(modulesDir)) {
    for (const name of ["schemas.ts", "routes.ts"]) {
      const file = path.join(modulesDir, module, name);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(file)) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [k, v] of Object.entries(mod)) {
        if (v instanceof z.ZodType && !schemaNames.has(v)) schemaNames.set(v, `${module}.${k}`);
      }
    }
  }
  for (const [k, v] of Object.entries(contractSchemas)) {
    if (v instanceof z.ZodType && !schemaNames.has(v)) schemaNames.set(v, `responses.${k}`);
  }
}
await nameSchemas();

function convert(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as JsonSchema;
  delete out.$schema;
  return out;
}

/** A `$ref` to a named component, or the schema inline. */
function schemaRef(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const name = schemaNames.get(schema);
  const converted = convert(schema, io);
  if (name === undefined) return converted;
  const key = io === "input" || name.startsWith("responses.") ? name : `${name}.out`;
  components[key] ??= converted;
  return { $ref: `#/components/schemas/${key}` };
}

/** Query or path parameters from an object schema. */
function parameters(schema: z.ZodType, where: "query" | "path"): JsonSchema[] {
  const js = convert(schema, "input");
  const props = (js.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((js.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, s]) => {
    const { description, ...rest } = s;
    return {
      name,
      in: where,
      required: where === "path" || required.has(name),
      ...(typeof description === "string" ? { description } : {}),
      schema: rest,
    };
  });
}

// ---- responses ---------------------------------------------------------------------------------------------------

const responseSchemas = new Map<string, z.ZodType>();
for (const e of endpoints) {
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(e.name);
  if (m) responseSchemas.set(`${m[1]} /v1${m[2]}`, e.schema);
}
/** Response keys use whatever parameter name the contract picked; match on the shape of the path. */
const shapeOf = (key: string) => key.replace(/\{\w+\}/g, "{}");
const responseByShape = new Map([...responseSchemas].map(([k, v]) => [shapeOf(k), v] as const));
const usedResponses = new Set<string>();

function successStatuses(handler: unknown): string[] {
  const src = String(handler);
  const found = new Set<string>();
  for (const m of src.matchAll(/,\s*(20[0-9]|30[0-9])\s*[,)]/g)) found.add(m[1] as string);
  if (/\.redirect\(/.test(src)) found.add("302");
  // No explicit 2xx: `c.json(body)` (an ETag route's 304 comes with a 200).
  if (![...found].some((s) => s.startsWith("2"))) found.add("200");
  return [...found].sort();
}

const ERROR = { $ref: "#/components/schemas/Error" };
const errorResponse = (description: string, schema: JsonSchema = ERROR) => ({
  description,
  content: { "application/json": { schema } },
});

// ---- the document -----------------------------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const paths: Record<string, Record<string, JsonSchema>> = {};
const stats = { operations: 0, requestTyped: 0, responseTyped: 0, generic: 0 };

const operationId = (method: string, p: string) =>
  method.toLowerCase() +
  p
    .replace(/^\/v1/, "")
    .split(/[/-]/)
    .filter(Boolean)
    .map((seg) => {
      const param = /^\{(\w+)\}$/.exec(seg);
      const word = (param ? `by_${param[1]}` : seg).replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");

const verbs: Record<string, string> = {
  GET: "Read",
  POST: "Post to",
  PUT: "Replace",
  PATCH: "Update",
  DELETE: "Delete",
};

for (const mount of mounts) {
  const comments = docComments(mount.file, mount.exportName);
  const groups: { method: string; path: string; handlers: unknown[] }[] = [];
  for (const r of mount.app.routes) {
    const last = groups.at(-1);
    if (last && last.method === r.method && last.path === r.path) last.handlers.push(r.handler);
    else groups.push({ method: r.method, path: r.path, handlers: [r.handler] });
  }
  for (const g of groups) {
    if (g.method === "ALL" && g.path.endsWith("*")) continue;
    const full = toOpenApiPath(join(mount.prefix, g.path));
    const method = g.method.toLowerCase();
    const handler = g.handlers.at(-1);
    const marks = g.handlers.map((h) => MARKS.get(h as object)).filter((m): m is Mark => m !== undefined);
    const find = (kind: Mark["kind"]) => marks.find((m) => m.kind === kind);

    const op: JsonSchema = {
      operationId: operationId(g.method, full),
      tags: [mount.module],
      summary: comments.get(`${g.method} ${g.path}`) ?? `${verbs[g.method] ?? g.method} ${full}`,
    };
    const params: JsonSchema[] = [];
    const paramMark = find("param");
    if (paramMark) params.push(...parameters(paramMark.args[0] as z.ZodType, "path"));
    for (const name of [...full.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string)) {
      if (!params.some((p) => p.name === name && p.in === "path")) {
        params.push({ name, in: "path", required: true, schema: { type: "string" } });
      }
    }
    const queryMark = find("query");
    if (queryMark) params.push(...parameters(queryMark.args[0] as z.ZodType, "query"));
    if (params.length > 0) op.parameters = params;

    const jsonMark = find("json");
    if (jsonMark) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: schemaRef(jsonMark.args[0] as z.ZodType, "input") } },
      };
    }
    if (jsonMark || queryMark || paramMark) stats.requestTyped++;

    const guard = find("guard");
    const handlerSrc = String(handler);
    const cookie = /\b(refreshCookie|requireCsrf)\(/.test(handlerSrc);
    if (guard) {
      op.security = [{ bearerAuth: [] }];
      if (guard.role !== "user") op.description = `Requires the ${guard.role} role; anyone else gets 404.`;
    } else if (find("optionalAuth")) op.security = [{ bearerAuth: [] }, {}];
    else if (cookie) op.security = [{ refreshCookie: [] }];
    else op.security = [];

    const responses: Record<string, unknown> = {};
    const key = `${g.method} ${full}`;
    const typed = responseSchemas.get(key) ?? responseByShape.get(shapeOf(key));
    if (typed) {
      usedResponses.add(key);
      stats.responseTyped++;
    }
    for (const status of successStatuses(handler)) {
      if (status === "204") responses[status] = { description: "No content" };
      else if (status.startsWith("3")) responses[status] = { description: "Redirect" };
      else {
        responses[status] = {
          description: "Success",
          content: { "application/json": { schema: typed ? schemaRef(typed, "output") : {} } },
        };
      }
    }
    if (!typed) stats.generic++;

    const write = g.method !== "GET";
    const rateLimit = find("ipRateLimit");
    if (write) responses["400"] = { $ref: "#/components/responses/BadRequest" };
    if (guard || find("optionalAuth") || cookie)
      responses["401"] = { $ref: "#/components/responses/Unauthorized" };
    if (write || cookie) responses["403"] = { $ref: "#/components/responses/Forbidden" };
    if (params.some((p) => p.in === "path") || (guard && guard.role !== "user")) {
      responses["404"] = { $ref: "#/components/responses/NotFound" };
    }
    if (write) responses["409"] = { $ref: "#/components/responses/Conflict" };
    if (jsonMark || queryMark || paramMark || /\b422\b/.test(handlerSrc)) {
      responses["422"] = { $ref: "#/components/responses/ValidationError" };
    }
    if (rateLimit || (guard && write)) responses["429"] = { $ref: "#/components/responses/RateLimited" };
    op.responses = responses;

    paths[full] ??= {};
    const item = paths[full] as Record<string, JsonSchema>;
    if (item[method] !== undefined) throw new Error(`openapi: ${key} is mounted twice`);
    item[method] = op;
    stats.operations++;
  }
}

for (const key of responseSchemas.keys()) {
  if (!usedResponses.has(key) && ![...usedResponses].some((u) => shapeOf(u) === shapeOf(key))) {
    throw new Error(`openapi: contract endpoint ${key} matches no mounted route`);
  }
}

const sortedComponents = Object.fromEntries(
  Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
);

const doc = {
  openapi: "3.1.1",
  info: {
    title: "PaceStreak API",
    version: pkg.version,
    description:
      "The API behind app.pacestreak.com. Generated from the router by scripts/openapi.ts; do not edit by hand.",
    contact: { name: "PaceStreak", email: "hello@pacestreak.com", url: "https://www.pacestreak.com" },
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [
    { url: "https://api.pacestreak.com", description: "Production" },
    { url: "https://pacestreak-api-staging.alzywelzy.workers.dev", description: "Staging" },
  ],
  tags: [...new Set(mounts.map((m) => m.module))].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "The access token from sign-in or refresh, in `Authorization: Bearer <token>`.",
      },
      refreshCookie: {
        type: "apiKey",
        in: "cookie",
        name: "__Secure-refresh_token",
        description:
          "The session (refresh) cookie, `Domain=pacestreak.com`, `Path=/v1/auth`, HttpOnly, SameSite=Lax. " +
          "Routes that rotate or end it also need `X-CSRF-Token` equal to the `__Secure-csrf_token` cookie.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        description: "The error envelope (src/lib/errors.ts). `detail` is usually a string.",
        properties: { detail: {} },
        required: ["detail"],
        additionalProperties: true,
      },
      ValidationError: {
        type: "object",
        description: "pydantic v2's 422 envelope (src/lib/validation.ts).",
        properties: {
          detail: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                loc: { type: "array", items: { type: ["string", "integer"] } },
                msg: { type: "string" },
                input: {},
                ctx: { type: "object" },
              },
              required: ["type", "loc", "msg", "input"],
            },
          },
        },
        required: ["detail"],
      },
      IpRateLimited: {
        type: "object",
        description:
          "slowapi's per-IP body, e.g. `Rate limit exceeded: 10 per 1 minute`, with `Retry-After`.",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      ...sortedComponents,
    },
    responses: {
      BadRequest: errorResponse("Bad request"),
      Unauthorized: errorResponse("Missing or invalid credentials"),
      Forbidden: errorResponse("Not allowed (including a missing or wrong CSRF token)"),
      NotFound: errorResponse("Not found"),
      Conflict: errorResponse("Conflict, including a write that raced another"),
      ValidationError: errorResponse("The request failed validation", {
        anyOf: [{ $ref: "#/components/schemas/ValidationError" }, ERROR],
      }),
      RateLimited: {
        description: "Too many requests: the per-user bucket (`detail`) or the per-IP limit (`error`)",
        headers: { "Retry-After": { schema: { type: "integer" } } },
        content: {
          "application/json": {
            schema: { anyOf: [ERROR, { $ref: "#/components/schemas/IpRateLimited" }] },
          },
        },
      },
    },
  },
};

const errors = checkSpec(doc, mounted);
if (errors.length > 0) {
  for (const e of errors) console.error(`openapi: ${e}`);
  process.exit(1);
}

const out = path.join(root, "openapi.json");
const text = `${JSON.stringify(doc, null, 2)}\n`;
writeFileSync(out, text);
console.log(
  `openapi.json: ${stats.operations} operations (router mounts ${mounted.length}); ` +
    `request schemas on ${stats.requestTyped}, typed responses on ${stats.responseTyped}, ` +
    `generic responses on ${stats.generic}; ${text.length} bytes`,
);
