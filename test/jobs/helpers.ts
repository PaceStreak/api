/** Shared helpers for the jobs tests: a real `Ctx` over the test D1 and a recording queue. */
import { createExecutionContext, env } from "cloudflare:test";
import { type Ctx, createCtx } from "../../src/ctx.ts";
import { loadConfig } from "../../src/env.ts";
import type { JobMessage, JobQueue } from "../../src/jobs/dispatch.ts";

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
