import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

// Tests get their bindings only from this file: never from a developer's .env or .dev.vars.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "false";

// Fixed, obviously fake secrets: tests must never depend on real credentials.
const TEST_KEY = btoa("not-a-secret-test-key-32-bytes!!"); // 32 bytes, base64

// A VAPID key pair made fresh for each run (never committed), so push routes run as configured.
const vapid = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const b64url = (s: string | undefined) => Buffer.from(s ?? "", "base64url");
const VAPID_PUBLIC_KEY = Buffer.concat([Buffer.of(4), b64url(vapid.x), b64url(vapid.y)]).toString(
  "base64url",
);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            MAILER: "console",
            COOKIE_DOMAIN: "",
            CORS_ORIGINS: "http://localhost:5173,https://app.pacestreak.com",
            FRONTEND_URL: "http://localhost:5173",
            PUBLIC_API_URL: "http://localhost:8787",
            JWT_KEYS: JSON.stringify({ current: "t1", keys: { t1: TEST_KEY } }),
            PEPPER: TEST_KEY,
            DATA_KEY: TEST_KEY,
            VAPID_PRIVATE_JWK: JSON.stringify(vapid),
            VAPID_PUBLIC_KEY,
            TURNSTILE_SECRET_KEY: "",
            R2_ACCESS_KEY_ID: "test-access-key",
            R2_SECRET_ACCESS_KEY: "test-secret-key",
          },
        },
      }),
    ],
    test: {
      // `pnpm bench` (BENCH=1) runs only the CPU benches; `pnpm vitest run` never does.
      include:
        process.env.BENCH === "1" ? ["test/bench/**/*.bench.ts"] : ["src/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // Route tests sign people up (PBKDF2) and run in parallel workerd isolates; 5 s flakes under full load.
      testTimeout: 20_000,
    },
  };
});
