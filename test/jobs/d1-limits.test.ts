/**
 * D1 counts every statement, each one inside a batch too, against 1,000 queries per Worker invocation
 * (https://developers.cloudflare.com/d1/platform/limits/, "Batch limits"). The queue consumer takes one message
 * per invocation, so each kind of message must fit with room to spare: this measures the per-id cost of the
 * heavy jobs on a real account and holds their pack sizes (src/jobs/dispatch.ts) to 90% of the limit.
 */
import { describe, expect, it } from "vitest";
import {
  D1_QUERIES_PER_INVOCATION,
  DELIVER_IDS,
  IDS_PER_MESSAGE,
  idsPerSlice,
} from "../../src/jobs/dispatch.ts";
import { exportReads } from "../../src/modules/account/export.ts";
import * as game from "../../src/modules/game/service.ts";
import { person } from "../fixtures/game.ts";
import { api } from "../fixtures/http.ts";
import { logSession } from "../fixtures/training.ts";
import { jobCtx } from "./helpers.ts";

const BUDGET = Math.floor(D1_QUERIES_PER_INVOCATION * 0.9);

describe("D1 queries per invocation", () => {
  it("every heavy message kind fits its pack size under the limit", async () => {
    const me = await person();
    await logSession(me.token);
    const habit = await api("/v1/habits", { token: me.token, json: { name: "Stretch" } });
    expect(habit.status).toBe(201);

    // A recompute that writes (the projection moved): the stats job's per-id cost.
    await logSession(me.token, { title: "Second" });
    const r = jobCtx();
    await game.recompute(r, me.userId, { notify: true });
    const recompute = Math.max(r.stats.statements, 30);
    // A snapshot plus the notification it may insert: nudges and digest.
    const s = jobCtx();
    await game.snapshotsFor(s, [me.userId]);
    const snapshot = s.stats.statements + 1;
    // A backup note's delivery reads the whole account for its attachment, then marks the note delivered.
    const exportCost = exportReads(jobCtx().db, me.userId).length + 2;
    const overhead = 10;

    expect(idsPerSlice("stats") * recompute + overhead).toBeLessThanOrEqual(BUDGET);
    expect(idsPerSlice("nudges") * snapshot + overhead).toBeLessThanOrEqual(BUDGET);
    expect(idsPerSlice("digest") * snapshot + overhead).toBeLessThanOrEqual(BUDGET);
    expect(DELIVER_IDS * exportCost + overhead).toBeLessThanOrEqual(BUDGET);
    // The light jobs read their packs with set-based statements (IN_CHUNK), a few per pack.
    expect(IDS_PER_MESSAGE).toBeLessThanOrEqual(50);
  });
});
