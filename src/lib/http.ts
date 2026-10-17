/**
 * Cross-cutting HTTP middleware with the Python service's exact semantics (spec/core.md §2.1, §2.6).
 */
import type { MiddlewareHandler } from "hono";

export const API_VERSION = "1";

/** `PaceStreak-Version: 1` on every response whose path starts with `/v1`, including errors and preflights. */
export function versionHeader(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } finally {
      if (c.req.path.startsWith("/v1")) c.res.headers.set("PaceStreak-Version", API_VERSION);
    }
  };
}

const ALLOW_METHODS = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT";
const MAX_AGE = "600";

const originSets = new Map<string, ReadonlySet<string>>();

/** Comma list, trimmed, empties dropped; parsed once per distinct value. `*` is refused by the config gate. */
export function parseOrigins(raw: string): ReadonlySet<string> {
  let set = originSets.get(raw);
  if (set === undefined) {
    set = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    originSets.set(raw, set);
  }
  return set;
}

function addVary(headers: Headers, value: string): void {
  const cur = headers.get("Vary");
  if (cur === null) headers.set("Vary", value);
  else if (
    !cur
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .includes(value.toLowerCase())
  )
    headers.set("Vary", `${cur}, ${value}`);
}

/**
 * Starlette's CORSMiddleware with explicit origins, credentials, all methods and all headers:
 * - preflight (OPTIONS + Origin + Access-Control-Request-Method) is answered here: 200 `OK`, or 400
 *   `Disallowed CORS origin`, with the preflight headers either way;
 * - any other request with an Origin gets `Access-Control-Allow-Credentials: true`, and the echoed origin plus
 *   `Vary: Origin` when the origin is allowed. Disallowed origins are still processed (the browser blocks them).
 */
export function cors(origins: (env: { CORS_ORIGINS: string }) => ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin === undefined) return next();
    const allowed = origins(c.env as { CORS_ORIGINS: string }).has(origin);

    if (c.req.method === "OPTIONS" && c.req.header("Access-Control-Request-Method") !== undefined) {
      const headers = new Headers({
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Max-Age": MAX_AGE,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
        "Content-Type": "text/plain; charset=utf-8",
      });
      const requested = c.req.header("Access-Control-Request-Headers");
      if (requested !== undefined) headers.set("Access-Control-Allow-Headers", requested);
      if (!allowed) return new Response("Disallowed CORS origin", { status: 400, headers });
      headers.set("Access-Control-Allow-Origin", origin);
      return new Response("OK", { status: 200, headers });
    }

    await next();
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
    if (allowed) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      addVary(c.res.headers, "Origin");
    }
  };
}

/** The caller's IP: Cloudflare's `CF-Connecting-IP`, else the first `X-Forwarded-For` entry; max 45 chars. */
export function clientIp(req: { header(name: string): string | undefined }): string | null {
  const ip = req.header("CF-Connecting-IP") ?? req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  return ip === undefined || ip === "" ? null : ip.slice(0, 45);
}
