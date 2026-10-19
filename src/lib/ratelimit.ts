/**
 * Rate limiting (DESIGN.md §7, spec/core.md §2.3).
 *
 * - Per-IP minute limits (slowapi in Python): the Workers Rate Limiting binding, keyed `${route}:${ip}`, so the
 *   limit is per endpoint per IP like slowapi's. No storage writes.
 * - Per-user buckets (`enforce()` in Python): a `rate_counters` row UPSERTed as the first statement of the guarded
 *   write batch. Every guarded write is predicated on `underLimit(...)`, so a rejected call commits only the counter
 *   (Python also counts rejected calls); the handler then turns `count > limit` into the 429.
 */
import { type SQL, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.ts";
import { rateCounters } from "../db/schema/index.ts";
import { loadConfig } from "../env.ts";
import { ipRateLimited, slowDown } from "./errors.ts";
import { clientIp } from "./http.ts";

/** Rate Limiting binding names declared in wrangler.jsonc, with the limit each enforces (for the 429 text). */
export const IP_LIMITS = {
  RL_SIGNUP: 5,
  RL_LOGIN: 10,
  RL_MFA: 10,
  RL_PWMAIL: 3,
  RL_30: 30,
} as const satisfies Partial<Record<keyof Env, number>>;
export type IpLimitBinding = keyof typeof IP_LIMITS;

/**
 * Per-IP per-minute limit for one route. `route` names the endpoint (slowapi keys per route function), so two
 * routes sharing a binding still get separate counters. A request with no client IP shares the `unknown` key.
 * Skipped when development sets `IP_LIMITS_OFF=1`, so the app's end-to-end suite can make an account per test;
 * the config gate refuses that flag in every other environment.
 */
export function ipRateLimit(binding: IpLimitBinding, route: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const cfg = loadConfig(c.env);
    if (cfg.ok && cfg.config.ipLimitsOff) return next();
    const ip = clientIp(c.req) ?? "unknown";
    const { success } = await c.env[binding].limit({ key: `${route}:${ip}` });
    if (!success) throw ipRateLimited(IP_LIMITS[binding]);
    await next();
  };
}

/** Per-user rate counter key, `limit:{bucket}:{subject}` as in Python. */
export const bucketKey = (bucket: string, subject: string) => `limit:${bucket}:${subject}`;

/** Start of the fixed window containing `now` (aligned to multiples of the window, like slowapi's limiter). */
export const windowStart = (now: number, windowSec: number) => now - (now % (windowSec * 1000));

/**
 * Statement 0 of a guarded batch: bumps the counter for the current window (resetting it when the window moved
 * on) and returns `[{ count }]`. Pass its result to `assertUnderLimit`.
 */
export function counterUpsert(db: Db, key: string, windowSec: number, now: number) {
  return db
    .insert(rateCounters)
    .values({ key, windowStart: windowStart(now, windowSec), count: 1 })
    .onConflictDoUpdate({
      target: rateCounters.key,
      set: {
        count: sql`CASE WHEN ${rateCounters.windowStart} = excluded.window_start THEN ${rateCounters.count} + 1 ELSE 1 END`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: rateCounters.count });
}

/** Predicate for every guarded write in the same batch: true while the counter is within the limit. */
export function underLimit(key: string, limit: number): SQL {
  return sql`(SELECT count FROM rate_counters WHERE key = ${key}) <= ${limit}`;
}

/** Throws the per-user 429 (`Slow down - try again in a little while.`) when the counter went over the limit. */
export function assertUnderLimit(rows: readonly { count: number }[], limit: number): void {
  const count = rows[0]?.count ?? 0;
  if (count > limit) throw slowDown();
}

/** A per-user bucket: name, limit and window, as in the spec/core.md §2.3 B table. */
export interface Bucket {
  readonly bucket: string;
  readonly limit: number;
  readonly windowSec: number;
}

/** The `enforce()` buckets (spec/core.md §2.3 B). `search` uses the RL_SEARCH binding instead. */
export const BUCKETS = {
  bodyPhoto: { bucket: "body-photo", limit: 60, windowSec: 3600 },
  workoutWrite: { bucket: "workout-write", limit: 240, windowSec: 3600 },
  importFile: { bucket: "import_file", limit: 30, windowSec: 3600 },
  pause: { bucket: "pause", limit: 20, windowSec: 86400 },
  buddyInvite: { bucket: "buddy-invite", limit: 10, windowSec: 86400 },
  encourage: { bucket: "encourage", limit: 20, windowSec: 86400 },
  groupCreate: { bucket: "group-create", limit: 5, windowSec: 3600 },
  groupJoin: { bucket: "group-join", limit: 20, windowSec: 3600 },
  challengeCreate: { bucket: "challenge-create", limit: 10, windowSec: 3600 },
  assignPlan: { bucket: "assign-plan", limit: 20, windowSec: 86400 },
  announce: { bucket: "announce", limit: 5, windowSec: 86400 },
  pushTest: { bucket: "push-test", limit: 5, windowSec: 600 },
  follow: { bucket: "follow", limit: 60, windowSec: 3600 },
  kudos: { bucket: "kudos", limit: 300, windowSec: 3600 },
  comment: { bucket: "comment", limit: 30, windowSec: 3600 },
  report: { bucket: "report", limit: 20, windowSec: 3600 },
  calendarRotate: { bucket: "calendar_rotate", limit: 10, windowSec: 3600 },
  export: { bucket: "export", limit: 20, windowSec: 3600 },
  import: { bucket: "import", limit: 5, windowSec: 3600 },
  importHabits: { bucket: "import_habits", limit: 20, windowSec: 3600 },
} as const satisfies Record<string, Bucket>;

export interface CounterPlan<S> {
  readonly key: string;
  /** Put first in the batch (after the session guard, which `AuthedBatch.write` adds). */
  readonly counter: S;
  /** AND this into the WHERE of every guarded write in the batch. */
  readonly allowed: SQL;
  /** Call with the counter's result after the batch; throws the per-user 429. */
  check(rows: readonly { count: number }[]): void;
}

function plan(db: Db, key: string, limit: number, windowSec: number, now: number) {
  return {
    key,
    counter: counterUpsert(db, key, windowSec, now),
    allowed: underLimit(key, limit),
    check: (rows: readonly { count: number }[]) => assertUnderLimit(rows, limit),
  } satisfies CounterPlan<ReturnType<typeof counterUpsert>>;
}

/** Everything a handler needs for one bucket and subject (usually the user id; `announce` uses the group id). */
export const perUser = (db: Db, b: Bucket, subject: string, now: number) =>
  plan(db, bucketKey(b.bucket, subject), b.limit, b.windowSec, now);

/** Calendar feed: 120 fetches per hour per token, keyed `cal:<token_hash>` (DESIGN.md §7). */
export const CALENDAR_FEED = { limit: 120, windowSec: 3600 } as const;

export const calendarFeedCounter = (db: Db, tokenHash: string, now: number) =>
  plan(db, `cal:${tokenHash}`, CALENDAR_FEED.limit, CALENDAR_FEED.windowSec, now);
