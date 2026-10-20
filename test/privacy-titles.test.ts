/**
 * The subject-line rule: no email subject, push title or push body (they show on lock screens and in previews) may
 * hold a habit's or chain's name, note or amount. Habits are never shown to anyone else (root AGENTS.md), and a
 * phone on a table is "anyone else". The specifics stay in the email body and the in-app inbox (`detail`).
 */
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notifications } from "../src/db/schema/index.ts";
import * as templates from "../src/lib/mailer/templates.ts";
import { deliver } from "../src/modules/notifications/service.ts";
import { sent } from "./fixtures/auth.ts";
import { testDb } from "./fixtures/db.ts";
import { putWorkout } from "./fixtures/game.ts";
import { api, jsonOf } from "./fixtures/http.ts";
import { person } from "./fixtures/profile.ts";
import { logSession } from "./fixtures/training.ts";
import { jobCtx, runFor } from "./jobs/helpers.ts";

const SECRET = "Quit drinking";
const NOTE = "after the 6pm craving";
const { db } = testDb();
const hourNow = () => new Date().getUTCHours();

interface Note {
  title: string;
  body: string | null;
  kind: string;
  data: Record<string, unknown> | null;
}

async function notesOf(userId: string): Promise<Note[]> {
  return db
    .select({
      title: notifications.title,
      body: notifications.body,
      kind: notifications.kind,
      data: notifications.data,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
}

/** Title and body are what reach a lock screen: neither may name the habit or its note. */
function expectLockScreenSafe(n: Note) {
  for (const text of [n.title, n.body ?? ""]) {
    expect(text.toLowerCase(), `${n.kind}: ${text}`).not.toContain(SECRET.toLowerCase());
    expect(text, `${n.kind}: ${text}`).not.toContain(NOTE);
  }
}

/** The console line's first line is `to=... subject=...`; the subject must not name the habit either. */
function subjectsTo(email: string): string[] {
  return sent
    .filter((m) => m.startsWith(`[email:console] to=${email} `))
    .map((m) => (m.split("\n")[0] ?? "").replace(/^.* subject=/, ""));
}

describe("subject lines and push titles never name a habit", () => {
  it("every transactional template keeps its subject generic, whatever it is given", () => {
    const made = [
      templates.verificationEmail(SECRET, SECRET),
      templates.passwordResetEmail(SECRET, SECRET),
      templates.passwordChangedEmail(SECRET, SECRET),
      templates.emailChangeEmail(SECRET, SECRET),
      templates.emailChangedNotice(SECRET, SECRET),
      templates.loginCodeEmail(SECRET, "123456", SECRET),
    ];
    // A new template must be added above: count the exported builders.
    const builders = Object.entries(templates).filter(
      ([k, v]) => typeof v === "function" && /(Email|Notice)$/.test(k) && !k.startsWith("send"),
    );
    expect(builders).toHaveLength(made.length);
    for (const m of made) expect(m.subject).not.toContain(SECRET);
    // The code is never in a subject either.
    expect(templates.loginCodeEmail("a@b.c", "123456", "x").subject).not.toContain("123456");
  });

  it("a habit reminder: generic title and body; the name and note only in the email body and inbox", async () => {
    const me = await person();
    const res = await api("/v1/habits", {
      token: me.token,
      json: { name: SECRET, kind: "check", cue: NOTE, remind_hour: hourNow() },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const ids = await runFor("habits", me.userId);
    expect(ids).toHaveLength(1);
    const notes = (await notesOf(me.userId)).filter((n) => n.kind === "habit_reminder");
    expect(notes).toHaveLength(1);
    const [n] = notes;
    if (n === undefined) throw new Error("no reminder");
    expectLockScreenSafe(n);
    expect(n.title).toBe("Habit reminder");
    expect(String(n.data?.detail)).toContain(SECRET);

    // The owner's inbox shows the specifics.
    const inbox = await jsonOf<{ items: { kind: string; title: string; body: string }[] }>(
      await api("/v1/notifications", { token: me.token }),
    );
    expect(inbox.items.find((i) => i.kind === "habit_reminder")?.body).toContain(SECRET);

    // Email it (habit reminders default to push only): subject generic, body specific.
    await api("/v1/notifications/preferences", {
      token: me.token,
      method: "PUT",
      json: { channels: { habits: { email: true } } },
    });
    await db.update(notifications).set({ deliveredAt: null }).where(inArray(notifications.id, ids));
    await deliver(jobCtx(), ids);
    const mail = sent.findLast((m) => m.startsWith(`[email:console] to=${me.email} `)) ?? "";
    const [head = "", ...body] = mail.split("\n");
    expect(head).toContain("subject=Habit reminder");
    expect(head).not.toContain(SECRET);
    expect(body.join("\n")).toContain(SECRET);
  });

  it("a streak-at-risk nudge on a chain named after a habit", async () => {
    const me = await person(undefined, { weekly_target: 7 });
    await api("/v1/me/profile", { token: me.token, method: "PATCH", json: { reminder_hour: hourNow() } });
    const chains = await jsonOf<{ chains: { id: string }[] }>(await api("/v1/chains", { token: me.token }));
    const list = chains.chains;
    const main = list[0];
    if (main === undefined) throw new Error("no chain");
    const patched = await api(`/v1/chains/${main.id}`, {
      token: me.token,
      method: "PATCH",
      json: { name: SECRET },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    await logSession(me.token);
    expect(await runFor("nudges", me.userId)).toHaveLength(1);
    const notes = (await notesOf(me.userId)).filter((n) => n.kind === "streak_risk");
    expect(notes).toHaveLength(1);
    for (const n of notes) expectLockScreenSafe(n);
  });

  it("streak milestones, records and levels name no chain", async () => {
    const me = await person(undefined, { weekly_target: 1 });
    const chains = await jsonOf<{ chains: { id: string }[] }>(await api("/v1/chains", { token: me.token }));
    const list = chains.chains;
    await api(`/v1/chains/${list[0]?.id}`, { token: me.token, method: "PATCH", json: { name: SECRET } });
    const now = Date.now();
    for (let w = 4; w >= 0; w--) {
      await putWorkout(me.userId, {
        startedAt: now - w * 7 * 86_400_000 - 3_600_000,
        sets: [{ exercise_id: "back-squat", weight_kg: 60 + (4 - w) * 10, reps: 5 }],
      });
    }
    const notes = await notesOf(me.userId);
    const milestone = notes.filter((n) => n.kind === "streak_milestone");
    expect(milestone.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.kind === "personal_record")).toBe(true);
    for (const n of notes) expectLockScreenSafe(n);
    expect(String(milestone[0]?.data?.detail)).toContain(SECRET);
  });

  it("nothing a person's habits trigger puts the name in a subject", async () => {
    const me = await person();
    await api("/v1/habits", {
      token: me.token,
      json: { name: SECRET, kind: "check", cue: NOTE, remind_hour: hourNow() },
    });
    await runFor("habits", me.userId);
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, me.userId));
    await api("/v1/notifications/preferences", {
      token: me.token,
      method: "PUT",
      json: { channels: { habits: { email: true } } },
    });
    const ids = rows.map((r) => r.id);
    await db.update(notifications).set({ deliveredAt: null }).where(inArray(notifications.id, ids));
    await deliver(jobCtx(), ids);
    for (const s of subjectsTo(me.email)) expect(s).not.toContain(SECRET);
    for (const n of await notesOf(me.userId)) expectLockScreenSafe(n);
  });
});
