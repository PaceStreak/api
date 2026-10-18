/** Port of tests/test_qol.py (notification and backup cases; trash, habits and search belong to their units). */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { habits, notifications } from "../../src/db/schema/index.ts";
import { listZip, readZipEntry } from "../../src/heavy/zip.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { exportAttachment } from "../../src/modules/account/service.ts";
import { signup } from "../fixtures/auth.ts";
import { testDb } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person, upload } from "../fixtures/profile.ts";
import { jobCtx, runFor } from "../jobs/helpers.ts";

describe("test_qol", () => {
  it("preference_updates_merge_instead_of_resetting", async () => {
    const { token } = await signup();
    const put = (json: unknown) => api("/v1/notifications/preferences", { token, method: "PUT", json });
    await put({ channels: { digest: { email: false } } });
    const got = await jsonOf<{ categories: { id: string; email: boolean }[] }>(
      await put({ channels: { backup: { email: true } } }),
    );
    const cats = new Map(got.categories.map((c) => [c.id, c]));
    expect(cats.get("backup")?.email).toBe(true);
    expect(cats.get("digest")?.email).toBe(false); // untouched by the second update
    expect(cats.get("security")?.email).toBe(true); // locked
  });

  it("backup_attachment_is_opt_in_and_round_trips", async () => {
    const me = await person();
    const now = Date.now();
    await testDb()
      .db.insert(habits)
      .values({
        id: uuid7(now),
        userId: me.userId,
        name: "Private habit",
        nameFold: "private habit",
        startedOn: "2026-01-01",
        createdAt: now,
        updatedAt: now,
      });
    const prefs = await jsonOf<{ backup_attachment: boolean }>(
      await api("/v1/notifications/preferences", { token: me.token }),
    );
    expect(prefs.backup_attachment).toBe(false);
    const got = await jsonOf<{ backup_attachment: boolean }>(
      await api("/v1/notifications/preferences", {
        token: me.token,
        method: "PUT",
        json: { backup_attachment: true, channels: { backup: { email: true } } },
      }),
    );
    expect(got.backup_attachment).toBe(true);
    // The attachment the deliver consumer adds (registered as the notifications module's provider).
    const att = await exportAttachment(jobCtx(), me.userId);
    expect(att?.filename.endsWith(".zip")).toBe(true);
    expect(att?.mime).toBe("application/zip");
    const zip = att?.data ?? new Uint8Array();
    const [entry] = listZip(zip);
    const data = JSON.parse(
      new TextDecoder().decode(readZipEntry(zip, entry?.name ?? "", 1 << 24, () => new Error("too big"))),
    );
    expect(data.habits[0].name).toBe("Private habit");
    // The attachment is the export, so it imports straight back.
    const other = await person();
    expect((await upload("/v1/me/import", other.token, JSON.stringify(data))).status).toBe(200);
  });

  it("backup_falls_back_to_a_link_when_too_big", async () => {
    const me = await person();
    expect(await exportAttachment(jobCtx(), me.userId, 10)).toBeNull();
  });
});

describe("test_qol: habit reminders", () => {
  const TODAY = () => new Date().toISOString().slice(0, 10);
  const expireSnooze = (habitId: string) =>
    testDb()
      .db.update(habits)
      .set({ snoozedUntil: Date.now() - 60_000 })
      .where(eq(habits.id, habitId));

  it("snooze_reminds_once_unless_done", async () => {
    const me = await person();
    const habit = await jsonOf<{ id: string }>(
      await api("/v1/habits", { token: me.token, json: { name: "Walk" } }),
    );
    const snooze = (minutes: number) =>
      api(`/v1/habits/${habit.id}/snooze`, { token: me.token, json: { minutes } });
    expect((await snooze(5)).status).toBe(422);
    expect((await snooze(60)).status).toBe(200);
    expect(await runFor("habit_snoozes", me.userId)).toEqual([]); // not due yet
    await expireSnooze(habit.id);
    expect(await runFor("habit_snoozes", me.userId)).toHaveLength(1);
    expect(await runFor("habit_snoozes", me.userId)).toEqual([]); // cleared after firing

    await snooze(60);
    await api(`/v1/habits/${habit.id}/days/${TODAY()}`, {
      token: me.token,
      method: "PUT",
      json: { amount: 1 },
    });
    await expireSnooze(habit.id);
    expect(await runFor("habit_snoozes", me.userId)).toEqual([]); // done in the meantime
  });

  it("summary_replaces_per_habit_reminders_and_names_nothing", async () => {
    const me = await person();
    const hour = new Date().getUTCHours();
    for (const name of ["Secret habit", "Another"])
      await api("/v1/habits", { token: me.token, json: { name, remind_hour: hour } });
    const put = (json: unknown) =>
      api("/v1/notifications/preferences", { token: me.token, method: "PUT", json });
    const prefs = await put({ habit_summary_hour: hour });
    expect(prefs.status).toBe(200);
    const body = await jsonOf<{ habit_summary_hour: number | null; categories: unknown[] }>(prefs);
    expect(body.habit_summary_hour).toBe(hour);
    // Channels survive a summary-only update.
    expect(body.categories.length).toBeGreaterThan(0);
    expect(await runFor("habits", me.userId)).toEqual([]);
    const [nid] = await runFor("habit_summary", me.userId);
    const [note] = await testDb()
      .db.select()
      .from(notifications)
      .where(eq(notifications.id, nid ?? ""));
    expect(note?.title).toBe("2 habits still open today");
    expect(note?.body ?? "").not.toContain("Secret");
    expect(await runFor("habit_summary", me.userId)).toEqual([]); // once a day
    const off = await jsonOf<{ habit_summary_hour: number | null }>(await put({ habit_summary_hour: null }));
    expect(off.habit_summary_hour).toBeNull();
  });
});
