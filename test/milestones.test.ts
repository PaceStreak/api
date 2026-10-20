/** Milestone emails: a few big moments in their own category, email on by default, sent at most once each. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notifications } from "../src/db/schema/index.ts";
import { crossesMilestoneLevel, MILESTONE_STREAK_WEEKS } from "../src/modules/game/service.ts";
import * as notif from "../src/modules/notifications/service.ts";
import { sent } from "./fixtures/auth.ts";
import { testDb } from "./fixtures/db.ts";
import { putWorkout } from "./fixtures/game.ts";
import { api, jsonOf } from "./fixtures/http.ts";
import { person } from "./fixtures/profile.ts";
import { jobCtx } from "./jobs/helpers.ts";

const { db } = testDb();
const WEEK = 7 * 86_400_000;

const notesOf = (userId: string, kind: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));

const mailsTo = (email: string) => sent.filter((m) => m.startsWith(`[email:console] to=${email} `));

/** Four weeks in a row (weekly target 1), oldest first, then the milestone notes. */
async function fourWeeks() {
  const me = await person(undefined, { weekly_target: 1 });
  const now = Date.now();
  for (let w = 3; w >= 0; w--) {
    await putWorkout(me.userId, {
      startedAt: now - w * WEEK - 3_600_000,
      sets: [{ exercise_id: "back-squat", weight_kg: 60, reps: 5 }],
    });
  }
  return me;
}

describe("milestone emails", () => {
  it("are their own category, email on and push off by default, and can be turned off", async () => {
    expect(notif.CATEGORIES.milestones).toEqual({ label: "Milestones", push: false, email: true });
    expect(notif.channelsFor(null, "milestones", true)).toEqual({ push: false, email: true });
    expect(notif.channelsFor(null, "milestones", false)).toEqual({ push: false, email: false });
    const me = await person();
    const prefs = await jsonOf<{ categories: { id: string; email: boolean; locked: boolean }[] }>(
      await api("/v1/notifications/preferences", { token: me.token }),
    );
    expect(prefs.categories.find((c) => c.id === "milestones")).toMatchObject({ email: true, locked: false });
    const sig = await notif.signUnsubscribe(jobCtx(), me.userId, "milestones");
    const off = await api("/v1/notifications/unsubscribe", {
      json: { u: me.userId, c: "milestones", s: sig },
    });
    expect(await jsonOf(off)).toEqual({ detail: "Done - no more 'Milestones' emails." });
    expect(notif.channelsFor({ milestones: { email: false } }, "milestones", true).email).toBe(false);
  });

  it("only some streak lengths and every fifth level count", () => {
    expect([...MILESTONE_STREAK_WEEKS]).toEqual([4, 26, 52, 104, 156]);
    expect(crossesMilestoneLevel(4, 5)).toBe(true);
    expect(crossesMilestoneLevel(3, 6)).toBe(true);
    expect(crossesMilestoneLevel(5, 6)).toBe(false);
    expect(crossesMilestoneLevel(1, 4)).toBe(false);
    expect(crossesMilestoneLevel(9, 10)).toBe(true);
  });

  it("a 4-week streak is emailed once, with one-click unsubscribe", async () => {
    const me = await fourWeeks();
    const notes = await notesOf(me.userId, "streak_milestone");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: "milestones", title: "4-week streak" });
    expect(notes[0]?.dedupeKey).toMatch(/^milestone:/);
    // Another session the same week: the dedupe key holds, no second note.
    await putWorkout(me.userId, { sets: [{ exercise_id: "back-squat", weight_kg: 60, reps: 5 }] });
    expect(await notesOf(me.userId, "streak_milestone")).toHaveLength(1);

    const before = mailsTo(me.email).length;
    await db
      .update(notifications)
      .set({ deliveredAt: null })
      .where(eq(notifications.id, notes[0]?.id ?? ""));
    await notif.deliver(jobCtx(), [notes[0]?.id ?? ""]);
    const mail = mailsTo(me.email).slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toContain("subject=4-week streak");
    expect(mail[0]).toContain(`/unsubscribe?u=${me.userId}&c=milestones&s=`);
    const headers = await notif.listHeaders(jobCtx(), me.userId, "milestones");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toContain("/v1/notifications/unsubscribe/one-click?");
  });

  it("new personal records: at most one email a day however many records", async () => {
    const me = await person();
    const now = Date.now();
    // Two heavier sessions a week apart set records; then two more today, each heavier again.
    const at = [now - 2 * WEEK, now - WEEK, now - 2 * 3_600_000, now - 3_600_000];
    for (const [i, t] of at.entries()) {
      await putWorkout(me.userId, {
        startedAt: t,
        sets: [
          { exercise_id: "back-squat", weight_kg: 60 + i * 10, reps: 5 },
          { exercise_id: "bench-press", weight_kg: 40 + i * 10, reps: 5 },
        ],
      });
    }
    const notes = await notesOf(me.userId, "personal_record");
    expect(notes.length).toBeGreaterThan(0);
    const keys = notes.map((n) => n.dedupeKey);
    for (const k of keys) expect(k).toMatch(/^records:\d{4}-\d\d-\d\d$/);
    expect(new Set(keys).size).toBe(keys.length);
    expect(notes.every((n) => n.category === "milestones" && n.title.includes("personal record"))).toBe(true);
    const today = new Date(now).toISOString().slice(0, 10);
    expect(keys.filter((k) => k === `records:${today}`).length).toBeLessThanOrEqual(1);
  });
});
