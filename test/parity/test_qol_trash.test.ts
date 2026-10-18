/** Port of tests/test_qol.py, the trash cases (the workout undo case sits in test_features_training.test.ts). */
import { describe, expect, it } from "vitest";
import { person } from "../fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "../fixtures/http.ts";
import { type Json, put, workout } from "../fixtures/training.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Trash = {
  id: string;
  kind: string;
  item_id: string;
  label: string;
  deleted_at: string;
  purge_after: string;
};

const call = (token: string, path: string, method = "GET", json?: unknown) =>
  api(path, { token, method, ...(json === undefined ? {} : { json }) });
const getJson = async <T = Json>(token: string, path: string) => jsonOf<T>(await call(token, path));
const trashOf = (token: string) => getJson<Trash[]>(token, "/v1/trash");

describe("test_qol (trash)", () => {
  it("deleted_habit_comes_back_with_its_history", async () => {
    const { token } = await person();
    const habit = await jsonOf<Json>(
      await call(token, "/v1/habits", "POST", { name: "Read", cue: "After dinner" }),
    );
    const days = [0, 1, 2].map(daysAgo);
    for (const d of days)
      await call(token, `/v1/habits/${habit.id}/days/${d}`, "PUT", { amount: 1, note: `n${d}` });
    const gone = await call(token, `/v1/habits/${habit.id}`, "DELETE");
    expect(gone.status).toBe(200);
    expect((await jsonOf<Json>(gone)).trash_id).toBeTruthy();
    expect(await getJson(token, "/v1/habits")).toEqual([]);

    const listed = await call(token, "/v1/trash");
    expectRoundTrips(listed, 1);
    const trash = await jsonOf<Trash[]>(listed);
    expect(trash.map((t) => t.kind)).toEqual(["habit"]);
    expect(trash[0]?.label).toContain("Read");
    const tid = trash[0]?.id ?? "";
    const other = await person();
    expect(await trashOf(other.token)).toEqual([]);
    expect((await call(other.token, `/v1/trash/${tid}/restore`, "POST")).status).toBe(404);

    const restored = await call(token, `/v1/trash/${tid}/restore`, "POST");
    expect(restored.status).toBe(200);
    expectRoundTrips(restored, 3);
    expect(await jsonOf(restored)).toEqual({ kind: "habit", item_id: habit.id });
    const back = await getJson(token, `/v1/habits/${habit.id}?days=10`);
    expect(back.cue).toBe("After dinner");
    expect(back.days.map((d: Json) => d.date).sort()).toEqual([...days].sort());
    expect(await trashOf(token)).toEqual([]);
    // The streak engine counted the history again: the restored days are done.
    expect(back.days.every((d: Json) => d.amount === 1)).toBe(true);
  });

  it("meal_food_recipe_journal_and_routine_restore", async () => {
    const { token } = await person();
    const day = TODAY;
    const food = await jsonOf<Json>(
      await call(token, "/v1/nutrition/foods", "POST", { name: "Oats", kcal: 150 }),
    );
    const eid = crypto.randomUUID();
    await call(token, `/v1/nutrition/entries/${eid}`, "PUT", {
      date: day,
      meal: "breakfast",
      food_id: food.id,
    });
    const recipe = await jsonOf<Json>(
      await call(token, "/v1/nutrition/recipes", "POST", { name: "Porridge", items: [{ food_id: food.id }] }),
    );
    await call(token, `/v1/journal/${day}`, "PUT", { mood: 4, note: "good" });
    const a = await jsonOf<Json>(await call(token, "/v1/habits", "POST", { name: "Water" }));
    const routine = await jsonOf<Json>(
      await call(token, "/v1/habit-routines", "POST", { name: "AM", habit_ids: [a.id] }),
    );

    const del = async (path: string) => (await jsonOf<Json>(await call(token, path, "DELETE"))).trash_id;
    const ids = [
      await del(`/v1/nutrition/entries/${eid}`),
      await del(`/v1/nutrition/foods/${food.id}`),
      await del(`/v1/nutrition/recipes/${recipe.id}`),
      await del(`/v1/journal/${day}`),
      await del(`/v1/habit-routines/${routine.id}`),
    ];
    expect(await jsonOf(await call(token, `/v1/nutrition/entries/${eid}`, "DELETE"))).toEqual({
      trash_id: null,
    });
    expect(await jsonOf(await call(token, `/v1/journal/${day}`, "DELETE"))).toEqual({ trash_id: null });
    expect(new Set((await trashOf(token)).map((t) => t.kind))).toEqual(
      new Set(["meal", "food", "recipe", "journal", "habit_routine"]),
    );
    // Food first, so the restored meal points at it again.
    for (const tid of [ids[1], ids[0], ids[2], ids[3], ids[4]]) {
      const res = await call(token, `/v1/trash/${tid}/restore`, "POST");
      expect(res.status, tid).toBe(200);
      expectRoundTrips(res, 2);
    }
    const entries = (await getJson(token, `/v1/nutrition/days/${day}`)).entries;
    expect(entries[0].food_id).toBe(food.id);
    expect(entries[0].kcal).toBe(150);
    expect((await getJson(token, "/v1/journal"))[0].note).toBe("good");
    expect((await getJson(token, "/v1/habit-routines"))[0].habit_ids).toEqual([a.id]);
    // A restored food keeps its id, and its name is searchable again (the fold column is rebuilt).
    const found = await getJson(token, "/v1/nutrition/foods?q=oat");
    expect(found.map((f: Json) => f.id)).toEqual([food.id]);
  });

  it("restore_refuses_a_clash_and_changes_nothing", async () => {
    const { token } = await person();
    const day = TODAY;
    await call(token, `/v1/journal/${day}`, "PUT", { mood: 2, note: "old" });
    const tid = (await jsonOf<Json>(await call(token, `/v1/journal/${day}`, "DELETE"))).trash_id;
    await call(token, `/v1/journal/${day}`, "PUT", { mood: 5, note: "new" });
    const res = await call(token, `/v1/trash/${tid}/restore`, "POST");
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ detail: "Something already exists in its place" });
    expect((await getJson(token, "/v1/journal"))[0].note).toBe("new");
    expect(await trashOf(token)).toHaveLength(1);
    const gone = await call(token, `/v1/trash/${tid}`, "DELETE");
    expect(gone.status).toBe(204);
    expectRoundTrips(gone, 1);
    expect(await trashOf(token)).toEqual([]);
  });

  it("deleted_workout_restores_and_syncs", async () => {
    const { token } = await person();
    const wid = crypto.randomUUID();
    expect((await put(token, wid, workout())).status).toBe(200);
    const live = await getJson(token, "/v1/me/stats");
    await call(token, `/v1/workouts/${wid}`, "DELETE");
    expect(await getJson(token, "/v1/me/stats")).not.toEqual(live);
    await call(token, `/v1/workouts/${wid}`, "DELETE"); // twice: one trash entry
    const trash = await trashOf(token);
    expect(trash.map((t) => t.kind)).toEqual(["workout"]);
    const before = await getJson(token, "/v1/workouts/changes?since=0");
    const res = await call(token, `/v1/trash/${trash[0]?.id}/restore`, "POST");
    expect(res.status).toBe(200);
    expectRoundTrips(res, 3);
    const after = await getJson(token, `/v1/workouts/changes?since=${before.cursor}`);
    const restored = after.workouts.filter((w: Json) => w.id === wid);
    expect(restored.length).toBeGreaterThan(0);
    expect(restored[0].deleted_at).toBeNull();
    // Aggregates refreshed and the projection recomputed: the stats are what they were before the delete.
    expect(await getJson(token, "/v1/me/stats")).toEqual(live);
    expect(await trashOf(token)).toEqual([]);
  });
});
