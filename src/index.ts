/**
 * Worker entry: HTTP (`fetch`), Cron Triggers (`scheduled`) and the jobs queue (`queue`).
 * Jobs and consumers are registered into `jobs` (jobs/scheduled.ts) and `consumers` (jobs/consumer.ts).
 */
import { createApp } from "./app.ts";
import { consumers, handleQueue } from "./jobs/consumer.ts";
import { handleScheduled, jobs } from "./jobs/scheduled.ts";
import { registerConsumers as registerJobConsumers, registerJobs } from "./jobs/tasks/index.ts";
import { registerConsumers as registerAccountConsumers } from "./modules/account/service.ts";
import { registerConsumers as registerGameConsumers } from "./modules/game/service.ts";
import { registerConsumers as registerNotificationConsumers } from "./modules/notifications/service.ts";
import { mountRoutes } from "./routes.ts";

registerNotificationConsumers(consumers);
registerGameConsumers(consumers);
registerAccountConsumers(consumers);
registerJobConsumers(consumers);
registerJobs(jobs);
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
