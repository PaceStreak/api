/**
 * The Hono app and its middleware order (DESIGN.md §5), outermost first:
 *   version header -> CORS -> config gate -> request context + body limit -> routes,
 * with the error boundary (`onError`, `notFound`, 405) rendering inside CORS so errors carry CORS headers.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { TrieRouter } from "hono/router/trie-router";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppEnv, createCtx } from "./ctx.ts";
import { loadConfig } from "./env.ts";
import { HttpError, isConstraintError, SAVED_TWICE, SERVER_ERROR } from "./lib/errors.ts";
import { cors, parseOrigins, versionHeader } from "./lib/http.ts";
import { createLogger } from "./lib/logger.ts";

export type App = Hono<AppEnv>;

const MiB = 1024 * 1024;

/**
 * Body size caps by path prefix; everything else gets 1 MiB. Import routes stream their bodies and enforce their
 * own caps with the spec's 413 texts, so they are listed here with the transport ceiling.
 */
export const BODY_LIMITS: readonly { prefix: string; bytes: number }[] = [
  { prefix: "/v1/me/import", bytes: 25 * MiB },
  { prefix: "/v1/workouts/import", bytes: 25 * MiB },
  { prefix: "/v1/habits/import", bytes: 5 * MiB },
];
const DEFAULT_BODY_LIMIT = MiB;

export const TOO_LARGE = "That request is too large";

function bodyLimitFor(path: string): number {
  return BODY_LIMITS.find((l) => path.startsWith(l.prefix))?.bytes ?? DEFAULT_BODY_LIMIT;
}

let refusedLogged = false;

/**
 * Builds the app. `mount` registers routes; production uses `mountRoutes` from routes.ts, tests mount fixtures.
 */
export function createApp(mount: (app: App) => void): App {
  const app = new Hono<AppEnv>();

  app.use(versionHeader());
  app.use(cors((env) => parseOrigins(env.CORS_ORIGINS)));

  // Config gate + request context.
  app.use(async (c, next) => {
    const res = loadConfig(c.env);
    if (!res.ok) {
      if (!refusedLogged) {
        refusedLogged = true;
        const log = createLogger();
        for (const reason of res.reasons) log.error(`refusing to start: ${reason}`);
      }
      return c.json({ detail: SERVER_ERROR }, 500);
    }
    const rid = c.req.header("cf-ray") ?? crypto.randomUUID();
    const ctx = createCtx(c.env, res.config, c.executionCtx, rid);
    c.set("ctx", ctx);
    const started = Date.now();
    try {
      await next();
    } finally {
      c.res.headers.set("X-Request-Id", rid);
      ctx.log.info("request", {
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        ms: Date.now() - started,
        d1_round_trips: ctx.stats.roundTrips,
        d1_statements: ctx.stats.statements,
      });
    }
    return;
  });

  app.use((c, next) =>
    bodyLimit({
      maxSize: bodyLimitFor(c.req.path),
      onError: (c2) => c2.json({ detail: TOO_LARGE }, 413),
    })(c, next),
  );

  mount(app);

  app.notFound((c) => {
    const allowed = allowedMethods(app, c.req.path);
    if (allowed.length > 0) {
      return c.json({ detail: "Method Not Allowed" }, 405, { Allow: allowed.join(", ") });
    }
    return c.json({ detail: "Not Found" }, 404);
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.body, err.status, err.headers);
    if (isConstraintError(err)) return c.json({ detail: SAVED_TWICE }, 409);
    if (err instanceof HTTPException) {
      return c.json({ detail: err.message }, err.status as ContentfulStatusCode);
    }
    const log = c.var.ctx?.log ?? createLogger();
    log.error(`Unhandled error on ${c.req.method} ${c.req.routePath}`, err);
    return c.json({ detail: SERVER_ERROR }, 500);
  });

  return app;
}

const methodIndexes = new WeakMap<App, TrieRouter<string>>();

/** Methods registered for `path` (any method), for 405 + `Allow`. Built once per app from its route table. */
function allowedMethods(app: App, path: string): string[] {
  let router = methodIndexes.get(app);
  if (router === undefined) {
    router = new TrieRouter<string>();
    for (const r of app.routes) {
      if (r.method !== "ALL") router.add("ALL", r.path, r.method);
    }
    methodIndexes.set(app, router);
  }
  const [matches] = router.match("GET", path);
  const methods = new Set<string>();
  for (const m of matches) {
    const method = m[0];
    methods.add(method);
    if (method === "GET") methods.add("HEAD");
  }
  return [...methods].sort();
}
