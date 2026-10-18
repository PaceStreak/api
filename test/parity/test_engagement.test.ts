/**
 * Port of tests/test_engagement.py: quests, PR streaks, wagers, the monthly recap and similar boards.
 * Workouts go through the game fixture's write path (test/fixtures/game.ts) until the TRAINING unit lands.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { QUEST_BY_ID, QUEST_POOL, QUESTS_PER_WEEK, questsFor } from "../../src/catalog/quests.ts";
import { exerciseNotes, gyms, workouts } from "../../src/db/schema/index.ts";
import { addDays } from "../../src/lib/time.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import {
  computePrStreak,
  computeQuests,
  progressOf,
  weekFacts,
} from "../../src/modules/game/engine/quests.ts";
import { computeChain, FREEZE_CAP } from "../../src/modules/game/engine/streak.ts";
import { testDb } from "../fixtures/db.ts";
import { person, putWorkout, setProfile } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person as onboarded, upload } from "../fixtures/profile.ts";

// Still owned by other units (missing until they port them): test_gyms_carry_equipment_and_plates_and_stay_private,
// test_exercise_notes_stick_to_the_exercise, test_weight_goal_starts_from_the_trend_and_is_private (TRAINING);
// test_favourite_disciplines_round_trip, test_export_and_import_carry_gyms_notes_goal (PROFILE-ACCOUNT).

const MON = "2026-09-07";
const fixed = (t: number) => () => t;
const quest = (id: string) => {
  const q = QUEST_BY_ID.get(id);
  if (q === undefined) throw new Error(id);
  return q;
};

type Stats = {
  wager: { options: { week: string; week_start: string; days: number; blocked: string | null }[] };
  quests: { items: unknown[] } | null;
  pr_streak: Record<string, unknown>;
};

describe("test_engagement", () => {
  it("a_kept_wager_earns_a_freeze_and_a_lost_one_costs_nothing", () => {
    const wk = [0, 1, 2].map((i) => addDays(MON, 7 * i));
    const w0 = wk[0] as string;
    const kept = [0, 1, 2, 3].map((d) => addDays(w0, d));
    const today = addDays(wk[1] as string, 1);
    const won = computeChain(kept, today, 0, fixed(3), { wagers: new Map([[w0, 4]]) });
    expect(won.wagersWon).toEqual([w0]);
    expect(won.freezesAvailable).toBe(1);

    const lost = computeChain(kept.slice(0, 3), today, 0, fixed(3), { wagers: new Map([[w0, 4]]) });
    expect(lost.wagersWon).toEqual([]);
    expect(lost.freezesAvailable).toBe(0);
    expect(lost.weeks[0]?.status).toBe("kept");

    const many = [0, 1, 2].flatMap((i) => [0, 1, 2, 3].map((d) => addDays(w0, 7 * i + d)));
    const capped = computeChain(many, addDays(wk[2] as string, 22), 0, fixed(3), {
      wagers: new Map(wk.map((w) => [w, 4])),
    });
    expect(capped.freezesAvailable).toBeLessThanOrEqual(FREEZE_CAP);
  });

  it("quests_are_the_same_three_for_everyone_and_weigh_ins_need_history", () => {
    const picks = questsFor(MON, true);
    expect(picks).toHaveLength(QUESTS_PER_WEEK);
    expect(new Set(picks.map((q) => q.id)).size).toBe(QUESTS_PER_WEEK);
    expect(questsFor(MON, true)).toEqual(picks);
    for (let i = 0; i < 20; i++)
      expect(questsFor(addDays(MON, 7 * i), false).map((q) => q.id)).not.toContain("morning_weigh");
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) for (const q of questsFor(addDays(MON, 7 * i), true, true)) seen.add(q.id);
    expect(seen).toEqual(new Set(QUEST_POOL.map((q) => q.id)));
  });

  it("quest_progress_reads_the_week", () => {
    const facts = weekFacts({
      activeDays: new Set([addDays(MON, 1)]),
      patterns: new Set(["push_h", "pull_v", "squat"]),
      rpeSets: 9,
      shortSessions: 1,
      wakingWeighDays: 4,
    });
    expect(progressOf(quest("early_week"), facts, MON)).toBe(1);
    expect(progressOf(quest("balanced"), facts, MON)).toBe(3);
    expect(progressOf(quest("rpe"), facts, MON)).toBe(9);
    expect(progressOf(quest("morning_weigh"), facts, MON)).toBe(4);
    const late = weekFacts({ activeDays: new Set([addDays(MON, 5)]) });
    expect(progressOf(quest("early_week"), late, MON)).toBe(0);
  });

  it("paused_weeks_offer_no_quests", () => {
    const out = computeQuests([MON, addDays(MON, 7)], () => weekFacts(), null, new Set([MON]));
    expect(out.map((q) => q.weekStart)).toEqual([addDays(MON, 7)]);
  });

  it("pr_streak_counts_blocks_and_the_open_block_never_breaks_it", () => {
    const block = (i: number, d = 0) => addDays("2024-01-01", 28 * i + d);
    const prs = [block(10, 3), block(11, 20), block(12, 1)];
    let s = computePrStreak(prs, block(13, 2));
    expect([s.current, s.longest, s.thisBlockHasPr]).toEqual([3, 3, false]);
    s = computePrStreak(prs, block(14, 0));
    expect(s.current).toBe(0);
    expect(s.longest).toBe(3);
  });

  it("wager_rules", async () => {
    const me = await person();
    const state = (await jsonOf<Stats>(await api("/v1/me/stats", { token: me.token }))).wager;
    const [thisOpt, nextOpt] = state.options;
    expect(thisOpt?.blocked).toBeNull();
    expect(thisOpt?.days).toBe(4); // default target 3, plus one
    const made = await api("/v1/me/wager", { token: me.token, json: { week: "this" } });
    expect(made.status).toBe(201);
    expect((await jsonOf<{ current: { status: string } }>(made)).current.status).toBe("open");
    // One a calendar month.
    const second = await api("/v1/me/wager", { token: me.token, json: { week: "next" } });
    const sameMonth = thisOpt?.week_start.slice(0, 7) === nextOpt?.week_start.slice(0, 7);
    expect(second.status).toBe(sameMonth ? 409 : 201);
    // Can be taken back until the week's first session...
    const del = await api(`/v1/me/wager/${thisOpt?.week_start}`, { token: me.token, method: "DELETE" });
    expect(del.status).toBe(204);
    // ...and can't be made once the week has started.
    await putWorkout(me.userId);
    const again = await api("/v1/me/wager", { token: me.token, json: { week: "this" } });
    expect(again.status).toBe(409);
  });

  it("stats_carry_quests_and_pr_streak_unless_gamification_is_off", async () => {
    const me = await person();
    await putWorkout(me.userId);
    const stats = await jsonOf<Stats>(await api("/v1/me/stats", { token: me.token }));
    expect(stats.quests?.items).toHaveLength(3);
    expect(Object.keys(stats.pr_streak)).toEqual(expect.arrayContaining(["current", "longest"]));
    await setProfile(me.userId, { gamificationEnabled: false });
    const off = await jsonOf<Stats>(await api("/v1/me/stats", { token: me.token }));
    expect(off.quests).toBeNull();
  });

  it("monthly_recap_compares_with_your_own_history", async () => {
    const me = await person();
    const now = Date.now();
    await putWorkout(me.userId, { startedAt: now - 20 * 86_400_000 });
    await putWorkout(me.userId, {
      sets: [
        { exercise_id: "back-squat", weight_kg: 110, reps: 5, rpe: 8 },
        { exercise_id: "back-squat", weight_kg: 110, reps: 5 },
      ],
    });
    const month = new Date(now).toISOString().slice(0, 7);
    const recap = await api(`/v1/me/recap/month?month=${month}`, { token: me.token });
    expect(recap.status).toBe(200);
    const text = await recap.text();
    const body = JSON.parse(text) as { lifts: { name: string }[] };
    expect(body.lifts[0]?.name).toBe("Back squat");
    expect(text).not.toContain("tonnage");
    expect(text).not.toContain("volume");
    expect((await api("/v1/me/recap/month?month=2099-01", { token: me.token })).status).toBe(422);
    expect((await api("/v1/me/recap/month?month=2001-01", { token: me.token })).status).toBe(404);
  });

  it("similar_board_pairs_people_who_train_about_as_often", async () => {
    const a = await person({ handle: `similara${Date.now() % 100000}` });
    const b = await person({ handle: `similarb${Date.now() % 100000}` });
    for (const p of [a, b]) {
      await setProfile(p.userId, { leaderboardOptIn: true });
      // Python created user_stats through the onboarding request's snapshot; here a recompute does.
      await putWorkout(p.userId, { sets: [] });
    }
    const rows = await api("/v1/leaderboards/streak?scope=similar", { token: a.token });
    expect(rows.status).toBe(200);
    const handles = new Set((await jsonOf<{ rows: { handle: string }[] }>(rows)).rows.map((r) => r.handle));
    expect(handles.has(a.handle) && handles.has(b.handle)).toBe(true);
  });

  it("favourite_disciplines_round_trip", async () => {
    const { token } = await onboarded();
    const fav = async () =>
      (await jsonOf<{ profile: { favourite_disciplines: string[] } }>(await api("/v1/me", { token }))).profile
        .favourite_disciplines;
    expect(await fav()).toEqual([]);
    const res = await api("/v1/me/profile", {
      token,
      method: "PATCH",
      json: { favourite_disciplines: ["running", "climbing"] },
    });
    expect(res.status).toBe(200);
    expect(
      (await jsonOf<{ profile: { favourite_disciplines: string[] } }>(res)).profile.favourite_disciplines,
    ).toEqual(["running", "climbing"]);
    // Persists across requests, not just echoed back.
    expect(await fav()).toEqual(["running", "climbing"]);
  });

  it("export_and_import_carry_gyms_notes_goal", async () => {
    // Gyms, sessions and notes are seeded in D1 until TRAINING lands their routes.
    const me = await onboarded();
    const { db } = testDb();
    const now = Date.now();
    const gym = uuid7(now);
    await db
      .insert(gyms)
      .values({ id: gym, userId: me.userId, name: "Home", createdAt: now, updatedAt: now });
    const w = await putWorkout(me.userId);
    await db.update(workouts).set({ gymId: gym }).where(eq(workouts.id, w.id));
    await db.insert(exerciseNotes).values({
      id: uuid7(now),
      userId: me.userId,
      exerciseId: "back-squat",
      note: "Belt on",
      createdAt: now,
      updatedAt: now,
    });
    const data = await jsonOf<{
      gyms: { name: string }[];
      exercise_notes: unknown[];
      workouts: { gym_id: string }[];
    }>(await api("/v1/me/export?format=json", { token: me.token }));
    expect(data.gyms[0]?.name).toBe("Home");
    expect(data.exercise_notes).toEqual([{ exercise_id: "back-squat", note: "Belt on" }]);
    expect(data.workouts[0]?.gym_id).toBe(gym);

    const other = await onboarded();
    expect((await upload("/v1/me/import", other.token, JSON.stringify(data))).status).toBe(200);
    const theirGyms = await db.select().from(gyms).where(eq(gyms.userId, other.userId));
    expect(theirGyms.map((g) => g.name)).toEqual(["Home"]);
    expect(theirGyms[0]?.id).not.toBe(gym);
    const theirs = await db.select().from(workouts).where(eq(workouts.userId, other.userId));
    expect(theirs[0]?.gymId).toBe(theirGyms[0]?.id);
    const notes = await db.select().from(exerciseNotes).where(eq(exerciseNotes.userId, other.userId));
    expect(Object.fromEntries(notes.map((n) => [n.exerciseId, n.note]))).toEqual({ "back-squat": "Belt on" });
  });
});
