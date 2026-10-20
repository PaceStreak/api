/** Shared helpers for the jobs tests: a real `Ctx` over the test D1 and a recording queue. */
import { createExecutionContext, env } from "cloudflare:test";
import { and, inArray } from "drizzle-orm";
import { expect } from "vitest";
import { type Ctx, createCtx } from "../../src/ctx.ts";
import { notifications } from "../../src/db/schema/index.ts";
import { loadConfig } from "../../src/env.ts";
import type { JobMessage, JobQueue } from "../../src/jobs/dispatch.ts";
import type { JobName } from "../../src/jobs/scheduled.ts";
import { runSliced } from "../../src/jobs/tasks/index.ts";

export function jobCtx(): Ctx {
  const cfg = loadConfig(env);
  if (!cfg.ok) throw new Error(cfg.reasons.join("; "));
  return createCtx(env, cfg.config, createExecutionContext(), "test");
}

export interface RecordingQueue extends JobQueue {
  /** One entry per `sendBatch` call. */
  calls: JobMessage[][];
  readonly messages: JobMessage[];
}

export function recordingQueue(): RecordingQueue {
  const calls: JobMessage[][] = [];
  return {
    calls,
    get messages() {
      return calls.flat();
    },
    async sendBatch(msgs) {
      calls.push([...msgs].map((m) => m.body));
    },
  };
}

/**
 * Runs a sliced job in-process (Python's job function) and keeps only the notification ids addressed to `users`:
 * tests in a file share one database, so other tests' people may be due too.
 */
export async function runFor(
  name: JobName,
  users: string | readonly string[],
  ctx: Ctx = jobCtx(),
): Promise<string[]> {
  // Each slice is one queue invocation in production: it must fit the plan's D1 budget (src/lib/plan.ts).
  const ids = await runSliced(ctx, name, undefined, (statements) => {
    expect(statements, `${name} slice statements`).toBeLessThanOrEqual(ctx.cfg.d1Budget);
  });
  if (ids.length === 0) return [];
  const wanted = typeof users === "string" ? [users] : [...users];
  const rows = await ctx.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(inArray(notifications.id, ids.slice(0, 90)), inArray(notifications.userId, wanted)));
  return rows.map((r) => r.id);
}
