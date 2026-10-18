/**
 * Port of tests/test_training.py. The GAME unit ports the recompute concurrency case; TRAINING ports the rest.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { userStats } from "../../src/db/schema/index.ts";
import { recompute } from "../../src/modules/game/service.ts";
import { testDb } from "../fixtures/db.ts";
import { person, putWorkout } from "../fixtures/game.ts";
import { jobCtx } from "../jobs/helpers.ts";

describe("test_training", () => {
  it("recompute_is_serialized_across_concurrent_calls", async () => {
    const me = await person();
    await putWorkout(me.userId);
    await Promise.all([
      recompute(jobCtx(), me.userId, { notify: false }),
      recompute(jobCtx(), me.userId, { notify: false }),
    ]);
    const rows = await testDb().db.select().from(userStats).where(eq(userStats.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessions).toBe(1);
    expect(rows[0]?.currentStreak).toBe(0);
  });
});
