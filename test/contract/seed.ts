/**
 * One account with something in every corner the golden endpoints read: a workout, habits with days, a weigh-in,
 * body metrics, food, a recipe, journal, readiness, a reflection, a gym, gear, a routine, a plan, a chain, a pause,
 * and a coaching group and challenge shared with a second person who follows back.
 */
import { expect } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { type Json, logSession, workout } from "../fixtures/training.ts";

export interface Seeded {
  token: string;
  other: string;
  handle: string;
  otherHandle: string;
  today: string;
  ids: Record<string, string>;
}

export async function seedContract(): Promise<Seeded> {
  const me = await person();
  const friend = await person();
  const token = me.token;
  const today = new Date().toISOString().slice(0, 10);
  const ids: Record<string, string> = {};
  const call = async (method: string, path: string, json?: unknown, as = token): Promise<Json> => {
    const res = await api(path, { method, token: as, ...(json === undefined ? {} : { json }) });
    expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBeLessThan(300);
    return res.status === 204 ? null : jsonOf(res);
  };

  await call("POST", `/v1/people/${friend.handle}/follow`);
  await call("POST", `/v1/people/${me.handle}/follow`, undefined, friend.token);

  const wid = crypto.randomUUID();
  ids.workout = wid;
  await call("PUT", `/v1/workouts/${wid}`, workout({ title: "Squats" }));
  await logSession(token, { title: "Easy run" });
  await logSession(friend.token, { title: "Friend run" });

  const habit = await call("POST", "/v1/habits", { name: "Stretch", emoji: "🧘" });
  ids.habit = habit.id;
  await call("PUT", `/v1/habits/${habit.id}/days/${today}`, { amount: 1, note: "felt good" });
  await call("PUT", `/v1/habits/${habit.id}/days/${addDays(today, -1)}`, { amount: 1 });
  const water = await call("POST", "/v1/habits", { template_id: "water" });
  await call("PUT", `/v1/habits/${water.id}/days/${today}`, { amount: 3 });
  const routine = await call("POST", "/v1/habit-routines", {
    name: "Morning",
    habit_ids: [habit.id, water.id],
  });
  ids.habitRoutine = routine.id;

  await call("PUT", `/v1/weigh-ins/${crypto.randomUUID()}`, {
    weighed_at: new Date().toISOString(),
    moment: "waking",
    weight_kg: 80.5,
  });
  await call("PUT", `/v1/body-metrics/${today}`, { waist_cm: 82, sleep_hours: 7.5, resting_hr: 55 });
  await call("PUT", "/v1/weight-goal", { target_kg: 75 });
  await call("PUT", `/v1/readiness/${today}`, { sleep: 3, energy: 4, soreness: 1 });
  await call("PUT", `/v1/journal/${today}`, { mood: 4, note: "Good day at the café" });

  const oats = await call("POST", "/v1/nutrition/foods", {
    name: "Oats",
    serving_label: "40 g",
    kcal: 150,
    protein_g: 5,
    carbs_g: 27,
    fat_g: 3,
  });
  ids.food = oats.id;
  await call("PUT", `/v1/nutrition/entries/${crypto.randomUUID()}`, {
    date: today,
    meal: "breakfast",
    food_id: oats.id,
    servings: 2,
  });
  await call("PUT", `/v1/nutrition/entries/${crypto.randomUUID()}`, {
    date: today,
    meal: "snack",
    name: "Banana",
    kcal: 105,
    carbs_g: 27,
  });
  await call("PUT", "/v1/nutrition/target", { kcal: 2400, protein_g: 150, carbs_g: null, fat_g: null });
  const recipe = await call("POST", "/v1/nutrition/recipes", {
    name: "Porridge",
    items: [{ food_id: oats.id }],
  });
  ids.recipe = recipe.id;

  const gym = await call("POST", "/v1/gyms", {
    name: "Garage",
    equipment: ["barbell", "dumbbell"],
    plates_kg: [5, 10, 20],
  });
  ids.gym = gym.id;
  await call("POST", "/v1/gear", { name: "Trail shoes", kind: "shoes", default_for: ["run"], limit_km: 700 });
  const r = await call("POST", "/v1/routines", {
    name: "Squat day",
    discipline: "strength",
    items: [{ exercise_id: "back-squat", sets: 5, reps_min: 5, reps_max: 5, weight_kg: 60 }],
  });
  ids.routine = r.id;
  const plan = await call("POST", "/v1/plans", { template_id: "plan-strength-foundations" });
  ids.plan = plan.id;
  await call("POST", "/v1/chains", { name: "Running", disciplines: ["run"], target: 2 });
  await call("POST", "/v1/pauses", {
    starts_on: addDays(today, 30),
    ends_on: addDays(today, 33),
    reason: "travel",
  });
  await call("POST", "/v1/exercises/custom", {
    name: "Sled push",
    pattern: "carry",
    equipment: "machine",
    primary: ["quads"],
  });

  const group = await call("POST", "/v1/groups", { name: "Crew", kind: "coaching" });
  ids.group = group.id;
  await call("POST", "/v1/groups/join", { code: group.invite_code }, friend.token);
  await call("PATCH", `/v1/groups/${group.id}/me`, { shares_with_coach: true }, friend.token);
  const challenge = await call("POST", "/v1/challenges", {
    title: "Seven days",
    starts_on: today,
    ends_on: addDays(today, 6),
    target: 3,
  });
  ids.challenge = challenge.id;
  await call("POST", "/v1/challenges/join", { code: challenge.invite_code }, friend.token);

  const feed = await call("GET", "/v1/feed", undefined, token);
  const event = (feed.events as Json[]).find((e) => e.mine === false) ?? feed.events[0];
  ids.event = event.id;
  await call("POST", `/v1/events/${event.id}/comments`, { body: "Nice one" });
  await call("POST", `/v1/events/${event.id}/kudos`, { reaction: "fire" });

  // Something in the trash.
  const gone = await call("POST", "/v1/habits", { name: "Floss" });
  await call("DELETE", `/v1/habits/${gone.id}`);

  return { token, other: friend.token, handle: me.handle, otherHandle: friend.handle, today, ids };
}
