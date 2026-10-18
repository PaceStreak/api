/**
 * Habits beyond the ported pytest cases: signed reminder actions, round-trip budgets (also on the heavy user),
 * privacy of the game's habit view, import edge cases, journal and routines.
 */
import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { habitLogs, sessions, trashItems } from "../src/db/schema/index.ts";
import { addDays } from "../src/lib/time.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import * as game from "../src/modules/game/service.ts";
import * as habits from "../src/modules/habits/service.ts";
import { actionUrl, sign } from "../src/modules/habits/service.ts";
import * as insights from "../src/modules/insights/service.ts";
import { authedBatch, testDb } from "./fixtures/db.ts";
import { person } from "./fixtures/game.ts";
import { seedHeavyUser } from "./fixtures/heavy-user.ts";
import { api, BASE, expectRoundTrips, jsonOf, randomIp } from "./fixtures/http.ts";
import { jobCtx } from "./jobs/helpers.ts";

const TODAY = () => new Date().toISOString().slice(0, 10);
type Habit = Record<string, unknown> & { id: string; today: { amount: number; done: boolean } };

const post = (url: string) => {
  const u = new URL(url);
  return SELF.fetch(`${BASE}${u.pathname}${u.search}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": randomIp() },
  });
};

describe("habit reminder actions", () => {
  it("test_reminder_push_actions_are_signed_and_scoped", async () => {
    const me = await person();
    const token = me.token;
    const h = await jsonOf<Habit>(
      await api("/v1/habits", { token, json: { name: "Floss", remind_hour: new Date().getUTCHours() } }),
    );
    // The habit_reminders job (JOBS-12) puts these two URLs on the push; built here the same way.
    const ctx = jobCtx();
    const day = TODAY();
    const actions = {
      done: await actionUrl(ctx, me.userId, h.id, "done", day),
      snooze: await actionUrl(ctx, me.userId, h.id, "snooze", day),
    };

    const snoozed = await post(actions.snooze);
    expect(snoozed.status).toBe(200);
    expect((await jsonOf<{ snoozed_until: string }>(snoozed)).snoozed_until).toBeTruthy();
    // Tampering with any part of the link breaks it.
    const q = new URL(actions.done).searchParams;
    const other = await jsonOf<Habit>(await api("/v1/habits", { token, json: { name: "Other" } }));
    const swapped = `${BASE}/v1/habits/${other.id}/action?a=done&u=${q.get("u")}&d=${q.get("d")}&e=${q.get("e")}&s=${q.get("s")}`;
    expect((await post(swapped)).status).toBe(403);
    const expired = Math.floor(Date.now() / 1000) - 10;
    const stale = await sign(ctx, me.userId, h.id, "done", day, expired);
    const old = `${BASE}/v1/habits/${h.id}/action?a=done&u=${me.userId}&d=${day}&e=${expired}&s=${stale}`;
    expect((await post(old)).status).toBe(403);
    const otherAction = `${BASE}/v1/habits/${h.id}/action?a=delete&u=${q.get("u")}&d=${q.get("d")}&e=${q.get("e")}&s=${q.get("s")}`;
    expect((await post(otherAction)).status).toBe(403);

    expect(await jsonOf(await post(actions.done))).toEqual({ done: true });
    expect((await post(actions.done)).status).toBe(200); // idempotent
    const mine = await jsonOf<Habit[]>(await api("/v1/habits", { token }));
    const row = mine.find((x) => x.id === h.id);
    expect(row?.today.done).toBe(true);
    expect(row?.snoozed_until).toBeNull();

    // An archived habit takes no actions.
    await api(`/v1/habits/${h.id}/archive`, { token, method: "POST" });
    expect((await post(actions.snooze)).status).toBe(404);
  });
});

describe("habit route budgets", () => {
  it("reads cost one round trip and day writes two", async () => {
    const { token } = await person();
    const created = await api("/v1/habits", { token, json: { template_id: "water" } });
    // The very first game write creates the default chain (read, ensure, read again, write).
    expectRoundTrips(created, 4);
    const h = await jsonOf<Habit>(created);
    const second = await api("/v1/habits", { token, json: { name: "Walk", days_mask: 0b11111 } });
    expect(second.status).toBe(201);
    expectRoundTrips(second, 2);
    expectRoundTrips(await api("/v1/habits", { token }), 1);
    expectRoundTrips(await api(`/v1/habits/${h.id}`, { token }), 1);
    expectRoundTrips(await api(`/v1/habits/${h.id}/stats`, { token }), 1);
    const day = await api(`/v1/habits/${h.id}/days/${TODAY()}`, {
      token,
      method: "PUT",
      json: { amount: 3 },
    });
    expect(day.status).toBe(200);
    expectRoundTrips(day, 2);
    expectRoundTrips(await api(`/v1/habits/${h.id}/days/${TODAY()}/add`, { token, json: { amount: 1 } }), 2);
    const bulk = await api(`/v1/habits/${h.id}/days`, {
      token,
      method: "PUT",
      json: { days: [1, 2, 3].map((i) => ({ date: addDays(TODAY(), -i), amount: 6 })) },
    });
    expect((await jsonOf<Habit>(bulk)).streak).toBeTruthy();
    expectRoundTrips(bulk, 2);
    expectRoundTrips(await api(`/v1/habits/${h.id}/snooze`, { token, json: { minutes: 30 } }), 1);
    expectRoundTrips(await api(`/v1/habits/${h.id}/snooze`, { token, method: "DELETE" }), 1);
    expectRoundTrips(await api("/v1/habits/order", { token, method: "PUT", json: { ids: [h.id] } }), 1);
    expectRoundTrips(await api("/v1/habit-routines", { token }), 1);
    expectRoundTrips(await api("/v1/journal", { token }), 1);
    expectRoundTrips(await api("/v1/insights", { token }), 1);
  });

  it("lists and logs on the heavy user in one read and one write", async () => {
    const data = await seedHeavyUser({ years: 2, workouts: 300 });
    const userId = data.users[0]?.id as string;
    const { db } = testDb();
    const sessionId = uuid7();
    const now = Date.now();
    await db.insert(sessions).values({ id: sessionId, userId, createdAt: now, expiresAt: now + 86_400_000 });
    const principal = { userId, sessionId, tokenVersion: 0 };

    const read = jobCtx();
    const list = await habits.list(read, authedBatch(read.db, principal), false);
    expect(list).toHaveLength(20);
    expect(read.stats.roundTrips).toBe(1);

    const hid = list[0]?.id as string;
    await habits.setDay(jobCtx(), authedBatch(jobCtx().db, principal), hid, TODAY(), { amount: 1 });
    const w = jobCtx();
    await habits.setDay(w, authedBatch(w.db, principal), hid, TODAY(), { amount: 2 });
    expect(w.stats.roundTrips).toBe(2);

    const i = jobCtx();
    await insights.insights(i, authedBatch(i.db, principal));
    expect(i.stats.roundTrips).toBe(1);
  }, 120_000);
});

describe("habit privacy in the game", () => {
  it("the snapshot's habit view carries no name, amount or note", async () => {
    const me = await person();
    const h = await jsonOf<Habit>(
      await api("/v1/habits", { token: me.token, json: { name: "Secret thing" } }),
    );
    await api(`/v1/habits/${h.id}/days/${TODAY()}`, {
      token: me.token,
      method: "PUT",
      json: { amount: 1, note: "private words" },
    });
    const snap = await game.snapshotFor(jobCtx(), me.userId);
    expect(snap.habits).toHaveLength(1);
    const text = JSON.stringify(snap.habits);
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("private words");
    expect(Object.keys(snap.habits[0] ?? {}).sort()).toEqual(
      ["bestCleanRun", "category", "chain", "doneDays", "kind", "startedOn", "weeklyTarget"].sort(),
    );
  });
});

describe("habit edge cases", () => {
  it("validates input like pydantic and keeps NOT NULL columns on PATCH null", async () => {
    const { token } = await person();
    // Emoji length is counted in code points: a flag is 2, so 4 flags fit in 8.
    const flags = "🇬🇧🇫🇷🇩🇪🇮🇹";
    const ok = await api("/v1/habits", { token, json: { name: "Travel", emoji: flags } });
    expect(ok.status).toBe(201);
    const h = await jsonOf<Habit>(ok);
    const long = await api("/v1/habits", { token, json: { name: "x".repeat(61) } });
    expect(long.status).toBe(422);
    const body = await jsonOf<{ detail: { type: string; loc: unknown[] }[] }>(long);
    expect(body.detail[0]?.type).toBe("string_too_long");
    expect(body.detail[0]?.loc).toEqual(["body", "name"]);
    expect((await api("/v1/habits", { token, json: { name: "   " } })).status).toBe(422);
    expect((await api("/v1/habits", { token, json: { template_id: "nope" } })).status).toBe(404);

    const patched = await jsonOf<Habit>(
      await api(`/v1/habits/${h.id}`, {
        token,
        method: "PATCH",
        json: { emoji: null, time_of_day: null, weekly_target: null, category: null, name: "  Trips  " },
      }),
    );
    expect(patched.emoji).toBe(flags);
    expect(patched.time_of_day).toBe("anytime");
    expect(patched.weekly_target).toBe(7);
    expect(patched.name).toBe("Trips");
    expect((await api(`/v1/habits/${h.id}`, { token, method: "PATCH", json: { kind: null } })).status).toBe(
      422,
    );
  });

  it("bulk days refuses duplicates and clears without losing notes", async () => {
    const { token } = await person();
    const h = await jsonOf<Habit>(await api("/v1/habits", { token, json: { name: "Run" } }));
    const t = TODAY();
    const bulk = (days: unknown) => api(`/v1/habits/${h.id}/days`, { token, method: "PUT", json: { days } });
    const dup = await bulk([
      { date: t, amount: 1 },
      { date: t, amount: 1 },
    ]);
    expect(dup.status).toBe(422);
    expect((await jsonOf<{ detail: string }>(dup)).detail).toBe(`${t} appears twice`);
    await api(`/v1/habits/${h.id}/days/${t}`, { token, method: "PUT", json: { amount: 1, note: "keep" } });
    const cleared = await jsonOf<Habit>(await bulk([{ date: t, amount: 0 }]));
    expect(cleared.today).toEqual({ amount: 0, done: false });
    const rows = await testDb().db.select().from(habitLogs).where(eq(habitLogs.habitId, h.id));
    expect(rows.map((r) => [r.amount, r.note])).toEqual([[0, "keep"]]);
  });

  it("delete puts the habit and its logs in the trash", async () => {
    const { token } = await person();
    const h = await jsonOf<Habit>(await api("/v1/habits", { token, json: { name: "Gone" } }));
    await api(`/v1/habits/${h.id}/days/${TODAY()}`, { token, method: "PUT", json: { amount: 1 } });
    const { trash_id } = await jsonOf<{ trash_id: string }>(
      await api(`/v1/habits/${h.id}`, { token, method: "DELETE" }),
    );
    const [item] = await testDb().db.select().from(trashItems).where(eq(trashItems.id, trash_id));
    expect(item?.label).toBe("✨ Gone");
    expect(item?.payload.row?.id).toBe(h.id);
    expect(item?.payload.children?.habit_logs).toHaveLength(1);
    expect((await api(`/v1/habits/${h.id}`, { token })).status).toBe(404);
    expect(await jsonOf(await api("/v1/habits", { token }))).toEqual([]);
  });

  it("caps live habits at 30", async () => {
    const { token } = await person();
    for (let i = 0; i < 30; i++)
      expect((await api("/v1/habits", { token, json: { name: `H${i}` } })).status).toBe(201);
    const over = await api("/v1/habits", { token, json: { name: "One more" } });
    expect(over.status).toBe(409);
  }, 60_000);

  it("import refuses a bad zip and needs a file", async () => {
    const { token } = await person();
    const send = (form: FormData) =>
      SELF.fetch(`${BASE}/v1/habits/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": randomIp() },
        body: form,
      });
    const zip = new FormData();
    zip.append("file", new Blob(["PKnot really a zip"]), "x.zip");
    const bad = await send(zip);
    expect(bad.status).toBe(422);
    expect((await jsonOf<{ detail: string }>(bad)).detail).toBe("That zip file can't be opened");
    const none = new FormData();
    none.append("dry_run", "true");
    expect((await send(none)).status).toBe(422);
  });

  it("journal delete goes to the trash and is idempotent", async () => {
    const { token } = await person();
    const day = TODAY();
    await api(`/v1/journal/${day}`, { token, method: "PUT", json: { mood: 3, note: "  Café visit " } });
    const found = await jsonOf<{ note: string }[]>(await api("/v1/journal?q=cafe", { token }));
    expect(found[0]?.note).toBe("Café visit");
    const del = await jsonOf<{ trash_id: string | null }>(
      await api(`/v1/journal/${day}`, { token, method: "DELETE" }),
    );
    expect(del.trash_id).toBeTruthy();
    expect(await jsonOf(await api(`/v1/journal/${day}`, { token, method: "DELETE" }))).toEqual({
      trash_id: null,
    });
  });

  it("routines cap at ten and update in place", async () => {
    const { token } = await person();
    const a = (await jsonOf<Habit>(await api("/v1/habits", { token, json: { name: "A" } }))).id;
    const made = await jsonOf<{ id: string }>(
      await api("/v1/habit-routines", { token, json: { name: "Am", habit_ids: [a] } }),
    );
    const put = await api(`/v1/habit-routines/${made.id}`, {
      token,
      method: "PUT",
      json: { name: "  Evening ", time_of_day: "evening", habit_ids: [a] },
    });
    expect(await jsonOf(put)).toEqual({
      id: made.id,
      name: "Evening",
      emoji: "🌅",
      time_of_day: "evening",
      habit_ids: [a],
    });
    for (let i = 0; i < 9; i++)
      await api("/v1/habit-routines", { token, json: { name: `R${i}`, habit_ids: [a] } });
    const over = await api("/v1/habit-routines", { token, json: { name: "R10", habit_ids: [a] } });
    expect(over.status).toBe(409);
  });
});
