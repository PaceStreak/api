/**
 * Route mounting, in the Python router's order (spec/core.md §0): Hono matches in registration order too.
 * Each module exports a Hono sub-app from its routes.ts; add it here.
 */
import type { App } from "./app.ts";
import { accountRoutes, calendarFeedRoutes } from "./modules/account/routes.ts";
import { adminRoutes } from "./modules/admin/routes.ts";
import { authRoutes, passkeyRoutes } from "./modules/auth/routes.ts";
import { gameRoutes, leaderboardRoutes } from "./modules/game/routes.ts";
import { groupRoutes } from "./modules/groups/routes.ts";
import { habitRoutes, habitRoutineRoutes } from "./modules/habits/routes.ts";
import { insightRoutes } from "./modules/insights/routes.ts";
import { notificationRoutes } from "./modules/notifications/routes.ts";
import { coachRoutes, nutritionRoutes } from "./modules/nutrition/routes.ts";
import { healthRoutes, opsRoutes } from "./modules/ops/routes.ts";
import { handleRoutes, profileRoutes } from "./modules/profile/routes.ts";
import { searchRoutes } from "./modules/search/routes.ts";
import { buddyRoutes, socialRoutes } from "./modules/social/routes.ts";
import {
  gearRoutes,
  meRoutes,
  personalRoutes,
  photoRoutes,
  planRoutes,
  trainingRoutes,
} from "./modules/training/routes.ts";
import { trashRoutes } from "./modules/trash/routes.ts";

export function mountRoutes(app: App): void {
  // Health lives outside /v1 and carries no PaceStreak-Version header.
  app.route("/health", healthRoutes);
  app.route("/v1/auth/passkeys", passkeyRoutes);
  app.route("/v1/auth", authRoutes);
  app.route("/v1/me", profileRoutes);
  app.route("/v1/handles", handleRoutes);
  app.route("/v1/me", gameRoutes);
  app.route("/v1/me", accountRoutes);
  app.route("/v1/calendar", calendarFeedRoutes);
  app.route("/v1/habits", habitRoutes);
  app.route("/v1/habit-routines", habitRoutineRoutes);
  app.route("/v1", insightRoutes);
  app.route("/v1", trainingRoutes);
  app.route("/v1/gear", gearRoutes);
  app.route("/v1", personalRoutes);
  app.route("/v1/body-photos", photoRoutes);
  app.route("/v1/me", meRoutes);
  app.route("/v1/plans", planRoutes);
  app.route("/v1/nutrition", nutritionRoutes);
  app.route("/v1/coach", coachRoutes);
  app.route("/v1", socialRoutes);
  app.route("/v1", buddyRoutes);
  app.route("/v1", groupRoutes);
  // ... modules 16-20 mount here, in spec/core.md §0 order ...
  app.route("/v1/leaderboards", leaderboardRoutes);
  app.route("/v1/notifications", notificationRoutes);
  app.route("/v1", searchRoutes);
  app.route("/v1/trash", trashRoutes);
  // ... modules 23-24 mount here ...
  app.route("/v1/admin", adminRoutes);
  app.route("/v1", opsRoutes);
}
