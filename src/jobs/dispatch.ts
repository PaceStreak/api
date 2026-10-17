/**
 * Producer side of the `pacestreak-jobs` queue (DESIGN.md §9, lane 2 and 3): the message shapes, id packing and
 * `sendBatch` chunking. Dispatchers select ids and hand them here; an empty selection never touches the queue.
 */
import type { JobName } from "./scheduled.ts";

/** Most ids carried by one message, so one consumer invocation stays bounded (DESIGN.md §9). */
export const IDS_PER_MESSAGE = 50;
/** Workers Queues accepts at most 100 messages per `sendBatch` call. */
export const MESSAGES_PER_SEND = 100;

export type JobMessage =
  | { type: "deliver"; ids: string[] }
  | { type: "recompute"; userId: string; full?: boolean | undefined }
  | { type: "rebuild-slice"; userId: string; cursor: string | null }
  | { type: "job-slice"; job: JobName; ids: string[] }
  | { type: "import-slice"; jobId: string }
  | { type: "export-slice"; jobId: string; part: number }
  | { type: "purge"; userIds: string[] };

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
 * Packs `ids` (deduplicated, order kept) into messages of at most 50 ids built by `make`, and enqueues them.
 * Returns the number of messages sent; 0 (and no queue operation) when `ids` is empty.
 */
export function dispatchIds(
  queue: JobQueue,
  ids: readonly string[],
  make: (ids: string[]) => JobMessage,
): Promise<number> {
  const unique = [...new Set(ids)];
  return enqueue(queue, chunk(unique, IDS_PER_MESSAGE).map(make));
}

/** Outbox delivery for freshly inserted notification ids. */
export const dispatchDeliver = (queue: JobQueue, ids: readonly string[]) =>
  dispatchIds(queue, ids, (part) => ({ type: "deliver", ids: part }));

/** Fans a job's selected ids out to `job-slice` messages. */
export const dispatchJobSlices = (queue: JobQueue, job: JobName, ids: readonly string[]) =>
  dispatchIds(queue, ids, (part) => ({ type: "job-slice", job, ids: part }));

/** Account purge in packs of 50 users (DESIGN.md §9, job 10). */
export const dispatchPurge = (queue: JobQueue, userIds: readonly string[]) =>
  dispatchIds(queue, userIds, (part) => ({ type: "purge", userIds: part }));
