/**
 * Port of tests/test_habits_life.py: the export/import case (PROFILE-ACCOUNT). The habit is seeded in D1 until
 * HABITS lands its routes, which also port the rest of this file.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { habitLogs, habits } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { testDb } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person, upload } from "../fixtures/profile.ts";

describe("test_habits_life", () => {
  it("habits_export_and_import", async () => {
    const me = await person();
    const { db } = testDb();
    const now = Date.now();
    const id = uuid7(now);
    const today = new Date(now).toISOString().slice(0, 10);
    await db.insert(habits).values({
      id,
      userId: me.userId,
      name: "Drink water",
      nameFold: "drink water",
      emoji: "💧",
      kind: "count",
      unit: "glasses",
      dailyGoal: 8,
      templateId: "water",
      startedOn: today,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(habitLogs).values({
      id: uuid7(now),
      habitId: id,
      userId: me.userId,
      day: today,
      amount: 6,
      note: "hot day",
      createdAt: now,
      updatedAt: now,
    });
    const data = await jsonOf<{ habits: { days: unknown[] }[] }>(
      await api("/v1/me/export?format=json", { token: me.token }),
    );
    expect(data.habits[0]?.days).toEqual([{ date: today, amount: 6, note: "hot day" }]);
    const other = await person();
    for (let i = 0; i < 2; i++) {
      // twice: no duplicates
      expect((await upload("/v1/me/import", other.token, JSON.stringify(data))).status).toBe(200);
    }
    const mine = await db.select().from(habits).where(eq(habits.userId, other.userId));
    expect(mine).toHaveLength(1);
    const logs = await db.select().from(habitLogs).where(eq(habitLogs.userId, other.userId));
    expect(logs.map((l) => [l.day, l.amount])).toEqual([[today, 6]]);
  });
});
