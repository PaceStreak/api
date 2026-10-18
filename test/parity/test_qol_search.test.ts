/** The search half of tests/test_qol.py: /v1/search and /v1/day/{day}, both private to the owner. */
import { describe, expect, it } from "vitest";
import { api, expectRoundTrips, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";
import { get, type Json, put, workout } from "../fixtures/training.ts";

const TODAY = () => new Date().toISOString().slice(0, 10);
const send = (token: string, method: string, path: string, json: unknown) =>
  api(path, { token, method, json });

describe("test_qol (search)", () => {
  it("search_finds_everything_escapes_wildcards_and_is_private", async () => {
    const { token } = await person("searcher");
    const habit = await jsonOf<Json>(
      await send(token, "POST", "/v1/habits", { name: "Guitar practice", cue: "after coffee" }),
    );
    await send(token, "PUT", `/v1/habits/${habit.id}/days/${TODAY()}`, {
      amount: 1,
      note: "learned a barre chord",
    });
    await send(token, "PUT", `/v1/journal/${TODAY()}`, { note: "felt 100% today" });
    await put(token, crypto.randomUUID(), workout({ title: "Hill repeats" }));
    await send(token, "POST", "/v1/nutrition/foods", { name: "Greek yoghurt", brand: "Fage", kcal: 97 });

    const kinds = async (q: string, t = token) => {
      const res = await api(`/v1/search?q=${q}`, { token: t });
      expectRoundTrips(res, 1);
      return new Set(((await jsonOf<Json>(res)).results as Json[]).map((r) => r.kind));
    };
    expect(await kinds("guitar")).toEqual(new Set(["habit"]));
    expect(await kinds("barre")).toEqual(new Set(["habit_note"]));
    expect(await kinds("hill")).toEqual(new Set(["workout"]));
    expect(await kinds("fage")).toEqual(new Set(["food"]));
    expect(await kinds("100%25")).toEqual(new Set(["journal"])); // "100%" literally
    expect(await kinds("1_0")).toEqual(new Set()); // _ is not a wildcard
    const other = await person("searcher2");
    expect(await kinds("guitar", other.token)).toEqual(new Set());
    expect((await api("/v1/search?q=a", { token })).status).toBe(422);
  });

  it("day_view_gathers_one_date", async () => {
    const { token } = await person("dayer");
    const day = TODAY();
    const habit = await jsonOf<Json>(
      await send(token, "POST", "/v1/habits", { name: "Water", kind: "count", daily_goal: 8 }),
    );
    await send(token, "PUT", `/v1/habits/${habit.id}/days/${day}`, { amount: 8 });
    await send(token, "PUT", `/v1/nutrition/entries/${crypto.randomUUID()}`, {
      date: day,
      meal: "lunch",
      name: "Soup",
      kcal: 300,
      protein_g: 12,
    });
    await send(token, "PUT", `/v1/journal/${day}`, { mood: 4 });
    await put(token, crypto.randomUUID(), workout());
    const res = await api(`/v1/day/${day}`, { token });
    expectRoundTrips(res, 1);
    const got = await jsonOf<Json>(res);
    expect(got.habits[0].done).toBe(true);
    expect(got.food.kcal).toBe(300);
    expect(got.journal.mood).toBe(4);
    expect(got.workouts.length).toBe(1);
    const other = await person("dayer2");
    const empty = await get(other.token, `/v1/day/${day}`);
    expect(empty.habits).toEqual([]);
    expect(empty.workouts).toEqual([]);
    expect(empty.journal).toBeNull();
  });
});
