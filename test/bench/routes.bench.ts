/**
 * Whole-request benches on the heavy user (5 years, 3,000 workouts, ~30,000 sets, 20 habits, 2,000 logs) through the
 * real Worker: routing, auth, the local D1 trip, derivation and JSON. These are wall times in local workerd, so
 * they bound CPU from above (the D1 trip is in-process SQLite here); staging `wrangler tail` cpuTime is the real
 * gate (DESIGN.md §15). Budgets are per route class from DESIGN.md §17, scaled for the heaviest possible account
 * and for the local D1 work that a remote D1 does off the Worker's CPU.
 */
import { beforeAll, describe, expect } from "vitest";
import { type HeavyUser, heavyUser } from "../contract/heavy.ts";
import { api } from "../fixtures/http.ts";
import { benchCase } from "./harness.ts";

const today = () => new Date().toISOString().slice(0, 10);

describe("routes on the heavy user", () => {
  let h: HeavyUser;
  beforeAll(async () => {
    h = await heavyUser();
  }, 120_000);

  const read = (path: () => string) => async () => {
    const res = await api(path(), { token: h.token });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  };
  const opts = (budgetMs: number) => ({ budgetMs, ops: 5, samples: 7 });

  // Auth-gated reads (§17: 3 ms CPU on a typical account). /habits measured ~32 ms wall: ~18 ms local D1 read of
  // 2,000 logs, ~10 ms deriving 20 five-year chains.
  benchCase(
    "GET /me",
    read(() => "/v1/me"),
    opts(15),
  );
  benchCase(
    "GET /habits (20 habits, 2,000 logs)",
    read(() => "/v1/habits"),
    opts(60),
  );
  benchCase(
    "GET /habits/{id}",
    read(() => `/v1/habits/${h.habitId}`),
    opts(60),
  );
  // The default page is 200 workouts with ~2,000 sets: the local D1 read and row mapping dominate.
  benchCase(
    "GET /workouts/changes (200 workouts)",
    read(() => "/v1/workouts/changes?since=0"),
    opts(130),
  );
  benchCase(
    "GET /day/{today}",
    read(() => `/v1/day/${today()}`),
    opts(15),
  );
  benchCase(
    "GET /journal",
    read(() => "/v1/journal"),
    opts(15),
  );
  benchCase(
    "GET /insights",
    read(() => "/v1/insights"),
    opts(40),
  );
  // Snapshot reads (§17: 5 ms on a typical account). Measured ~65 ms wall here, of which ~13 ms is derivation
  // (game.bench.ts) and the rest the local D1 read of five years of aggregates.
  benchCase(
    "GET /me/stats",
    read(() => "/v1/me/stats"),
    opts(130),
  );
  benchCase(
    "GET /me/achievements",
    read(() => "/v1/me/achievements"),
    opts(130),
  );
  benchCase(
    "GET /coach/today",
    read(() => "/v1/coach/today"),
    opts(130),
  );
  // Search (§17: 2 ms).
  benchCase(
    "GET /search",
    read(() => "/v1/search?q=run"),
    opts(20),
  );
  // Static data, no D1.
  benchCase(
    "GET /library",
    read(() => "/v1/library"),
    opts(10),
  );
});
