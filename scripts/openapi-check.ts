/**
 * Structural checks for openapi.json, shared by scripts/openapi.ts (which refuses to write a bad document) and
 * test/openapi.test.ts (which holds the committed document against the live router). No Node imports: the test
 * runs in workerd.
 */

export interface MountedRoute {
  method: string;
  /** Hono syntax: `/v1/habits/:id`. */
  path: string;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Hono path syntax to OpenAPI: `:id` and `:id{re}` become `{id}`. */
export function toOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const m = /^:(\w+)(?:\{.+\})?\??$/.exec(seg);
      return m ? `{${m[1]}}` : seg;
    })
    .join("/");
}

/**
 * The routes a Hono app actually serves: one per registration (a registration adds one entry per handler, so
 * consecutive entries with the same method and path collapse), skipping `use()` middleware.
 */
export function mountedRoutes(routes: readonly { method: string; path: string }[]): MountedRoute[] {
  const out: MountedRoute[] = [];
  let prev: string | undefined;
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (key === prev) continue;
    prev = key;
    if (r.method === "ALL" && r.path.endsWith("*")) continue;
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function resolveRef(doc: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    if (!isObj(cur)) return undefined;
    cur = cur[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

/** Every problem with `doc` as an OpenAPI 3.1 description of `mounted`; empty when it is sound. */
export function checkSpec(doc: unknown, mounted: readonly MountedRoute[]): string[] {
  const errors: string[] = [];
  if (!isObj(doc)) return ["document is not an object"];
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.1.")) errors.push("openapi is not 3.1.x");
  const info = doc.info;
  if (!isObj(info) || typeof info.title !== "string" || typeof info.version !== "string") {
    errors.push("info.title and info.version are required");
  }
  if (!Array.isArray(doc.servers) || doc.servers.length === 0) errors.push("servers is empty");
  const paths = doc.paths;
  if (!isObj(paths)) return [...errors, "paths is missing"];

  // Every $ref resolves.
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${at}/${i}`);
    } else if (isObj(v)) {
      if (typeof v.$ref === "string" && resolveRef(doc, v.$ref) === undefined) {
        errors.push(`${at}: unresolved $ref ${v.$ref}`);
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${at}/${k}`);
    }
  };
  walk(doc, "#");

  const schemes =
    isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  const operationIds = new Set<string>();
  const described = new Set<string>();
  let count = 0;
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith("/")) errors.push(`${path}: path must start with /`);
    if (!isObj(item)) {
      errors.push(`${path}: path item is not an object`);
      continue;
    }
    const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    for (const [method, op] of Object.entries(item)) {
      if (!(METHODS as readonly string[]).includes(method)) {
        errors.push(`${path}: unexpected key ${method}`);
        continue;
      }
      const where = `${method.toUpperCase()} ${path}`;
      if (!isObj(op)) {
        errors.push(`${where}: operation is not an object`);
        continue;
      }
      count++;
      described.add(where);
      if (typeof op.operationId !== "string") errors.push(`${where}: no operationId`);
      else if (operationIds.has(op.operationId))
        errors.push(`${where}: duplicate operationId ${op.operationId}`);
      else operationIds.add(op.operationId);
      if (!isObj(op.responses) || Object.keys(op.responses).length === 0)
        errors.push(`${where}: no responses`);
      const params = Array.isArray(op.parameters) ? op.parameters : [];
      const declared = new Set<string>();
      for (const p of params) {
        const param = isObj(p) && typeof p.$ref === "string" ? resolveRef(doc, p.$ref) : p;
        if (!isObj(param) || typeof param.name !== "string" || typeof param.in !== "string") {
          errors.push(`${where}: malformed parameter`);
          continue;
        }
        if (!["path", "query", "header", "cookie"].includes(param.in)) {
          errors.push(`${where}: parameter ${param.name} has bad location ${param.in}`);
        }
        if (param.in === "path") {
          declared.add(param.name);
          if (param.required !== true) errors.push(`${where}: path parameter ${param.name} is not required`);
          if (!templated.includes(param.name))
            errors.push(`${where}: path parameter ${param.name} not in path`);
        }
      }
      for (const name of templated) {
        if (!declared.has(name)) errors.push(`${where}: path parameter ${name} is not declared`);
      }
      if (Array.isArray(op.security)) {
        for (const req of op.security) {
          if (!isObj(req)) continue;
          for (const name of Object.keys(req)) {
            if (!(name in schemes)) errors.push(`${where}: unknown security scheme ${name}`);
          }
        }
      }
    }
  }

  const want = new Set(mounted.map((r) => `${r.method} ${toOpenApiPath(r.path)}`));
  for (const key of want) if (!described.has(key)) errors.push(`mounted route missing from the spec: ${key}`);
  for (const key of described) if (!want.has(key)) errors.push(`spec describes an unmounted route: ${key}`);
  if (count !== mounted.length)
    errors.push(`spec has ${count} operations, the router mounts ${mounted.length}`);
  return errors;
}
