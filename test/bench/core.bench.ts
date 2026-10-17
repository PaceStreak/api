/**
 * Foundation benches. Later units add PBKDF2 (G-1 is measured on staging), recompute delta, snapshot on the heavy
 * user, a 256 KiB import slice and push encryption, each with its DESIGN.md §17 budget.
 */
import { beforeAll, describe } from "vitest";
import type { AuthedBatch } from "../../src/db/batch.ts";
import { fold } from "../../src/lib/fold.ts";
import { formatG, pyRound } from "../../src/lib/format.ts";
import { localParts } from "../../src/lib/time.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { authedBatch, seedUser, testDb } from "../fixtures/db.ts";
import { benchCase } from "./harness.ts";

describe("lib", () => {
  benchCase("fold", () => fold("Ärger Café Ünïcode Name"), { budgetMs: 0.05 });
  benchCase(
    "pyRound + formatG",
    () => {
      pyRound(12.345678, 2);
      formatG(0.000123456);
    },
    { budgetMs: 0.05 },
  );
  benchCase("uuid7", () => uuid7(), { budgetMs: 0.02 });
  benchCase("localParts (memoised zone)", () => localParts(1_760_000_000_000, "Asia/Kolkata"), {
    budgetMs: 0.05,
  });
});

describe("db", () => {
  let batch: AuthedBatch;
  beforeAll(async () => {
    const t = testDb();
    batch = authedBatch(t.db, await seedUser(t.db));
  });
  // Wall time of a local D1 round trip, an upper bound on the CPU the auth read adds to a request.
  benchCase("AuthedBatch.read (auth row only)", () => batch.read(), { budgetMs: 3, ops: 50, samples: 9 });
});
