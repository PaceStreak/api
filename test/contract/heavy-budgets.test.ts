/**
 * Round-trip budgets (DESIGN.md §17) on the seeded heavy user, through the real Worker: every golden read the
 * heavy account can answer, plus the writes the app makes most. The `X-D1-Round-Trips` header is the counting D1
 * wrapper's total for the request, so an N+1 on a large account fails here by construction.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../fixtures/http.ts";
import { type HeavyUser, heavyUser } from "./heavy.ts";

const today = () => new Date().toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

/** Reads and their budgets: 1 for an auth-gated read, 0 for static data, 2 where the change log says so. */
const READS: [string, number][] = [
  ["/v1/me", 1],
  ["/v1/me/stats", 1],
  ["/v1/library", 0],
  ["/v1/habits/catalog", 0],
  ["/v1/plans/templates", 0],
  ["/v1/exercises/custom", 1],
  ["/v1/workouts/changes?since=0", 1],
  ["/v1/chains", 1],
  ["/v1/pauses", 1],
  ["/v1/me/achievements", 1],
  ["/v1/me/records", 1],
  ["/v1/me/xp", 1],
  ["/v1/me/progress", 1],
  ["/v1/me/review", 1],
  // Without `month` the default needs the local date first (CHANGES-FROM-PYTHON: Game).
  ["/v1/me/recap/month", 2],
  ["/v1/habits", 1],
  ["/v1/habits/:habit", 1],
  ["/v1/habits/:habit/stats", 1],
  ["/v1/habit-routines", 1],
  ["/v1/gyms", 1],
  ["/v1/gear", 1],
  ["/v1/routines", 1],
  ["/v1/plans", 1],
  ["/v1/weigh-ins", 1],
  ["/v1/body-metrics", 1],
  ["/v1/weight-goal", 1],
  ["/v1/readiness", 1],
  ["/v1/reflections", 1],
  ["/v1/nutrition/days/:today", 1],
  ["/v1/nutrition/foods", 1],
  ["/v1/nutrition/recipes", 1],
  ["/v1/nutrition/recent", 1],
  ["/v1/nutrition/history?days=30", 1],
  ["/v1/nutrition/expenditure", 1],
  ["/v1/coach/today", 1],
  ["/v1/journal", 1],
  ["/v1/insights", 1],
  ["/v1/search?q=run", 1],
  ["/v1/day/:today", 1],
  ["/v1/notifications", 1],
  ["/v1/notifications/unread-count", 1],
  ["/v1/feed", 1],
  ["/v1/groups", 1],
  ["/v1/challenges", 1],
  ["/v1/trash", 1],
  ["/v1/me/rest-days", 1],
  ["/v1/exercises/back-squat/history", 1],
];

describe("round-trip budgets on the heavy user", () => {
  let h: HeavyUser;
  beforeAll(async () => {
    h = await heavyUser();
  }, 120_000);

  it.each(READS)("GET %s stays within %i round trip(s)", async (raw, budget) => {
    const path = raw.replace(":habit", h.habitId).replace(":today", today());
    const res = await api(path, { token: h.token });
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
    expect(Number(res.headers.get("X-D1-Round-Trips")), path).toBeLessThanOrEqual(budget);
  });

  it("the writes the app makes most stay within their budgets", async () => {
    const trips = async (path: string, method: string, json: unknown, want = 200) => {
      const res = await api(path, { method, json, token: h.token });
      expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(want);
      return Number(res.headers.get("X-D1-Round-Trips"));
    };
    const workout = {
      discipline: "run",
      started_at: iso(Date.now() - 3_600_000),
      client_updated_at: iso(Date.now()),
      duration_sec: 1800,
      distance_m: 5000,
    };
    // Workout write + outcome: read; write + aggregates + the recompute's reads; the recompute's write.
    expect(await trips(`/v1/workouts/${crypto.randomUUID()}`, "PUT", workout)).toBeLessThanOrEqual(3);
    const ops = Array.from({ length: 50 }, () => ({
      op: "put",
      id: crypto.randomUUID(),
      client_updated_at: iso(Date.now()),
      workout,
    }));
    expect(await trips("/v1/workouts/batch", "POST", { ops })).toBeLessThanOrEqual(3);
    // Habit day: the recompute's read, then one write.
    expect(await trips(`/v1/habits/${h.habitId}/days/${today()}`, "PUT", { amount: 1 })).toBeLessThanOrEqual(
      2,
    );
    expect(await trips(`/v1/journal/${today()}`, "PUT", { mood: 3, note: "ok" })).toBeLessThanOrEqual(2);
    expect(
      await trips(`/v1/nutrition/entries/${crypto.randomUUID()}`, "PUT", {
        date: today(),
        meal: "lunch",
        name: "Soup",
        kcal: 300,
      }),
    ).toBeLessThanOrEqual(2);
  }, 60_000);
});
