/**
 * Runs before every test file (one isolated D1 per file): migrations, the outbound-fetch guard and clock reset.
 * Test files share their database between tests, so tests create their own users (fixtures make unique emails).
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach } from "vitest";
import { useSystemClock } from "./fixtures/clock.ts";
import { installFetchGuard, resetFetchMocks } from "./fixtures/fetch.ts";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
installFetchGuard();

afterEach(() => {
  resetFetchMocks();
  useSystemClock();
});
