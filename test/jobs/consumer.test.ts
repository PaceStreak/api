import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type ConsumerRegistry,
  createConsumerRegistry,
  deadLetterSummary,
  handleQueue,
  isDeadLetterQueue,
  JobMessageSchema,
  retryDelaySeconds,
} from "../../src/jobs/consumer.ts";
import type { JobMessage } from "../../src/jobs/dispatch.ts";

function batchOf(bodies: unknown[], attempts = 1) {
  return createMessageBatch(
    "pacestreak-jobs",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: Date.now(), attempts, body })),
  );
}

async function consume(bodies: unknown[], reg: ConsumerRegistry, attempts = 1) {
  const batch = batchOf(bodies, attempts);
  const exec = createExecutionContext();
  await handleQueue(batch, env, exec, reg);
  return getQueueResult(batch, exec);
}

const ALL: JobMessage[] = [
  { type: "deliver", ids: ["a"] },
  { type: "recompute", userId: "u", full: true },
  { type: "rebuild-slice", userId: "u", cursor: null },
  { type: "job-slice", job: "nudges", ids: ["p"] },
  { type: "import-slice", jobId: "j" },
  { type: "export-slice", jobId: "j", part: 2 },
  { type: "purge", userIds: ["u1", "u2"] },
];

describe("queue consumer", () => {
  it("routes every message type to its own handler and acks it", async () => {
    const seen: JobMessage[] = [];
    const reg = createConsumerRegistry();
    reg.register("deliver", async (_c, m) => void seen.push(m));
    reg.register("recompute", async (_c, m) => void seen.push(m));
    reg.register("rebuild-slice", async (_c, m) => void seen.push(m));
    reg.register("job-slice", async (_c, m) => void seen.push(m));
    reg.register("import-slice", async (_c, m) => void seen.push(m));
    reg.register("export-slice", async (_c, m) => void seen.push(m));
    reg.register("purge", async (_c, m) => void seen.push(m));
    const res = await consume(ALL, reg);
    expect(seen).toEqual(ALL);
    expect(res.explicitAcks.sort()).toEqual(ALL.map((_, i) => `m${i}`).sort());
    expect(res.retryMessages).toEqual([]);
  });

  it("a failing handler retries only its message, with backoff", async () => {
    const reg = createConsumerRegistry();
    reg.register("deliver", async (_c, m) => {
      if (m.ids.includes("bad")) throw new Error("push failed");
    });
    const res = await consume(
      [
        { type: "deliver", ids: ["ok"] },
        { type: "deliver", ids: ["bad"] },
      ],
      reg,
      3,
    );
    expect(res.explicitAcks).toEqual(["m0"]);
    // The test harness does not record delaySeconds; retryDelaySeconds is covered below.
    expect(res.retryMessages.map((r) => r.msgId)).toEqual(["m1"]);
  });

  it("malformed bodies are acked and dropped; unhandled types are retried", async () => {
    const reg = createConsumerRegistry();
    const res = await consume(
      [{ type: "nope" }, { type: "deliver", ids: [] }, "x", { type: "purge", userIds: ["u"] }],
      reg,
    );
    expect(res.explicitAcks.sort()).toEqual(["m0", "m1", "m2"]);
    expect(res.retryMessages.map((r) => r.msgId)).toEqual(["m3"]);
  });

  it("the handler receives message metadata", async () => {
    const reg = createConsumerRegistry();
    let meta: unknown;
    reg.register("import-slice", async (_c, _m, mt) => {
      meta = mt;
    });
    await consume([{ type: "import-slice", jobId: "j" }], reg, 2);
    expect(meta).toEqual({ id: "m0", attempts: 2 });
  });

  it("a type registered twice is an error", () => {
    const reg = createConsumerRegistry();
    reg.register("purge", async () => {});
    expect(() => reg.register("purge", async () => {})).toThrow(/twice/);
  });

  it("schema: job-slice needs a known job, ids are capped", () => {
    expect(JobMessageSchema.safeParse({ type: "job-slice", job: "nope", ids: ["a"] }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => `${i}`);
    expect(JobMessageSchema.safeParse({ type: "deliver", ids: many }).success).toBe(false);
  });

  it("backoff doubles and caps at 10 minutes", () => {
    expect([1, 2, 3, 4, 10].map(retryDelaySeconds)).toEqual([10, 20, 40, 80, 600]);
  });
});

describe("dead-letter consumer", () => {
  async function consumeDlq(queue: string, bodies: unknown[], tag = "d") {
    const batch = createMessageBatch(
      queue,
      bodies.map((body, i) => ({ id: `${queue}-${tag}${i}`, timestamp: Date.now(), attempts: 1, body })),
    );
    const exec = createExecutionContext();
    // A registry with no handlers: a dead letter must never be routed to a job handler.
    await handleQueue(batch, env, exec, createConsumerRegistry());
    return getQueueResult(batch, exec);
  }

  const rows = async (queue: string) =>
    (
      await env.DB.prepare(
        "SELECT message, stack, alerted_at AS alertedAt FROM client_errors WHERE path = ? ORDER BY message",
      )
        .bind(`queue:${queue}`)
        .all<{ message: string; stack: string | null; alertedAt: number | null }>()
    ).results;

  it.each(["pacestreak-jobs-dlq", "pacestreak-jobs-staging-dlq"])(
    "%s records the job type and ids, unalerted, then acks",
    async (queue) => {
      const res = await consumeDlq(queue, [
        { type: "purge", userIds: ["u1", "u2"] },
        { type: "job-slice", job: "nudges", ids: ["p1"] },
        { secret: "someone@example.com" },
      ]);
      expect(res.ackAll).toBe(true);
      expect(res.retryBatch.retry).toBe(false);
      expect(res.retryMessages).toEqual([]);
      const got = await rows(queue);
      expect(got.map((r) => r.message)).toEqual([
        "Dead-lettered job: job-slice nudges ids=p1",
        "Dead-lettered job: malformed message",
        "Dead-lettered job: purge userIds=u1, u2",
      ]);
      expect(got.every((r) => r.stack === null && r.alertedAt === null)).toBe(true);
      expect(JSON.stringify(got)).not.toContain("example.com");
    },
  );

  it("a redelivered dead letter counts on its own row instead of adding one", async () => {
    const queue = "pacestreak-jobs-dlq";
    await consumeDlq(queue, [{ type: "recompute", userId: "u9" }], "again");
    await consumeDlq(queue, [{ type: "recompute", userId: "u9" }], "again");
    const r = await env.DB.prepare("SELECT count FROM client_errors WHERE message LIKE '%u9%'").all<{
      count: number;
    }>();
    expect(r.results).toEqual([{ count: 2 }]);
  });

  it("caps the id list it records", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    expect(deadLetterSummary({ type: "deliver", ids })).toBe(
      `deliver ids=${ids.slice(0, 10).join(", ")} (+20 more)`,
    );
  });

  it("only queues ending in -dlq are dead-letter queues", () => {
    expect(isDeadLetterQueue("pacestreak-jobs-dlq")).toBe(true);
    expect(isDeadLetterQueue("pacestreak-jobs-staging-dlq")).toBe(true);
    expect(isDeadLetterQueue("pacestreak-jobs")).toBe(false);
  });
});
