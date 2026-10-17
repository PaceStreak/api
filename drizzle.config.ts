import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from the schema. Migrations are applied with
// `wrangler d1 migrations apply`, never by drizzle-kit, so no credentials are needed.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
