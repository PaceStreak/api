/**
 * The twelve worker jobs of spec/misc.md §4 (plus the outbox retry sweep), plugged into the cron router and the
 * queue consumer. Per-user jobs dispatch `job-slice` messages; global jobs run inline in the tick.
 */
import type { Ctx } from "../../ctx.ts";
import { retryUndelivered } from "../../modules/notifications/service.ts";
import type { ConsumerRegistry } from "../consumer.ts";
import { chunk, dispatchDeliver, dispatchJobSlices, dispatchPurge, IDS_PER_MESSAGE } from "../dispatch.ts";
import type { JobName, JobRegistry, Tick } from "../scheduled.ts";
import { buddyNudges } from "./buddies.ts";
import type { SlicedJob } from "./common.ts";
import { monthlyBackup, weeklyDigest } from "./digest.ts";
import { habitReminders, habitSnoozes, habitSummary } from "./habits.ts";
import { duePurgeIds, errorAlerts, housekeeping, purgeAccounts, resolveChallenges } from "./maintenance.ts";
import { nudges } from "./nudges.ts";
import { stats } from "./stats.ts";

/** Jobs whose work is fanned out per id through `job-slice` messages. */
export const SLICED: Partial<Record<JobName, SlicedJob>> = {
  stats,
  nudges,
  habits: habitReminders,
  habit_snoozes: habitSnoozes,
  habit_summary: habitSummary,
  digest: weeklyDigest,
  backup: monthlyBackup,
  buddies: buddyNudges,
};

export function registerJobs(registry: JobRegistry): void {
  for (const [name, job] of Object.entries(SLICED) as [JobName, SlicedJob][]) {
    // The report counts the ids dispatched; the slices' notifications are delivered by the consumer.
    registry.register(name, async (ctx, tick) => {
      const ids = await job.select(ctx, tick);
      await dispatchJobSlices(tick.queue, name, ids);
      return ids.length;
    });
  }
  registry.register("challenges", (ctx) => resolveChallenges(ctx));
  registry.register("purge", async (ctx, tick) => {
    const ids = await duePurgeIds(ctx, tick.now);
    await dispatchPurge(tick.queue, ids);
    return ids.length;
  });
  registry.register("housekeeping", (ctx) => housekeeping(ctx));
  registry.register("error_alerts", (ctx) => errorAlerts(ctx));
  registry.register("delivery_retry", (ctx) => retryUndelivered(ctx));
}

export function registerConsumers(registry: ConsumerRegistry): void {
  registry.register("job-slice", async (ctx, msg) => {
    const job = SLICED[msg.job];
    if (job === undefined) {
      ctx.log.warn("job-slice for a job that does not slice", { job: msg.job });
      return;
    }
    await dispatchDeliver(ctx.env.JOBS, await job.slice(ctx, msg.ids));
  });
  registry.register("purge", async (ctx, msg) => {
    await purgeAccounts(ctx, msg.userIds);
  });
}

/**
 * Runs one sliced job start to finish in-process (select, then every slice) and returns the notification ids it
 * inserted, undelivered: what Python's job functions returned. For tests and local runs.
 */
export async function runSliced(ctx: Ctx, name: JobName, tick?: Partial<Tick>): Promise<string[]> {
  const job = SLICED[name];
  if (job === undefined) throw new Error(`${name} is not a sliced job`);
  const now = ctx.clock.now();
  const full: Tick = {
    trigger: "quarter",
    cron: "",
    scheduledTime: now,
    now,
    queue: { sendBatch: async () => undefined },
    ...tick,
  };
  const ids = await job.select(ctx, full);
  const out: string[] = [];
  for (const part of chunk(ids, IDS_PER_MESSAGE)) out.push(...(await job.slice(ctx, part)));
  return out;
}
