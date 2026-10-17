import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { writeBatch } from "../../src/db/batch.ts";
import { HttpError, SLOW_DOWN } from "../../src/lib/errors.ts";
import {
  BUCKETS,
  bucketKey,
  CALENDAR_FEED,
  calendarFeedCounter,
  ipRateLimit,
  perUser,
  windowStart,
} from "../../src/lib/ratelimit.ts";
import { T0 } from "../fixtures/clock.ts";
import { type TestDb, testDb } from "../fixtures/db.ts";

let t: TestDb;
beforeEach(() => {
  t = testDb();
});

let n = 0;
const subject = () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}-${Math.random()}`;

/** A guarded write: bumps a probe row only while the bucket allows it. */
const probeWrite = (probe: string, allowed: ReturnType<typeof sql>) =>
  t.db.run(sql`INSERT INTO rate_counters (key, window_start, count) SELECT ${probe}, 0, 1 WHERE ${allowed}
    ON CONFLICT (key) DO UPDATE SET count = count + 1`);

async function count(key: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT count FROM rate_counters WHERE key = ?")
    .bind(key)
    .first<{ count: number }>();
  return row?.count;
}

describe("per-user buckets", () => {
  it("keys like Python and aligns windows", () => {
    expect(bucketKey("follow", "u1")).toBe("limit:follow:u1");
    expect(windowStart(3_600_000 * 5 + 1234, 3600)).toBe(3_600_000 * 5);
  });

  it("allows up to the limit, then 429s while committing only the counter", async () => {
    const s = subject();
    const probe = `probe:${s}`;
    const b = BUCKETS.groupCreate; // 5 per hour
    for (let i = 1; i <= b.limit + 2; i++) {
      const p = perUser(t.db, b, s, T0);
      const [rows] = await writeBatch(t.db, [p.counter, probeWrite(probe, p.allowed)]);
      if (i <= b.limit) {
        expect(() => p.check(rows)).not.toThrow();
      } else {
        let err: unknown;
        try {
          p.check(rows);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(429);
        expect((err as HttpError).body).toEqual({ detail: SLOW_DOWN });
      }
    }
    expect(await count(bucketKey(b.bucket, s))).toBe(b.limit + 2); // rejected calls count, like Python
    expect(await count(probe)).toBe(b.limit); // but their guarded writes did nothing
  });

  it("resets in the next window", async () => {
    const s = subject();
    const b = BUCKETS.pushTest; // 5 per 600 s
    for (let i = 0; i < 6; i++) await writeBatch(t.db, [perUser(t.db, b, s, T0).counter]);
    const p = perUser(t.db, b, s, T0 + 600_000);
    const [rows] = await writeBatch(t.db, [p.counter]);
    expect(rows).toEqual([{ count: 1 }]);
    expect(() => p.check(rows)).not.toThrow();
  });

  it("calendar feed allows 120 per hour per token", async () => {
    const hash = `h${subject()}`;
    let last: { count: number }[] = [];
    for (let i = 0; i < CALENDAR_FEED.limit; i++) {
      const c = calendarFeedCounter(t.db, hash, T0);
      [last] = await writeBatch(t.db, [c.counter]);
      c.check(last);
    }
    const c = calendarFeedCounter(t.db, hash, T0);
    expect(c.key).toBe(`cal:${hash}`);
    [last] = await writeBatch(t.db, [c.counter]);
    expect(() => c.check(last)).toThrow(SLOW_DOWN);
  });
});

describe("ipRateLimit (Rate Limiting binding)", () => {
  function fakeBinding(limit: number) {
    const seen = new Map<string, number>();
    const keys: string[] = [];
    const binding = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        const c = (seen.get(key) ?? 0) + 1;
        seen.set(key, c);
        return { success: c <= limit };
      },
    } as RateLimit;
    return { binding, keys };
  }

  it("returns slowapi's 429 body with Retry-After, keyed per route and IP", async () => {
    const { binding, keys } = fakeBinding(10);
    const app = createApp((a) => {
      a.post("/v1/auth/login", ipRateLimit("RL_LOGIN", "login"), (c) => c.json({ ok: true }));
    });
    const call = (ip: string) =>
      app.fetch(
        new Request("http://x/v1/auth/login", { method: "POST", headers: { "CF-Connecting-IP": ip } }),
        { ...env, RL_LOGIN: binding },
        { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
      );
    for (let i = 0; i < 10; i++) expect((await call("1.2.3.4")).status).toBe(200);
    const res = await call("1.2.3.4");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "Rate limit exceeded: 10 per 1 minute" });
    expect((await call("5.6.7.8")).status).toBe(200);
    expect(keys[0]).toBe("login:1.2.3.4");
  });
});
