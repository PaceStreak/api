/**
 * Worker entry: HTTP (`fetch`), Cron Triggers (`scheduled`) and the jobs queue (`queue`).
 * Jobs and consumers are registered into `jobs` (jobs/scheduled.ts) and `consumers` (jobs/consumer.ts).
 */
import { createApp } from "./app.ts";
import { handleQueue } from "./jobs/consumer.ts";
import { handleScheduled } from "./jobs/scheduled.ts";
import { mountRoutes } from "./routes.ts";

const app = createApp(mountRoutes);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, exec) {
    await handleScheduled(controller, env, exec);
  },
  async queue(batch, env, exec) {
    await handleQueue(batch, env, exec);
  },
} satisfies ExportedHandler<Env>;
