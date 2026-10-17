/**
 * Route mounting, in the Python router's order (spec/core.md §0): Hono matches in registration order too.
 * Each module exports a Hono sub-app from its routes.ts; add it here.
 */
import type { App } from "./app.ts";

export function mountRoutes(app: App): void {
  // Health lives outside /v1 and carries no PaceStreak-Version header. The OPS-ADMIN unit replaces this with
  // the full /health, /health/ready and /health/worker routes.
  app.get("/health", (c) => c.json({ status: "healthy" }));
}
