import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedHeavyUser } from "./fixtures/heavy-user.ts";
import { heavyUserData, insertStatements } from "./fixtures/heavy-user-data.ts";

describe("heavy-user seed generator", () => {
  it("is deterministic and has the documented default scale", () => {
    const a = heavyUserData({ userId: "00000000-0000-7000-8000-000000000001" });
    const b = heavyUserData({ userId: "00000000-0000-7000-8000-000000000001" });
    expect(a).toEqual(b);
    expect(a.workouts).toHaveLength(3000);
    expect(a.workout_sets.length).toBeGreaterThan(28_000);
    expect(a.habits).toHaveLength(20);
    expect(a.habit_logs).toHaveLength(2000);
    expect(new Set(a.workout_sets.map((s) => s.id)).size).toBe(a.workout_sets.length);
  });

  it("keeps every INSERT within D1's 100-parameter limit", () => {
    const d = heavyUserData({ userId: "u", workouts: 50 });
    for (const s of insertStatements("workout_sets", d.workout_sets))
      expect(s.params.length).toBeLessThanOrEqual(100);
  });

  it("seeds into D1 (reduced scale) honouring every constraint", async () => {
    const d = await seedHeavyUser({ workouts: 200, habitLogs: 300 });
    const row = await env.DB.prepare("SELECT count(*) AS n FROM workouts WHERE user_id = ?")
      .bind(d.users[0]?.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(200);
  });
});
