/**
 * Cron router (DESIGN.md §9 "Cron mapping"). Three triggers, each guarded by its own D1 lease, run their job slots
 * in the fixed order of spec/misc.md §4. A job is a registered handler (the JOBS-12 unit fills the slots); a slot
 * with no handler is skipped and left out of the report. Each job runs in its own try/catch so one failure cannot
 * starve the rest, and the tick ends with the `scheduler` heartbeat (not when the lease was not acquired).
 */
import { type Ctx, createCtx, type Deferrer } from "../ctx.ts";
import { loadConfig } from "../env.ts";
import { createLogger } from "../lib/logger.ts";
import { dispatchDeliver, type JobQueue } from "./dispatch.ts";
import { type JobReport, recordHeartbeat } from "./heartbeat.ts";
import { acquireLease, releaseLease } from "./leases.ts";

/** Cron expressions, exactly as in wrangler.jsonc `triggers.crons`. */
export const CRONS = {
  frequent: "*/5 * * * *",
  quarter: "2,17,32,47 * * * *",
  daily: "23 3 * * *",
} as const;

export type Trigger = keyof typeof CRONS;

/** The twelve jobs of spec/misc.md §4 plus the outbox retry sweep, in run order. */
export const JOB_NAMES = [
  "stats",
  "nudges",
  "habits",
  "habit_snoozes",
  "habit_summary",
  "digest",
  "challenges",
  "backup",
  "buddies",
  "purge",
  "housekeeping",
  "error_alerts",
  "delivery_retry",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobSlot {
  trigger: Trigger;
  /** Runs only on the tick at minute 2 of each hour (hourly jobs on the 15-minute trigger). */
  hourly?: true;
}

export const JOB_SLOTS: Readonly<Record<JobName, JobSlot>> = {
  stats: { trigger: "quarter", hourly: true },
  nudges: { trigger: "quarter" },
  habits: { trigger: "quarter" },
  habit_snoozes: { trigger: "frequent" },
  habit_summary: { trigger: "quarter" },
  digest: { trigger: "quarter" },
  challenges: { trigger: "quarter", hourly: true },
  backup: { trigger: "quarter" },
  buddies: { trigger: "quarter" },
  purge: { trigger: "daily" },
  housekeeping: { trigger: "daily" },
  error_alerts: { trigger: "quarter", hourly: true },
  delivery_retry: { trigger: "frequent" },
};

export interface Tick {
  trigger: Trigger;
  cron: string;
  /** The controller's scheduled time (ms); the hourly gate reads its minute. */
  scheduledTime: number;
  /** `ctx.clock.now()` when the tick started. */
  now: number;
  queue: JobQueue;
}

/**
 * What a job returns: a count, nothing (0), or notification ids that the router delivers right after the job
 * (Python's `deliver(result)` for list results), reported as their count.
 */
export type JobResult = number | undefined | { notificationIds: readonly string[] };

export type JobHandler = (ctx: Ctx, tick: Tick) => Promise<JobResult>;

export interface JobRegistry {
  register(name: JobName, handler: JobHandler): void;
  get(name: JobName): JobHandler | undefined;
}

export function createJobRegistry(): JobRegistry {
  const handlers = new Map<JobName, JobHandler>();
  return {
    register(name, handler) {
      if (handlers.has(name)) throw new Error(`job ${name} registered twice`);
      handlers.set(name, handler);
    },
    get: (name) => handlers.get(name),
  };
}

/** The production registry. JOBS-12 registers into it from `src/jobs/tasks/`. */
export const jobs = createJobRegistry();

export function triggerOf(cron: string): Trigger | null {
  for (const [t, expr] of Object.entries(CRONS)) if (expr === cron) return t as Trigger;
  return null;
}

/** Slots this tick runs, in order. The hourly ones only in the first quarter-hour (the minute-2 tick). */
export function slotsFor(trigger: Trigger, scheduledTime: number): JobName[] {
  const firstQuarter = new Date(scheduledTime).getUTCMinutes() < 15;
  return JOB_NAMES.filter((n) => {
    const slot = JOB_SLOTS[n];
    return slot.trigger === trigger && (slot.hourly !== true || firstQuarter);
  });
}

export interface TickOptions {
  registry?: JobRegistry;
  /** Defaults to `env.JOBS`. */
  queue?: JobQueue;
}

/** Runs one trigger's tick. Returns the report, or null when the lease was held elsewhere. */
export async function runTick(
  ctx: Ctx,
  trigger: Trigger,
  scheduledTime: number,
  { registry = jobs, queue = ctx.env.JOBS }: TickOptions = {},
): Promise<JobReport | null> {
  const started = ctx.clock.now();
  const lease = await acquireLease(ctx.db, `cron:${trigger}`, started);
  if (lease === null) {
    ctx.log.info("tick skipped: lease held", { trigger });
    return null;
  }
  const tick: Tick = { trigger, cron: CRONS[trigger], scheduledTime, now: started, queue };
  const report: JobReport = {};
  try {
    for (const name of slotsFor(trigger, scheduledTime)) {
      const handler = registry.get(name);
      if (handler === undefined) continue;
      try {
        const result = await handler(ctx, tick);
        let count: number;
        if (typeof result === "object") {
          await dispatchDeliver(tick.queue, result.notificationIds);
          count = result.notificationIds.length;
        } else count = Math.trunc(result ?? 0);
        report[name] = { result: count };
        if (count > 0) ctx.log.info("job done", { job: name, result: count });
      } catch (err) {
        ctx.log.error("job failed", err, { job: name });
        report[name] = { error: err instanceof Error ? err.name : "Error" };
      }
    }
    const end = ctx.clock.now();
    await recordHeartbeat(ctx.db, ctx.log, report, end - started, end);
  } finally {
    await releaseLease(ctx.db, lease, ctx.clock.now()).catch((err: unknown) => {
      ctx.log.error("lease not released", err, { trigger });
    });
  }
  return report;
}

/** `scheduled()` entry point. */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  exec: Deferrer,
  registry: JobRegistry = jobs,
): Promise<JobReport | null> {
  const log = createLogger({ cron: controller.cron });
  const trigger = triggerOf(controller.cron);
  if (trigger === null) {
    log.warn("unknown cron trigger");
    return null;
  }
  const cfg = loadConfig(env);
  if (!cfg.ok) {
    log.error("refusing to run jobs: bad config", undefined, { reasons: cfg.reasons.join("; ") });
    return null;
  }
  const ctx = createCtx(env, cfg.config, exec, `cron:${trigger}:${controller.scheduledTime}`);
  return runTick(ctx, trigger, controller.scheduledTime, { registry });
}
