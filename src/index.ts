/**
 * Worker entry: HTTP (`fetch`), Cron Triggers (`scheduled`) and the jobs queue (`queue`).
 * The P1-JOBS unit fills in `scheduled` and `queue`.
 */
import { createApp } from "./app.ts";
import { createLogger } from "./lib/logger.ts";
import { mountRoutes } from "./routes.ts";

const app = createApp(mountRoutes);

export default {
  fetch: app.fetch,
  async scheduled(controller) {
    createLogger().info("cron tick (no jobs yet)", { cron: controller.cron });
  },
  async queue(batch) {
    createLogger().warn("queue batch dropped: no consumer yet", {
      queue: batch.queue,
      size: batch.messages.length,
    });
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;
