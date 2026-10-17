import { describe, expect, it } from "vitest";
import {
  chunk,
  dispatchDeliver,
  dispatchJobSlices,
  dispatchPurge,
  enqueue,
  type JobMessage,
} from "../../src/jobs/dispatch.ts";
import { recordingQueue } from "./helpers.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("dispatch", () => {
  it("an empty selection sends nothing", async () => {
    const q = recordingQueue();
    expect(await dispatchDeliver(q, [])).toBe(0);
    expect(await dispatchJobSlices(q, "nudges", [])).toBe(0);
    expect(await dispatchPurge(q, [])).toBe(0);
    expect(await enqueue(q, [])).toBe(0);
    expect(q.calls).toEqual([]);
  });

  it("packs at most 50 ids per message, in order, deduplicated", async () => {
    const q = recordingQueue();
    const sent = await dispatchDeliver(q, [...ids(120), "id-3", "id-7"]);
    expect(sent).toBe(3);
    expect(q.calls).toHaveLength(1);
    const sizes = q.messages.map((m) => (m.type === "deliver" ? m.ids.length : -1));
    expect(sizes).toEqual([50, 50, 20]);
    expect(q.messages.flatMap((m) => (m.type === "deliver" ? m.ids : []))).toEqual(ids(120));
  });

  it("exactly 50 ids is one message", async () => {
    const q = recordingQueue();
    expect(await dispatchJobSlices(q, "digest", ids(50))).toBe(1);
    expect(q.messages[0]).toEqual({ type: "job-slice", job: "digest", ids: ids(50) });
  });

  it("purge packs user ids", async () => {
    const q = recordingQueue();
    await dispatchPurge(q, ids(51));
    expect(q.messages.map((m) => m.type)).toEqual(["purge", "purge"]);
  });

  it("splits more than 100 messages over several sendBatch calls", async () => {
    const q = recordingQueue();
    const msgs: JobMessage[] = ids(230).map((jobId) => ({ type: "import-slice", jobId }));
    expect(await enqueue(q, msgs)).toBe(230);
    expect(q.calls.map((c) => c.length)).toEqual([100, 100, 30]);
  });

  it("chunk rejects a bad size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(chunk([], 5)).toEqual([]);
  });
});
