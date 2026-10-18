/**
 * Port of tests/test_habits_life.py: the engine, XP caps, quests, the API, privacy and the whole-life streak.
 * Workouts and profile changes go through the game fixtures until TRAINING and PROFILE-ACCOUNT land.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HABIT_TEMPLATES } from "../../src/catalog/habit-templates.ts";
import { QUEST_BY_ID, questsFor } from "../../src/catalog/quests.ts";
import { activityEvents, habitLogs, habits, notifications, trashItems } from "../../src/db/schema/index.ts";
import { addDays, weekStart } from "../../src/lib/time.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { progressOf, weekFacts } from "../../src/modules/game/engine/quests.ts";
import { HABIT_DAY_CAP, HABIT_DAY_XP, habitXp } from "../../src/modules/game/engine/xp.ts";
import { doneDays, type HabitDay, type HabitView, viewHabit } from "../../src/modules/habits/engine.ts";
import { testDb } from "../fixtures/db.ts";
import { person, putWorkout, setProfile } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person as profilePerson, upload } from "../fixtures/profile.ts";
import { runFor } from "../jobs/helpers.ts";

const MON = "2026-09-07";
const days = (...offsets: number[]): HabitDay[] => offsets.map((o) => ({ day: addDays(MON, o), amount: 1 }));
const today = () => new Date().toISOString().slice(0, 10);

const view = (o: Partial<Parameters<typeof viewHabit>[0]> & { logs: HabitDay[]; today: string }) =>
  viewHabit({
    kind: "check",
    dailyGoal: null,
    weeklyTarget: 7,
    startedOn: MON,
    weekStartsOn: 0,
    pausedDays: new Set(),
    ...o,
  });

const xpInput = (kind: string, weeklyTarget: number, v: HabitView) => ({
  kind,
  weeklyTarget,
  doneDays: [...v.doneDays].sort(),
  cells: v.chain.weeks,
});

type Habit = Record<string, unknown> & { id: string };

describe("test_habits_life", () => {
  // --- engine

  it("done_days_by_kind", () => {
    const logs = [
      { day: MON, amount: 5 },
      { day: addDays(MON, 1), amount: 12 },
    ];
    const t = addDays(MON, 3);
    expect(doneDays("count", 10, logs, MON, t)).toEqual(new Set([addDays(MON, 1)]));
    expect(doneDays("check", null, logs, MON, t)).toEqual(new Set([MON, addDays(MON, 1)]));
    // Quit: every day since the start is clean unless a slip is logged.
    expect(doneDays("quit", null, [{ day: addDays(MON, 1), amount: 1 }], MON, t)).toEqual(
      new Set([MON, addDays(MON, 2), addDays(MON, 3)]),
    );
  });

  it("habit_streak_is_week_based_and_rest_days_are_free", () => {
    const v = view({ weeklyTarget: 3, logs: days(0, 2, 4, 7, 9, 11), today: addDays(MON, 15) });
    expect(v.chain.current).toBe(2);
    expect(v.chain.weeks.at(-1)?.status).toBe("open");
    // The open week can't count against it before it's over.
    expect(v.strength).toBe(100);
  });

  it("strength_dents_rather_than_resets", () => {
    const weekly = (skip: Set<number>) =>
      view({
        logs: Array.from({ length: 70 }, (_, d) => d)
          .filter((d) => !skip.has(Math.floor(d / 7)))
          .map((d) => ({ day: addDays(MON, d), amount: 1 })),
        today: addDays(MON, 70),
      }).strength;
    const steady = weekly(new Set());
    const dented = weekly(new Set([9])); // the last closed week missed entirely
    expect(steady).toBe(100);
    expect(dented).toBeGreaterThanOrEqual(60);
    expect(dented).toBeLessThan(steady);
  });

  it("quit_habit_clean_runs", () => {
    const v = view({ kind: "quit", logs: [{ day: addDays(MON, 5), amount: 2 }], today: addDays(MON, 12) });
    expect(v.cleanRun).toBe(7);
    expect(v.bestCleanRun).toBe(7);
    expect(v.lastSlip).toBe(addDays(MON, 5));
  });

  // --- XP and quests

  it("habit_xp_is_capped_per_habit_week_and_per_day", () => {
    const t = addDays(MON, 20);
    const v = (ds: number[], target = 7) => view({ weeklyTarget: target, logs: days(...ds), today: t });
    // Ten habits all done on the same day: the day pays the cap, not 10x.
    const many = Array.from({ length: 10 }, () => xpInput("check", 7, v([0])));
    const dayItems = habitXp(many, 0, t).filter((i) => i.source === "habit_day");
    expect(dayItems.map((i) => i.amount)).toEqual([HABIT_DAY_CAP]);
    // A 2-a-week habit done daily pays for two days a week only.
    const twice = [xpInput("check", 2, v([0, 1, 2, 3, 4, 5, 6], 2))];
    const paid = habitXp(twice, 0, t)
      .filter((i) => i.source === "habit_day")
      .reduce((n, i) => n + i.amount, 0);
    expect(paid).toBe(2 * HABIT_DAY_XP);
    // A habit being broken pays for kept weeks, never for each clean day.
    const quitView = view({ kind: "quit", logs: [], today: t });
    const quitItems = habitXp([xpInput("quit", 7, quitView)], 0, t);
    expect(new Set(quitItems.map((i) => i.source))).toEqual(new Set(["habit_week"]));
  });

  it("habit_quest_only_for_people_with_habits", () => {
    for (let i = 0; i < 20; i++)
      expect(questsFor(addDays(MON, 7 * i), true, false).map((q) => q.id)).not.toContain("habit_week");
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) for (const q of questsFor(addDays(MON, 7 * i), true, true)) seen.add(q.id);
    expect(seen.has("habit_week")).toBe(true);
    const q = QUEST_BY_ID.get("habit_week");
    if (q === undefined) throw new Error("habit_week");
    expect(progressOf(q, weekFacts({ habitsKept: 3, habitsTotal: 3 }), MON)).toBe(1);
    expect(progressOf(q, weekFacts({ habitsKept: 2, habitsTotal: 3 }), MON)).toBe(0);
    expect(progressOf(q, weekFacts(), MON)).toBe(0);
  });

  it("catalog_has_no_restrictive_eating_templates", () => {
    const text = HABIT_TEMPLATES.map((t) => `${t.id} ${t.name} ${t.blurb}`.toLowerCase()).join(" ");
    for (const banned of ["calorie", "fasting", "skip meal", "weight loss", "diet"])
      expect(text).not.toContain(banned);
    expect(HABIT_TEMPLATES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(HABIT_TEMPLATES.map((t) => t.id)).size).toBe(HABIT_TEMPLATES.length);
  });

  // --- API

  it("habit_lifecycle", async () => {
    const { token } = await person();
    const catalog = await jsonOf<{ categories: Record<string, string> }>(await api("/v1/habits/catalog"));
    for (const c of ["learning", "mind", "break"]) expect(catalog.categories).toHaveProperty(c);

    const read = await jsonOf<Habit>(await api("/v1/habits", { token, json: { template_id: "read" } }));
    expect([read.kind, read.unit, read.daily_goal]).toEqual(["count", "pages", 10]);
    const custom = await jsonOf<Habit>(
      await api("/v1/habits", {
        token,
        json: {
          name: "Guitar scales",
          kind: "duration",
          daily_goal: 15,
          weekly_target: 5,
          category: "learning",
          total_goal: 6000,
          cue: "After dinner",
        },
      }),
    );
    expect(custom.unit).toBe("minutes");
    expect((await api("/v1/habits", { token, json: {} })).status).toBe(422);
    expect((await api("/v1/habits", { token, json: { name: "x", category: "nope" } })).status).toBe(422);

    const t = today();
    // Several small adds make a day.
    let r: Response | null = null;
    for (let i = 0; i < 2; i++)
      r = await api(`/v1/habits/${read.id}/days/${t}/add`, { token, json: { amount: 5 } });
    expect((await jsonOf<Habit>(r as Response)).today).toEqual({ amount: 10, done: true });
    // Yesterday can be filled in, and cleared again.
    const yesterday = addDays(t, -1);
    const filled = await api(`/v1/habits/${read.id}/days/${yesterday}`, {
      token,
      method: "PUT",
      json: { amount: 12 },
    });
    expect(filled.status).toBe(200);
    const detail = await jsonOf<{ days: unknown[]; weeks: unknown[] }>(
      await api(`/v1/habits/${read.id}`, { token }),
    );
    expect(detail.days).toHaveLength(2);
    expect(detail.weeks.length).toBeGreaterThan(0);
    await api(`/v1/habits/${read.id}/days/${yesterday}`, { token, method: "PUT", json: { amount: 0 } });
    expect(
      (await jsonOf<{ days: unknown[] }>(await api(`/v1/habits/${read.id}`, { token }))).days,
    ).toHaveLength(1);
    // Too far back, or in the future, is refused.
    const put = (day: string) =>
      api(`/v1/habits/${read.id}/days/${day}`, { token, method: "PUT", json: { amount: 1 } });
    expect((await put(addDays(t, -90))).status).toBe(422);
    expect((await put(addDays(t, 2))).status).toBe(422);

    // The kind can't change; other fields can, and can be cleared.
    const patch = (json: unknown) => api(`/v1/habits/${custom.id}`, { token, method: "PATCH", json });
    expect((await patch({ kind: "check" })).status).toBe(422);
    const patched = await jsonOf<Habit>(await patch({ cue: null, weekly_target: 3 }));
    expect(patched.cue).toBeNull();
    expect(patched.weekly_target).toBe(3);

    // Archive hides it but keeps history; delete removes it.
    await api(`/v1/habits/${custom.id}/archive`, { token, method: "POST" });
    expect((await jsonOf<Habit[]>(await api("/v1/habits", { token }))).map((x) => x.id)).toEqual([read.id]);
    expect(await jsonOf<Habit[]>(await api("/v1/habits?archived=true", { token }))).toHaveLength(2);
    const deleted = await api(`/v1/habits/${custom.id}`, { token, method: "DELETE" });
    expect(deleted.status).toBe(200);
    const { trash_id } = await jsonOf<{ trash_id: string }>(deleted);
    expect(trash_id).toBeTruthy();
    const [trash] = await testDb().db.select().from(trashItems).where(eq(trashItems.id, trash_id));
    expect(trash?.kind).toBe("habit");
    expect(trash?.itemId).toBe(custom.id);

    const other = await person();
    expect((await api(`/v1/habits/${read.id}`, { token: other.token })).status).toBe(404);
    const foreign = await api(`/v1/habits/${read.id}/days/${t}`, {
      token: other.token,
      method: "PUT",
      json: { amount: 1 },
    });
    expect(foreign.status).toBe(404);

    const stats = await jsonOf<{ habits: unknown; xp: { by_source: Record<string, number> } }>(
      await api("/v1/me/stats", { token }),
    );
    expect(stats.habits).toEqual({ count: 1, done_today: 1, kept_this_week: 0 });
    expect(stats.xp.by_source.habit_day ?? 0).toBeGreaterThan(0);
  });

  it("habit_stats_counts_kept_weeks_and_keep_rate", async () => {
    const { token } = await person();
    const h = await jsonOf<Habit>(
      await api("/v1/habits", { token, json: { name: "Journal", kind: "check", weekly_target: 1 } }),
    );
    const t = today();
    const thisWeek = weekStart(t, 0);
    const oneAgo = addDays(thisWeek, -7);
    const twoAgo = addDays(thisWeek, -14);
    const threeAgo = addDays(thisWeek, -21);
    for (const d of [threeAgo, oneAgo, t])
      await api(`/v1/habits/${h.id}/days/${d}`, { token, method: "PUT", json: { amount: 1 } });

    const stats = await jsonOf<{
      weeks: { week_start: string; status: string }[];
      weeks_counted: number;
      weeks_kept: number;
      keep_rate: number;
    }>(await api(`/v1/habits/${h.id}/stats?weeks=4`, { token }));
    expect(stats.weeks).toHaveLength(4);
    const byWeek = new Map(stats.weeks.map((w) => [w.week_start, w.status]));
    const counting = ["kept", "frozen", "repaired"];
    expect(counting).toContain(byWeek.get(threeAgo));
    expect(byWeek.get(twoAgo)).toBe("missed");
    expect(counting).toContain(byWeek.get(oneAgo));
    expect(counting).toContain(byWeek.get(thisWeek));
    expect(stats.weeks_counted).toBe(4);
    expect(stats.weeks_kept).toBe(3);
    expect(stats.keep_rate).toBe(75);

    const other = await person();
    expect((await api(`/v1/habits/${h.id}/stats`, { token: other.token })).status).toBe(404);
  });

  it("quit_habit_stays_private_and_badges_never_name_it", async () => {
    const me = await person();
    await setProfile(me.userId, { visibility: "public" });
    const token = me.token;
    const h = await jsonOf<Habit>(await api("/v1/habits", { token, json: { template_id: "no-smoking" } }));
    expect(h.kind).toBe("quit");
    expect(h.clean_run).toBe(1);
    const t = today();
    const slipped = await jsonOf<Habit>(
      await api(`/v1/habits/${h.id}/days/${t}`, { token, method: "PUT", json: { amount: 1 } }),
    );
    expect(slipped.clean_run).toBe(0);
    expect(slipped.last_slip).toBe(t);
    // Python read /v1/people/{handle} and /v1/feed (SOCIAL). Both are built from activity events, and badges and
    // notifications are what a recompute emits: none may name the habit.
    const { db } = testDb();
    const events = await db.select().from(activityEvents).where(eq(activityEvents.userId, me.userId));
    const notes = await db.select().from(notifications).where(eq(notifications.userId, me.userId));
    expect(JSON.stringify([events, notes]).toLowerCase()).not.toContain("smok");
  });

  it("habit_day_note_is_kept_unless_cleared", async () => {
    const { token } = await person();
    const h = await jsonOf<Habit>(await api("/v1/habits", { token, json: { name: "Meditate" } }));
    const t = today();
    const put = (day: string, json: unknown) =>
      api(`/v1/habits/${h.id}/days/${day}`, { token, method: "PUT", json });
    const detail = async () =>
      (
        await jsonOf<{ days: { date: string; amount: number; note: string | null }[] }>(
          await api(`/v1/habits/${h.id}`, { token }),
        )
      ).days;

    // A note can ride along with a tick.
    expect((await put(t, { amount: 1, note: "restless start" })).status).toBe(200);
    expect((await detail())[0]?.note).toBe("restless start");
    // A plain re-tick with no "note" key keeps the one already there.
    await put(t, { amount: 1 });
    expect((await detail())[0]?.note).toBe("restless start");
    // An explicit empty note clears it.
    await put(t, { amount: 1, note: "" });
    expect((await detail())[0]?.note).toBeNull();
    // A day can hold just a note with no amount: it's kept, not counted done.
    const yesterday = addDays(t, -1);
    await put(yesterday, { amount: 0, note: "sick, rested" });
    const byDay = new Map((await detail()).map((d) => [d.date, d]));
    expect(byDay.get(yesterday)?.note).toBe("sick, rested");
    expect(byDay.get(yesterday)?.amount).toBe(0);
    // Over the 280-character cap is rejected.
    expect((await put(t, { amount: 1, note: "x".repeat(281) })).status).toBe(422);
  });

  it("whole_life_streak_counts_training_or_any_habit", async () => {
    const me = await person();
    const token = me.token;
    expect((await jsonOf<{ life: unknown }>(await api("/v1/me/stats", { token }))).life).toBeNull();
    await setProfile(me.userId, { lifeTarget: 2 });
    const h = await jsonOf<Habit>(await api("/v1/habits", { token, json: { template_id: "journal" } }));
    await api(`/v1/habits/${h.id}/days/${today()}`, { token, method: "PUT", json: { amount: 1 } });
    await putWorkout(me.userId);
    const life = (
      await jsonOf<{ life: { target: number; this_week_days: number } }>(await api("/v1/me/stats", { token }))
    ).life;
    expect(life.target).toBe(2);
    expect(life.this_week_days).toBeGreaterThanOrEqual(1);
    await setProfile(me.userId, { leaderboardOptIn: true });
    expect((await api("/v1/leaderboards/life_streak?scope=global", { token })).status).toBe(200);
  });
});

describe("test_habits_life export", () => {
  it("habits_export_and_import", async () => {
    const me = await profilePerson();
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
    const other = await profilePerson();
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

describe("test_habits_life: reminders", () => {
  it("habit_reminder_fires_at_the_chosen_hour_until_done", async () => {
    const me = await profilePerson();
    const hour = new Date().getUTCHours();
    const post = (token: string, json: unknown) => api("/v1/habits", { token, json });
    const habit = await jsonOf<{ id: string; remind_hour: number }>(
      await post(me.token, { template_id: "meditate", remind_hour: hour }),
    );
    await post(me.token, { template_id: "no-vaping", remind_hour: hour });
    expect(await runFor("habits", me.userId)).toHaveLength(1); // the quit habit never reminds
    expect(await runFor("habits", me.userId)).toEqual([]); // once a day
    const other = await profilePerson();
    const done = await jsonOf<{ id: string }>(
      await post(other.token, { template_id: "meditate", remind_hour: hour }),
    );
    await api(`/v1/habits/${done.id}/days/${today()}`, {
      token: other.token,
      method: "PUT",
      json: { amount: 10 },
    });
    expect(await runFor("habits", other.userId)).toEqual([]);
    expect(habit.remind_hour).toBe(hour);
  });
});
