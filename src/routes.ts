/**
 * Route mounting, in the Python router's order (spec/core.md §0): Hono matches in registration order too.
 * Each module exports a Hono sub-app from its routes.ts; add it here.
 */
import type { App } from "./app.ts";
import { adminRoutes } from "./modules/admin/routes.ts";
import { authRoutes, passkeyRoutes } from "./modules/auth/routes.ts";
import { gameRoutes, leaderboardRoutes } from "./modules/game/routes.ts";
import { notificationRoutes } from "./modules/notifications/routes.ts";
import { healthRoutes, opsRoutes } from "./modules/ops/routes.ts";

export function mountRoutes(app: App): void {
  // Health lives outside /v1 and carries no PaceStreak-Version header.
  app.route("/health", healthRoutes);
  app.route("/v1/auth/passkeys", passkeyRoutes);
  app.route("/v1/auth", authRoutes);
  // 3 profile (PROFILE-ACCOUNT) mounts here.
  app.route("/v1/me", gameRoutes);
  // ... modules 5-20 mount here, in spec/core.md §0 order ...
  app.route("/v1/leaderboards", leaderboardRoutes);
  app.route("/v1/notifications", notificationRoutes);
  // ... modules 23-24 mount here ...
  app.route("/v1/admin", adminRoutes);
  app.route("/v1", opsRoutes);
}
