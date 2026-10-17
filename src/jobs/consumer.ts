/**
 * Consumer of `pacestreak-jobs` (DESIGN.md §9 lane 2): validates each message, routes it by `type` to a registered
 * handler and acks or retries it individually. Handlers must be idempotent (redelivery is normal). After
 * `max_retries` (wrangler.jsonc) a message lands in `pacestreak-jobs-dlq`.
 *
 * - malformed body: logged and acked; retrying cannot make it valid.
 * - no handler registered: retried, so a deploy that adds the handler (or the DLQ) still sees it.
 * - handler throws: retried with exponential backoff.
 */
import { z } from "zod";
import { type Ctx, createCtx, type Deferrer } from "../ctx.ts";
import { loadConfig } from "../env.ts";
import { createLogger } from "../lib/logger.ts";
import type { JobMessage, MessageOf, MessageType } from "./dispatch.ts";
import { JOB_NAMES } from "./scheduled.ts";

const ids = z.array(z.string().min(1)).min(1).max(100);

export const JobMessageSchema: z.ZodType<JobMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deliver"), ids }),
  z.object({ type: z.literal("recompute"), userId: z.string().min(1), full: z.boolean().optional() }),
  z.object({ type: z.literal("rebuild-slice"), userId: z.string().min(1), cursor: z.string().nullable() }),
  z.object({ type: z.literal("job-slice"), job: z.enum(JOB_NAMES), ids }),
  z.object({ type: z.literal("import-slice"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("export-slice"), jobId: z.string().min(1), part: z.int().min(0) }),
  z.object({ type: z.literal("purge"), userIds: ids }),
]);

export interface MessageMeta {
  id: string;
  attempts: number;
}

export type MessageHandler<T extends MessageType> = (
  ctx: Ctx,
  msg: MessageOf<T>,
  meta: MessageMeta,
) => Promise<void>;

export interface ConsumerRegistry {
  register<T extends MessageType>(type: T, handler: MessageHandler<T>): void;
  get<T extends MessageType>(type: T): MessageHandler<T> | undefined;
}

export function createConsumerRegistry(): ConsumerRegistry {
  const handlers: { [T in MessageType]?: MessageHandler<T> } = {};
  return {
    register(type, handler) {
      if (handlers[type] !== undefined) throw new Error(`consumer ${type} registered twice`);
      // A computed key: TypeScript cannot correlate a generic `T` key with its mapped value on plain assignment.
      Object.assign(handlers, { [type]: handler });
    },
    get: (type) => handlers[type],
  };
}

/** The production registry: NOTIF registers `deliver`, GAME `recompute`/`rebuild-slice`, and so on. */
export const consumers = createConsumerRegistry();

/** Binds a message to its handler; the switch lets TypeScript narrow each message to its own handler type. */
function handlerFor(
  r: ConsumerRegistry,
  m: JobMessage,
): ((ctx: Ctx, meta: MessageMeta) => Promise<void>) | null {
  const bind = <T extends MessageType>(h: MessageHandler<T> | undefined, msg: MessageOf<T>) =>
    h === undefined ? null : (ctx: Ctx, meta: MessageMeta) => h(ctx, msg, meta);
  switch (m.type) {
    case "deliver":
      return bind(r.get("deliver"), m);
    case "recompute":
      return bind(r.get("recompute"), m);
    case "rebuild-slice":
      return bind(r.get("rebuild-slice"), m);
    case "job-slice":
      return bind(r.get("job-slice"), m);
    case "import-slice":
      return bind(r.get("import-slice"), m);
    case "export-slice":
      return bind(r.get("export-slice"), m);
    case "purge":
      return bind(r.get("purge"), m);
  }
}

/** 10 s, 20 s, 40 s ... capped at 10 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(600, 10 * 2 ** Math.max(0, attempts - 1));
}

/** `queue()` entry point. Messages are processed one at a time, in order. */
export async function handleQueue(
  batch: MessageBatch,
  env: Env,
  exec: Deferrer,
  registry: ConsumerRegistry = consumers,
): Promise<void> {
  const log = createLogger({ queue: batch.queue });
  const cfg = loadConfig(env);
  if (!cfg.ok) {
    log.error("refusing to consume: bad config", undefined, { reasons: cfg.reasons.join("; ") });
    batch.retryAll({ delaySeconds: 60 });
    return;
  }
  const ctx = createCtx(env, cfg.config, exec, `queue:${batch.queue}`);
  for (const message of batch.messages) {
    const parsed = JobMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      log.error("malformed job message dropped", undefined, { msgId: message.id });
      message.ack();
      continue;
    }
    const body = parsed.data;
    const run = handlerFor(registry, body);
    if (run === null) {
      log.warn("no consumer for message type", { type: body.type, msgId: message.id });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    try {
      await run(ctx, { id: message.id, attempts: message.attempts });
      message.ack();
    } catch (err) {
      log.error("job message failed", err, {
        type: body.type,
        msgId: message.id,
        attempts: message.attempts,
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
