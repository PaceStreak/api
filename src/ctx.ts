/**
 * `Ctx`: everything a request or job needs, built once and passed explicitly. Modules never read `env.DB`;
 * they use `ctx.db` (counted) and, behind auth, `AuthedBatch`.
 */
import type { AuthedBatch } from "./db/batch.ts";
import { createDb, type Db, type DbStats, newStats } from "./db/client.ts";
import type { Config } from "./env.ts";
import { createLogger, type Logger } from "./lib/logger.ts";
import { type Clock, currentClock } from "./lib/time.ts";

export interface Ctx {
  readonly env: Env;
  readonly cfg: Config;
  readonly db: Db;
  readonly stats: DbStats;
  readonly clock: Clock;
  /** Request id: `cf-ray` when present, echoed as `X-Request-Id`. */
  readonly rid: string;
  readonly log: Logger;
  /** Work that may finish after the response (`waitUntil`). Bounded work only: one queue send, one insert. */
  defer(p: Promise<unknown>): void;
}

export interface Deferrer {
  waitUntil(p: Promise<unknown>): void;
}

export function createCtx(env: Env, cfg: Config, exec: Deferrer, rid: string): Ctx {
  const stats = newStats();
  const log = createLogger({ rid });
  return {
    env,
    cfg,
    db: createDb(env.DB, stats),
    stats,
    clock: currentClock(),
    rid,
    log,
    defer: (p) =>
      exec.waitUntil(
        p.catch((err: unknown) => {
          log.error("deferred task failed", err);
        }),
      ),
  };
}

/** Hono env for every route. */
export type AppEnv = { Bindings: Env; Variables: { ctx: Ctx } };

/** Hono env behind `auth()`: `c.var.authed` always exists. */
export type AuthedEnv = { Bindings: Env; Variables: { ctx: Ctx; authed: AuthedBatch } };
