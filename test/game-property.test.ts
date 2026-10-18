/**
 * Property: aggregates and the records projection kept incrementally (scoped refresh + scoped recompute after
 * every write) equal a full rebuild from source rows, for random sequences of workout adds and deletes.
 */
import { env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as game from "../src/modules/game/service.ts";
import { deleteWorkout, person, putWorkout, type SetIn } from "./fixtures/game.ts";
import { jobCtx } from "./jobs/helpers.ts";

const EXERCISES = ["back-squat", "bench-press", "push-up", "plank", "custom-gone"];
const DISCIPLINES = ["strength", "run", "ride", "yoga"];

const setArb: fc.Arbitrary<SetIn> = fc.record({
  exercise_id: fc.constantFrom(...EXERCISES),
  weight_kg: fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
  reps: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
  rpe: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
  duration_sec: fc.option(fc.integer({ min: 0, max: 300 }), { nil: null }),
  kind: fc.constantFrom("work", "warmup", "drop") as fc.Arbitrary<"work" | "warmup" | "drop">,
});

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("add" as const),
    daysAgo: fc.integer({ min: 0, max: 60 }),
    discipline: fc.constantFrom(...DISCIPLINES),
    distanceM: fc.option(fc.integer({ min: 1000, max: 45000 }), { nil: null }),
    durationSec: fc.option(fc.integer({ min: 0, max: 14000 }), { nil: null }),
    source: fc.constantFrom("app", "import") as fc.Arbitrary<"app" | "import">,
    sets: fc.array(setArb, { maxLength: 5 }),
  }),
  fc.record({ kind: fc.constant("delete" as const), pick: fc.nat() }),
);

async function dump(userId: string) {
  const q = (sql: string) =>
    env.DB.prepare(sql)
      .bind(userId)
      .all()
      .then((r) => r.results);
  return {
    days: await q("SELECT * FROM stat_days WHERE user_id = ? ORDER BY local_date"),
    exercises: await q("SELECT * FROM stat_exercises WHERE user_id = ? ORDER BY exercise_id"),
    recordDays: await q("SELECT * FROM record_days WHERE user_id = ? ORDER BY key, local_date"),
    records:
      await q(`SELECT key, value, previous, gain_pct, achieved_on, workout_id, flagged, rewarded, is_current
      FROM personal_records WHERE user_id = ? ORDER BY key, achieved_on, is_current`),
    stats: await q(`SELECT total_xp, level, current_streak, longest_streak, season_prs, total_prs, sessions,
      active_days, recent_weeks FROM user_stats WHERE user_id = ?`),
  };
}

describe("incremental aggregates", () => {
  it("equal a full rebuild for random write sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 6 }), async (ops) => {
        const me = await person();
        await game.recompute(jobCtx(), me.userId, { notify: false });
        const live: { id: string; localDate: string; exercises: string[]; discipline: string }[] = [];
        const now = Date.now();
        for (const op of ops) {
          if (op.kind === "add") {
            const w = await putWorkout(me.userId, {
              startedAt: now - op.daysAgo * 86_400_000 - 3_600_000,
              discipline: op.discipline,
              distanceM: op.distanceM,
              durationSec: op.durationSec,
              source: op.source,
              sets: op.sets,
            });
            live.push({
              id: w.id,
              localDate: w.localDate,
              exercises: [...new Set(op.sets.map((s) => s.exercise_id))],
              discipline: op.discipline,
            });
          } else if (live.length > 0) {
            const [w] = live.splice(op.pick % live.length, 1);
            if (w) await deleteWorkout(me.userId, w.id, w.localDate, w.exercises, w.discipline);
          }
        }
        const incremental = await dump(me.userId);
        await game.rebuild(jobCtx(), me.userId);
        expect(await dump(me.userId)).toEqual(incremental);
      }),
      { numRuns: 12 },
    );
  }, 120_000);
});
