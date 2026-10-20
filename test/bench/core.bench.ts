/**
 * Foundation benches. Later units add PBKDF2 (G-1 is measured on staging), recompute delta, snapshot on the heavy
 * user, a 256 KiB import slice and push encryption, each with its DESIGN.md §17 budget.
 */
import { beforeAll, describe } from "vitest";
import type { AuthedBatch } from "../../src/db/batch.ts";
import { hashPassword, verifyPassword } from "../../src/lib/crypto/pbkdf2.ts";
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

/**
 * PBKDF2-SHA256 at 100,000 iterations (OWNER-DECISIONS; never lowered). WebCrypto runs it natively, but it is CPU the
 * isolate spends synchronously on the request's thread, so it counts toward the Workers CPU limit (10 ms on Free):
 * this wall time on the local workerd is its CPU cost. Staging `wrangler tail` cpuTime on /v1/auth/login is the
 * real gate (CUTOVER.md G-1).
 */
describe("crypto", () => {
  const pepper = new Uint8Array(32).fill(7);
  let stored = "";
  beforeAll(async () => {
    stored = await hashPassword("correct horse battery staple", pepper);
  });
  benchCase(
    "PBKDF2-SHA256 100k verify",
    () => verifyPassword(stored, "correct horse battery staple", pepper),
    {
      budgetMs: 100,
      ops: 3,
      samples: 7,
    },
  );
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
