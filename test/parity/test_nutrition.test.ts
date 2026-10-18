/**
 * Port of tests/test_nutrition.py: meals, saved foods, the target, copy, barcode lookup and the coach. Python
 * monkeypatched `fetch`; here Open Food Facts itself is mocked (all outbound fetch is blocked in tests), and the
 * barcodes are random so the Cache API never answers for an earlier run.
 */
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { parseProduct } from "../../src/modules/nutrition/lookup.ts";
import { mockFetch } from "../fixtures/fetch.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = any;
const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const get = async (token: string, path: string): Promise<Json> => jsonOf(await api(path, { token }));
const put = (token: string, path: string, json: unknown) => api(path, { method: "PUT", json, token });
const digits = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String(b % 10)).join("");

const OFF = /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\//;
const codeOf = (req: Request) => new URL(req.url).pathname.split("/").pop()?.replace(".json", "") ?? "";

describe("test_nutrition", () => {
  it("meals_round_trip_with_totals_and_target", async () => {
    const me = await person();
    const h = me.token;
    const day = today();
    expect(
      (await jsonOf<Json>(await put(h, "/v1/nutrition/target", { kcal: 2400, protein_g: 160 }))).kcal,
    ).toBe(2400);
    const oats = await jsonOf<Json>(
      await api("/v1/nutrition/foods", {
        token: h,
        json: { name: "Oats", serving_label: "40 g", kcal: 150, protein_g: 5, carbs_g: 27 },
      }),
    );
    const eid = uuid();
    const body = { date: day, meal: "breakfast", food_id: oats.id, servings: 2 };
    // A retried save with the same client id updates rather than duplicates.
    for (let i = 0; i < 2; i++) expect((await put(h, `/v1/nutrition/entries/${eid}`, body)).status).toBe(200);
    const typed = { date: day, meal: "snack", name: "Banana", kcal: 105, carbs_g: 27 };
    expect((await put(h, `/v1/nutrition/entries/${uuid()}`, typed)).status).toBe(200);

    const got = await get(h, `/v1/nutrition/days/${day}`);
    expect(got.entries).toHaveLength(2);
    expect(got.totals).toEqual({ kcal: 405, protein_g: 10, carbs_g: 81, fat_g: 0 });
    expect(got.target.protein_g).toBe(160);
    expect((await get(h, "/v1/nutrition/history"))[0].kcal).toBe(405);
    expect(["Oats", "Banana"]).toContain((await get(h, "/v1/nutrition/recent"))[0].name);

    // Deleting the saved food keeps the logged numbers.
    const del = await jsonOf<Json>(
      await api(`/v1/nutrition/foods/${oats.id}`, { method: "DELETE", token: h }),
    );
    expect(del.trash_id).toBeTruthy();
    expect((await get(h, `/v1/nutrition/days/${day}`)).totals.kcal).toBe(405);

    const exported = await get(h, "/v1/me/export?format=json");
    expect(exported.meals).toHaveLength(2);
    expect(exported.nutrition_target.kcal).toBe(2400);
    const zip = await api("/v1/me/export?format=csv", { token: h });
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(new TextDecoder().decode(files["meals.csv"])).toContain("Banana");
  });

  it("meals_are_private_and_validated", async () => {
    const me = await person();
    const other = await person();
    const day = today();
    const eid = uuid();
    const body = { date: day, meal: "lunch", name: "Soup", kcal: 300 };
    expect((await put(me.token, `/v1/nutrition/entries/${eid}`, body)).status).toBe(200);
    // Someone else can't overwrite it by reusing the id, or see it.
    expect((await put(other.token, `/v1/nutrition/entries/${eid}`, body)).status).toBe(404);
    expect((await get(other.token, `/v1/nutrition/days/${day}`)).entries).toEqual([]);
    await api(`/v1/nutrition/entries/${eid}`, { method: "DELETE", token: other.token });
    expect((await get(me.token, `/v1/nutrition/days/${day}`)).entries).toHaveLength(1);

    const future = { ...body, date: addDays(day, 2) };
    expect((await put(me.token, `/v1/nutrition/entries/${uuid()}`, future)).status).toBe(422);
    const nameless = { date: day, meal: "lunch", kcal: 300 };
    expect((await put(me.token, `/v1/nutrition/entries/${uuid()}`, nameless)).status).toBe(422);
    // The target clears when every field is empty.
    await put(me.token, "/v1/nutrition/target", { kcal: 2000 });
    expect(await jsonOf(await put(me.token, "/v1/nutrition/target", {}))).toBeNull();
    expect(await get(me.token, "/v1/nutrition/target")).toBeNull();
  });

  it("copy_yesterdays_breakfast", async () => {
    const me = await person();
    const day = today();
    const yesterday = addDays(day, -1);
    for (const meal of ["breakfast", "dinner"])
      await put(me.token, `/v1/nutrition/entries/${uuid()}`, {
        date: yesterday,
        meal,
        name: meal,
        kcal: 500,
      });
    const res = await api("/v1/nutrition/copy", {
      token: me.token,
      json: { from_date: yesterday, to_date: day, meal: "breakfast" },
    });
    expect(res.status).toBe(201);
    expect((await jsonOf<Json[]>(res)).map((e) => e.meal)).toEqual(["breakfast"]);
  });

  it("barcode_prefers_saved_then_lookup", async () => {
    const me = await person();
    const h = me.token;
    const known = `57${digits(11)}`;
    const unknown = digits(8);
    const off = mockFetch(OFF, (req) =>
      codeOf(req) === known
        ? Response.json({
            status: 1,
            product: {
              product_name: "Skyr",
              brands: "Arla",
              nutriments: {
                "energy-kcal_100g": 63,
                proteins_100g: 11,
                carbohydrates_100g: 4,
                fat_100g: 0.2,
              },
            },
          })
        : Response.json({ status: 0 }, { status: 404 }),
    );
    const found = await get(h, `/v1/nutrition/barcode/${known}`);
    expect(found.source).toBe("openfoodfacts");
    expect(found.food.kcal).toBe(63);
    expect((await api(`/v1/nutrition/barcode/${unknown}`, { token: h })).status).toBe(404);
    expect((await api("/v1/nutrition/barcode/not-a-code", { token: h })).status).toBe(422);

    // Saving it (with a correction) makes the saved copy win from then on.
    const saved = { ...found.food, kcal: 65 };
    expect((await api("/v1/nutrition/foods", { token: h, json: saved })).status).toBe(201);
    expect((await api("/v1/nutrition/foods", { token: h, json: saved })).status).toBe(409);
    const again = await get(h, `/v1/nutrition/barcode/${known}`);
    expect(again.source).toBe("saved");
    expect(again.food.kcal).toBe(65);
    expect(off.calls.map(codeOf)).toEqual([known, unknown]);
    // Only the barcode leaves: no cookie, no user id.
    const sent = off.calls[0];
    expect(sent?.headers.get("Cookie")).toBeNull();
    expect(sent?.headers.get("Authorization")).toBeNull();
    expect(sent?.headers.get("User-Agent")).toBe("PaceStreak/1.0 (hello@pacestreak.com)");
  });

  it("barcode_lookup_unavailable_is_503", async () => {
    const me = await person();
    mockFetch(OFF, () => new Response("down", { status: 502 }));
    expect((await api(`/v1/nutrition/barcode/${digits(8)}`, { token: me.token })).status).toBe(503);
    mockFetch(OFF, () => {
      throw new TypeError("network");
    });
    expect((await api(`/v1/nutrition/barcode/${digits(8)}`, { token: me.token })).status).toBe(503);
  });

  it("parse_open_food_facts_product", () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [
        {
          product_name: "Bar",
          brands: "Acme, Other",
          serving_quantity: 40,
          serving_size: "1 bar (40 g)",
          nutriments: { "energy-kcal_serving": 180, proteins_serving: 20, "energy-kcal_100g": 450 },
        },
        {
          name: "Bar",
          brand: "Acme",
          serving_label: "1 bar (40 g)",
          kcal: 180,
          protein_g: 20,
          carbs_g: 0,
          fat_g: 0,
        },
      ],
      [
        { product_name: "Milk", nutriments: { "energy-kcal_100g": 64, fat_100g: 3.6 } },
        { name: "Milk", brand: null, serving_label: "100 g", kcal: 64, protein_g: 0, carbs_g: 0, fat_g: 3.6 },
      ],
      [{ product_name: "Mystery", nutriments: {} }, null],
      [{ nutriments: { "energy-kcal_100g": 10 } }, null],
    ];
    for (const [product, expected] of cases) expect(parseProduct(product)).toEqual(expected);
  });

  it("coach_flags_low_readiness_and_short_protein", async () => {
    const me = await person();
    const h = me.token;
    const day = today();
    // Nothing logged: the coach still answers.
    expect((await get(h, "/v1/coach/today")).notes.length).toBeGreaterThan(0);

    await put(h, `/v1/readiness/${day}`, { sleep: 1, energy: 3, soreness: 2 });
    await put(h, "/v1/nutrition/target", { kcal: 2000, protein_g: 150 });
    const body = { date: addDays(day, -1), meal: "dinner", name: "Pasta", kcal: 1900, protein_g: 40 };
    await put(h, `/v1/nutrition/entries/${uuid()}`, body);

    const kinds = (await get(h, "/v1/coach/today")).notes.map((n: Json) => n.kind);
    expect(kinds).toContain("go_easy");
    expect(kinds).toContain("protein_low");
    expect(kinds.length).toBeLessThanOrEqual(4);
  });
});
