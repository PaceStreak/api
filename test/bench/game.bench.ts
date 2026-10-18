/**
 * Game engine CPU on the heavy user (5 years, 3,000 workouts, ~30,000 sets): the pure snapshot derivation from
 * already-read aggregates (DESIGN.md §17 "Snapshot read": 5 ms), and the whole read including the local D1 trip.
 */
import { beforeAll, describe } from "vitest";
import * as game from "../../src/modules/game/service.ts";
import { seedHeavyUser } from "../fixtures/heavy-user.ts";
import { jobCtx } from "../jobs/helpers.ts";
import { benchCase } from "./harness.ts";

describe("game", () => {
  let userId = "";
  let loaded: Awaited<ReturnType<typeof game.internal.load>>;
  beforeAll(async () => {
    const data = await seedHeavyUser();
    userId = data.users[0]?.id as string;
    await game.rebuild(jobCtx(), userId);
    loaded = await game.internal.load(jobCtx(), userId, []);
  }, 120_000);

  // Measured 4.3 ms before the heavy user's 20 habits (five of them five-year quit habits, ~9,000 clean days)
  // joined the snapshot; 13.5 ms with them after the CONTRACT unit's memoised day conversions in the habit engine
  // (45 ms before). DESIGN §17's 5 ms is a Free-plan class target for a typical user; this is the heaviest
  // possible account on Paid (OWNER-DECISIONS).
  benchCase("snapshot derivation (heavy user)", () => game.internal.snapshotOf(loaded), {
    budgetMs: 30,
    ops: 20,
    samples: 9,
  });
  benchCase(
    "snapshot read + derivation (heavy user, local D1 wall time)",
    async () => {
      game.internal.snapshotOf(await game.internal.load(jobCtx(), userId, []));
    },
    { budgetMs: 120, ops: 5, samples: 5 },
  );
  benchCase(
    "recompute without record keys (heavy user, local D1 wall time)",
    () => game.recompute(jobCtx(), userId, { notify: false }),
    { budgetMs: 120, ops: 3, samples: 5 },
  );
});
