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

  // Measured 4.3 ms locally for the 5-year user; DESIGN §17's 5 ms is a Free-plan class target, so the
  // heaviest possible user gets 8 ms on Paid (OWNER-DECISIONS). Typical users are a fraction of this.
  benchCase("snapshot derivation (heavy user)", () => game.internal.snapshotOf(loaded), {
    budgetMs: 8,
    ops: 20,
    samples: 9,
  });
  benchCase(
    "snapshot read + derivation (heavy user, local D1 wall time)",
    async () => {
      game.internal.snapshotOf(await game.internal.load(jobCtx(), userId, []));
    },
    { budgetMs: 70, ops: 5, samples: 5 },
  );
  benchCase(
    "recompute without record keys (heavy user, local D1 wall time)",
    () => game.recompute(jobCtx(), userId, { notify: false }),
    { budgetMs: 80, ops: 3, samples: 5 },
  );
});
