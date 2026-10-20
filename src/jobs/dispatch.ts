/**
 * Producer side of the `pacestreak-jobs` queue (DESIGN.md §9, lane 2 and 3): the message shapes, id packing and
 * `sendBatch` chunking. Dispatchers select ids and hand them here; an empty selection never touches the queue.
 */
import type { JobName } from "./scheduled.ts";

/** Most ids carried by one message, so one consumer invocation stays bounded (DESIGN.md §9). */
export const IDS_PER_MESSAGE = 50;

/**
 * D1 counts every statement, each one inside a `batch()` too, against a per-invocation cap: 50 queries on Workers
 * Free, 1,000 on Paid (src/lib/plan.ts; `PLAN` in wrangler.jsonc). The consumer takes one message per invocation
 * (`max_batch_size: 1` in wrangler.jsonc), so each message's work must fit on its own: `ctx.cfg.d1Budget`, 90% of
 * the cap.
 */

/**
 * Most statements one id adds to a `job-slice` for jobs whose cost grows per id: a recompute (`stats`: the read with
 * the profile/chain creates, then the projection write) and a snapshot (`nudges`, `digest`: one fused read plus the
 * habit logs, three statements). The other jobs read and write their whole pack with a constant number of set-based
 * statements. test/jobs/d1-limits.test.ts measures these costs on a real account and holds every pack to the budget.
 */
export const SLICE_COSTS: Partial<Record<JobName, number>> = { stats: 14, nudges: 4, digest: 4 };
/** Statements a slice spends whatever its size: the pack's own reads, the notes insert, a lost race's re-read. */
export const SLICE_OVERHEAD = 8;

/** Ids per `job-slice` for `job` on a plan with `budget` statements per invocation: at least 1, at most 50. */
export function idsPerSlice(job: JobName, budget: number): number {
  const cost = SLICE_COSTS[job];
  if (cost === undefined) return IDS_PER_MESSAGE;
  return Math.max(1, Math.min(IDS_PER_MESSAGE, Math.floor((budget - SLICE_OVERHEAD) / cost)));
}

/**
 * Notes per `deliver` message. The consumer still delivers only what fits its invocation's subrequest and D1
 * budgets (a backup note builds the export for its attachment) and re-enqueues the rest (notifications `deliver`).
 */
export const DELIVER_IDS = 20;
/** Workers Queues accepts at most 100 messages per `sendBatch` call. */
export const MESSAGES_PER_SEND = 100;

export type JobMessage =
  | { type: "deliver"; ids: string[] }
  | { type: "recompute"; userId: string; full?: boolean | undefined }
  | { type: "rebuild-slice"; userId: string; cursor: string | null }
  | { type: "job-slice"; job: JobName; ids: string[] }
  | { type: "import-slice"; jobId: string }
  | { type: "export-slice"; jobId: string; part: number }
  | { type: "purge"; userIds: string[] }
  | {
      type: "merge-slice";
      source: string;
      into: string;
      keepSourceProfile: boolean;
      auditId: string;
      /** First plan statement this slice runs. */
      from: number;
      /** Rows moved by the slices before, per table. */
      moved: Record<string, number>;
    };

export type MessageType = JobMessage["type"];
export type MessageOf<T extends MessageType> = Extract<JobMessage, { type: T }>;

/** The queue as producers see it; `env.JOBS` satisfies it, tests pass a recorder. */
export interface JobQueue {
  sendBatch(messages: Iterable<MessageSendRequest<JobMessage>>): Promise<unknown>;
}

/** Splits `items` into consecutive chunks of at most `size` (no empty chunks). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`bad chunk size: ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sends `messages` in `sendBatch` calls of at most 100. Nothing is sent for an empty list. Returns the count. */
export async function enqueue(queue: JobQueue, messages: readonly JobMessage[]): Promise<number> {
  for (const part of chunk(messages, MESSAGES_PER_SEND)) {
    await queue.sendBatch(part.map((body) => ({ body, contentType: "json" as const })));
  }
  return messages.length;
}

/**
 * Packs `ids` (deduplicated, order kept) into messages of at most `perMessage` ids built by `make`, and enqueues
 * them.
 * Returns the number of messages sent; 0 (and no queue operation) when `ids` is empty.
 */
export function dispatchIds(
  queue: JobQueue,
  ids: readonly string[],
  make: (ids: string[]) => JobMessage,
  perMessage: number = IDS_PER_MESSAGE,
): Promise<number> {
  const unique = [...new Set(ids)];
  return enqueue(queue, chunk(unique, perMessage).map(make));
}

/** Outbox delivery for freshly inserted notification ids. */
export const dispatchDeliver = (queue: JobQueue, ids: readonly string[]) =>
  dispatchIds(queue, ids, (part) => ({ type: "deliver", ids: part }), DELIVER_IDS);

/** Fans a job's selected ids out to `job-slice` messages sized for `budget` statements per invocation. */
export const dispatchJobSlices = (queue: JobQueue, job: JobName, ids: readonly string[], budget: number) =>
  dispatchIds(queue, ids, (part) => ({ type: "job-slice", job, ids: part }), idsPerSlice(job, budget));

/** Account purge in packs of 50 users (DESIGN.md §9, job 10). */
export const dispatchPurge = (queue: JobQueue, userIds: readonly string[]) =>
  dispatchIds(queue, userIds, (part) => ({ type: "purge", userIds: part }));
