/**
 * Nutrition and the coach beyond the ported pytest cases: D1 round-trip budgets for every route, limits, the
 * barcode cache, recent ranking, copy chunking, the coach's rules and that it never names a habit.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBatch, type Stmt } from "../src/db/batch.ts";
import { foods, mealEntries, recipes, trashItems } from "../src/db/schema/index.ts";
import { addDays } from "../src/lib/time.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import type { ChainResult } from "../src/modules/game/service.ts";
import { foodNotes, habitNotes, readinessNotes, streakNotes } from "../src/modules/nutrition/coach.ts";
import { parseProduct } from "../src/modules/nutrition/lookup.ts";
import { MAX_FOODS, MAX_RECIPES } from "../src/modules/nutrition/service.ts";
import { testDb } from "./fixtures/db.ts";
import { mockFetch } from "./fixtures/fetch.ts";
import { person } from "./fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = any;
const uuid = () => crypto.randomUUID();
const TODAY = () => new Date().toISOString().slice(0, 10);
const digits = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String(b % 10)).join("");
const OFF = /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\//;

async function call(token: string, path: string, rt: number, init: { method?: string; json?: unknown } = {}) {
  const res = await api(path, { token, ...init });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBeLessThan(400);
  expectRoundTrips(res, rt);
  return jsonOf<Json>(res);
}

describe("nutrition round trips", () => {
  it("every route stays within its D1 budget", async () => {
    const { token } = await person();
    const day = TODAY();
    const food = await call(token, "/v1/nutrition/foods", 1, { json: { name: "Oats", kcal: 150 } });
    await call(token, `/v1/nutrition/foods/${food.id}`, 1, {
      method: "PUT",
      json: { name: "Oats", kcal: 160 },
    });
    const recipe = await call(token, "/v1/nutrition/recipes", 2, {
      json: { name: "Porridge", items: [{ food_id: food.id }] },
    });
    await call(token, `/v1/nutrition/recipes/${recipe.id}`, 2, {
      method: "PUT",
      json: { name: "Porridge", serves: 2, items: [{ food_id: food.id, servings: 3 }] },
    });
    const eid = uuid();
    await call(token, `/v1/nutrition/entries/${eid}`, 2, {
      method: "PUT",
      json: { date: day, meal: "breakfast", recipe_id: recipe.id },
    });
    await call(token, "/v1/nutrition/copy", 2, { json: { from_date: day, to_date: day } });
    await call(token, "/v1/nutrition/target", 1, { method: "PUT", json: { kcal: 2000 } });
    await call(token, "/v1/nutrition/target", 1);
    await call(token, `/v1/nutrition/days/${day}`, 1);
    await call(token, "/v1/nutrition/history?days=7", 1);
    await call(token, "/v1/nutrition/recent", 1);
    await call(token, "/v1/nutrition/foods?q=oat", 1);
    await call(token, "/v1/nutrition/recipes", 1);
    await call(token, "/v1/nutrition/expenditure", 1);
    // The first snapshot creates the default chain (a write and a re-read); after that it is one read.
    await call(token, "/v1/coach/today", 3);
    await call(token, "/v1/coach/today", 1);
    await call(token, `/v1/nutrition/entries/${eid}`, 2, { method: "DELETE" });
    await call(token, `/v1/nutrition/recipes/${recipe.id}`, 2, { method: "DELETE" });
    await call(token, `/v1/nutrition/foods/${food.id}`, 2, { method: "DELETE" });
    await call(token, "/v1/nutrition/target", 1, { method: "PUT", json: {} });
  });
});

describe("nutrition behaviour", () => {
  it("deletes go to the trash, and deleting an entry twice is a no-op", async () => {
    const me = await person();
    const eid = uuid();
    await api(`/v1/nutrition/entries/${eid}`, {
      method: "PUT",
      token: me.token,
      json: { date: TODAY(), meal: "lunch", name: "Soup", kcal: 300 },
    });
    const first = await jsonOf<Json>(
      await api(`/v1/nutrition/entries/${eid}`, { method: "DELETE", token: me.token }),
    );
    expect(first.trash_id).toBeTruthy();
    const again = await jsonOf<Json>(
      await api(`/v1/nutrition/entries/${eid}`, { method: "DELETE", token: me.token }),
    );
    expect(again.trash_id).toBeNull();
    const [row] = await testDb()
      .db.select()
      .from(trashItems)
      .where(and(eq(trashItems.userId, me.userId), eq(trashItems.itemId, eid)));
    expect(row?.kind).toBe("meal");
    expect(row?.label).toBe("Soup");
  });

  it("foods: barcode clash on update, other people's foods are 404, blank names are 422", async () => {
    const me = await person();
    const other = await person();
    const a = await jsonOf<Json>(
      await api("/v1/nutrition/foods", {
        token: me.token,
        json: { name: "A", kcal: 1, barcode: "12345678" },
      }),
    );
    const b = await jsonOf<Json>(
      await api("/v1/nutrition/foods", { token: me.token, json: { name: "B", kcal: 1 } }),
    );
    const clash = await api(`/v1/nutrition/foods/${b.id}`, {
      method: "PUT",
      token: me.token,
      json: { name: "B", kcal: 1, barcode: "12345678" },
    });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ detail: "That barcode is already saved" });
    // Keeping its own barcode is fine.
    const same = await api(`/v1/nutrition/foods/${a.id}`, {
      method: "PUT",
      token: me.token,
      json: { name: "  A2 ", kcal: 2, barcode: "12345678" },
    });
    expect((await jsonOf<Json>(same)).name).toBe("A2");
    // Another person may save the same barcode.
    expect(
      (
        await api("/v1/nutrition/foods", {
          token: other.token,
          json: { name: "A", kcal: 1, barcode: "12345678" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api(`/v1/nutrition/foods/${a.id}`, {
          method: "PUT",
          token: other.token,
          json: { name: "x", kcal: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await api(`/v1/nutrition/foods/${a.id}`, { method: "DELETE", token: other.token })).status).toBe(
      404,
    );
    expect(
      (await api("/v1/nutrition/foods", { token: me.token, json: { name: "   ", kcal: 1 } })).status,
    ).toBe(422);
    const listed = await jsonOf<Json[]>(await api("/v1/nutrition/foods?q=a%", { token: me.token }));
    expect(listed.map((f) => f.name)).toEqual(["A2"]);
  });

  it("the food and recipe limits are 409", async () => {
    const me = await person();
    const { db } = testDb();
    const now = Date.now();
    const stmts: Stmt[] = [];
    for (let i = 0; i < MAX_FOODS; i += 7) {
      const rows = Array.from({ length: Math.min(7, MAX_FOODS - i) }, (_, j) => ({
        id: uuid7(now),
        userId: me.userId,
        name: `F${i + j}`,
        nameFold: `f${i + j}`,
        kcal: 1,
        createdAt: now,
        updatedAt: now,
      }));
      stmts.push(db.insert(foods).values(rows));
    }
    for (let i = 0; i < MAX_RECIPES; i += 7) {
      const rows = Array.from({ length: Math.min(7, MAX_RECIPES - i) }, () => ({
        id: uuid7(now),
        userId: me.userId,
        name: "R",
        nameFold: "r",
        items: [],
        kcal: 1,
        createdAt: now,
        updatedAt: now,
      }));
      stmts.push(db.insert(recipes).values(rows));
    }
    await runBatch(db, stmts as [Stmt, ...Stmt[]]);
    const food = await api("/v1/nutrition/foods", { token: me.token, json: { name: "One more", kcal: 1 } });
    expect(food.status).toBe(409);
    expect(await food.json()).toEqual({ detail: "500 saved foods is the limit" });
    const [first] = await db.select().from(foods).where(eq(foods.userId, me.userId)).limit(1);
    const recipe = await api("/v1/nutrition/recipes", {
      token: me.token,
      json: { name: "One more", items: [{ food_id: first?.id }] },
    });
    expect(recipe.status).toBe(409);
    expect(await recipe.json()).toEqual({ detail: "200 recipes is the limit" });
  });

  it("recent ranks by count, ties by recency, per serving", async () => {
    const me = await person();
    const day = TODAY();
    const log = (name: string, kcal: number, servings = 1) =>
      api(`/v1/nutrition/entries/${uuid()}`, {
        method: "PUT",
        token: me.token,
        json: { date: day, meal: "snack", name, kcal, servings },
      });
    await log("Apple", 50);
    await log("Pear", 60);
    await log("Apple", 100, 2);
    await log("Kiwi", 40);
    const got = await jsonOf<Json[]>(await api("/v1/nutrition/recent", { token: me.token }));
    expect(got.map((r) => [r.name, r.times, r.kcal])).toEqual([
      ["Apple", 2, 50],
      ["Kiwi", 1, 40],
      ["Pear", 1, 60],
    ]);
  });

  it("copy keeps order across insert chunks and the target day is range-checked", async () => {
    const me = await person();
    const day = TODAY();
    const from = addDays(day, -1);
    for (let i = 0; i < 10; i++)
      await api(`/v1/nutrition/entries/${uuid()}`, {
        method: "PUT",
        token: me.token,
        json: { date: from, meal: "snack", name: `S${i}`, kcal: i },
      });
    const res = await api("/v1/nutrition/copy", { token: me.token, json: { from_date: from, to_date: day } });
    expect(res.status).toBe(201);
    expect((await jsonOf<Json[]>(res)).map((e) => e.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `S${i}`),
    );
    const shown = await jsonOf<Json>(await api(`/v1/nutrition/days/${day}`, { token: me.token }));
    expect(shown.entries.map((e: Json) => e.name)).toEqual(Array.from({ length: 10 }, (_, i) => `S${i}`));
    const old = await api("/v1/nutrition/copy", {
      token: me.token,
      json: { from_date: from, to_date: addDays(day, -61) },
    });
    expect(await old.json()).toEqual({ detail: "Meals can be backdated up to 60 days" });
    const rows = await testDb().db.select().from(mealEntries).where(eq(mealEntries.userId, me.userId));
    expect(rows).toHaveLength(20);
  });

  it("barcode answers are cached: the second lookup does not leave the server", async () => {
    const me = await person();
    const code = digits(13);
    const off = mockFetch(OFF, () =>
      Response.json({ status: 1, product: { product_name: "Tea", nutriments: { "energy-kcal_100g": 1 } } }),
    );
    expect(
      (await jsonOf<Json>(await api(`/v1/nutrition/barcode/${code}`, { token: me.token }))).food.name,
    ).toBe("Tea");
    const key = new Request(`https://food-lookup.cache.pacestreak.internal/${code}`);
    const cache = (caches as unknown as { default: Cache }).default;
    for (let i = 0; i < 100 && (await cache.match(key)) === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    const again = await api(`/v1/nutrition/barcode/${code}`, { token: me.token });
    expect((await jsonOf<Json>(again)).food).toMatchObject({
      name: "Tea",
      barcode: code,
      serving_label: "100 g",
    });
    expect(off.calls).toHaveLength(1);
  });

  it("parse_product handles serving labels and odd values like Python", () => {
    expect(
      parseProduct({
        product_name: " Gum ",
        serving_quantity: "1.5",
        nutriments: { "energy-kcal_serving": "5" },
      }),
    ).toEqual({
      name: "Gum",
      brand: null,
      serving_label: "1.5 g",
      kcal: 5,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
    });
    // Negative and non-numeric values are dropped; a non-string name is no name (Python crashed with a 500).
    expect(parseProduct({ product_name: "X", nutriments: { "energy-kcal_100g": -1 } })).toBeNull();
    expect(parseProduct({ product_name: 7, nutriments: { "energy-kcal_100g": 1 } })).toBeNull();
    expect(parseProduct({ product_name: "Y", nutriments: { "energy-kcal_100g": "abc" } })).toBeNull();
  });

  it("expenditure from logged meals and weigh-ins", async () => {
    const me = await person();
    const { db } = testDb();
    const today = TODAY();
    const end = addDays(today, -1);
    const now = Date.now();
    const meals = Array.from({ length: 28 }, (_, i) => ({
      id: uuid7(now),
      userId: me.userId,
      day: addDays(end, -i),
      meal: "lunch" as const,
      name: "Food",
      kcal: 2000,
      createdAt: now,
      updatedAt: now,
    }));
    const stmts: Stmt[] = [];
    for (let i = 0; i < meals.length; i += 7)
      stmts.push(db.insert(mealEntries).values(meals.slice(i, i + 7)));
    await runBatch(db, stmts as [Stmt, ...Stmt[]]);
    for (let i = 0; i < 28; i += 2) {
      const d = addDays(end, -i);
      await api(`/v1/weigh-ins/${uuid()}`, {
        method: "PUT",
        token: me.token,
        json: { weighed_at: `${d}T07:00:00Z`, moment: "waking", weight_kg: 80 + (i * 0.5) / 7 },
      });
    }
    await api("/v1/weight-goal", { method: "PUT", token: me.token, json: { target_kg: 70 } });
    const got = await jsonOf<Json>(await api("/v1/nutrition/expenditure", { token: me.token }));
    expect(got).toMatchObject({
      window_days: 28,
      status: "ok",
      food_days: 28,
      weigh_days: 14,
      confidence: "good",
    });
    expect(Math.abs(got.tdee - 2550)).toBeLessThanOrEqual(5);
    expect(got.suggestion.goal).toBe("lose");
  });
});

describe("coach", () => {
  const chain = (over: Partial<ChainResult>) => ({
    chain: { name: "" },
    result: {
      needed: 2,
      daysLeft: 3,
      thisWeekDays: 1,
      thisWeekTarget: 3,
      atRisk: false,
      pausedNow: false,
      ...over,
    } as ChainResult,
  });

  it("streak notes: kept, at risk, on pace (no 'mores'), idle", () => {
    const today = "2026-10-18";
    expect(streakNotes([chain({ needed: 0, thisWeekDays: 3 })], today, today)[0]?.title).toBe(
      "Your streak: week kept",
    );
    expect(streakNotes([chain({ atRisk: true, needed: 1, daysLeft: 1 })], today, null)[0]?.body).toBe(
      "1 more session with 1 day left. Today is the day that keeps the week.",
    );
    expect(streakNotes([chain({})], today, null)[0]?.body).toBe("2 more to go, 3 days to do it.");
    expect(streakNotes([chain({ pausedNow: true })], today, "2026-10-10").map((n) => n.kind)).toEqual([
      "idle",
    ]);
  });

  it("readiness and food notes follow the Python rules", () => {
    expect(readinessNotes({ sleep: 3, energy: 2, soreness: 5 })[0]?.title).toBe("Low on energy: go easy");
    expect(readinessNotes({ sleep: 4, energy: 5, soreness: 1 })[0]?.kind).toBe("go_hard");
    expect(readinessNotes({ sleep: 3, energy: 3, soreness: 3 })).toEqual([]);
    expect(foodNotes({ kcal: 2000, protein_g: 150 }, undefined)).toEqual([]);
    expect(foodNotes({ kcal: 2000.5, protein_g: 150 }, { kcal: 2000, proteinG: 140 })[0]?.body).toBe(
      "2000.5 kcal, 150 g protein.",
    );
    expect(
      foodNotes({ kcal: 3000, protein_g: 100 }, { kcal: 2000, proteinG: 150 }).map((n) => n.kind),
    ).toEqual(["protein_low", "kcal_high"]);
    expect(
      foodNotes({ kcal: 1000, protein_g: 0 }, { kcal: 2000, proteinG: null }).map((n) => n.kind),
    ).toEqual(["kcal_low"]);
  });

  it("counts habits and never names them", async () => {
    const me = await person();
    const secret = "Stop drinking whisky";
    await api("/v1/habits", { token: me.token, json: { name: secret, weekly_target: 7 } });
    const res = await api("/v1/coach/today", { token: me.token });
    const text = await res.text();
    expect(text).not.toContain("whisky");
    const notes = (JSON.parse(text) as Json).notes;
    expect(notes.some((n: Json) => n.kind === "habits_open" || n.kind === "habits_at_risk")).toBe(true);
    expect(habitNotes([])).toEqual([]);
  });
});
