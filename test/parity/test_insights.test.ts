/**
 * Port of tests/test_insights.py: the insights engine, journal, insights endpoint, habit routines and habit import.
 * Readiness rows are written directly until TRAINING lands `PUT /v1/readiness/{day}`.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readiness } from "../../src/db/schema/index.ts";
import { zipFiles } from "../../src/heavy/zip.ts";
import { addDays, daysBetween } from "../../src/lib/time.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { HabitImportError, parse } from "../../src/modules/habits/importer.ts";
import { find, type SeriesMap } from "../../src/modules/insights/engine.ts";
import { type Estimate, estimate, suggest } from "../../src/modules/nutrition/expenditure.ts";
import { testDb } from "../fixtures/db.ts";
import { person } from "../fixtures/game.ts";
import { api, BASE, jsonOf, randomIp } from "../fixtures/http.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const daysBack = (n: number, end = "2026-09-30") => Array.from({ length: n }, (_, i) => addDays(end, -i));
const series = (o: Record<string, Map<string, number>>): SeriesMap => new Map(Object.entries(o));
const mapOf = (days: string[], f: (d: string, i: number) => number) =>
  new Map(days.map((d, i) => [d, f(d, i)]));

/** Python `Estimate(status, food_days, weigh_days, tdee=..., trend_kg=...)`. */
const estimateOf = (
  status: Estimate["status"],
  food_days: number,
  weigh_days: number,
  v: { tdee?: number; trend_kg?: number } = {},
): Estimate => ({
  status,
  food_days,
  weigh_days,
  tdee: v.tdee ?? null,
  avg_intake: null,
  trend_kg_per_week: null,
  trend_kg: v.trend_kg ?? null,
  confidence: null,
});

type Habit = { id: string; name: string };

async function habit(token: string, name: string): Promise<string> {
  const res = await api("/v1/habits", { token, json: { name } });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await jsonOf<Habit>(res)).id;
}

function upload(
  token: string,
  file: { name: string; bytes: Uint8Array | string; type: string },
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([typeof file.bytes === "string" ? file.bytes : new Uint8Array(file.bytes)], { type: file.type }),
    file.name,
  );
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return SELF.fetch(`${BASE}/v1/habits/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": randomIp() },
    body: form,
  });
}

function loopZip(): Uint8Array {
  const rows = ["Date,Meditate,Read"];
  for (let i = 1; i < 15; i++) rows.push(`${addDays(TODAY, -i)},${i % 2 ? 2 : 0},${i % 7 === 0 ? 2 : 1}`);
  return zipFiles([
    { name: "Checkmarks.csv", data: rows.join("\n") },
    { name: "Habits.csv", data: "Position,Name\n1,Meditate\n2,Read\n" },
  ]);
}

describe("test_insights", () => {
  // --- insights engine

  it("engine_finds_a_real_pattern_and_ignores_noise", () => {
    const days = daysBack(40);
    const sleep = mapOf(days, (_, i) => (i % 2 ? 8 : 6));
    // Habits track sleep closely; mood is unrelated noise.
    const habits = mapOf(days, (d, i) => (sleep.get(d) === 8 ? 0.9 : 0.4) + (i % 3) * 0.02);
    const mood = mapOf(days, (_, i) => 3 + Number(i % 5 === 0));
    const found = find(series({ sleep_hours: sleep, habits, mood }));
    expect(found.map((i) => [i.driver, i.outcome])).toEqual([["sleep_hours", "habits"]]);
    expect(found[0]?.text).toContain("7.0 h+ of sleep");
    expect(found[0]?.text).toContain("%");
  });

  it("engine_needs_enough_days_on_both_sides", () => {
    const days = daysBack(12);
    expect(find(series({ sleep_hours: mapOf(days, () => 8), habits: mapOf(days, () => 1) }))).toEqual([]);
  });

  it("engine_keeps_one_insight_per_outcome", () => {
    const days = daysBack(40);
    const flag = mapOf(days, (_, i) => i % 2);
    const sleep = mapOf(days, (d) => (flag.get(d) ? 5 : 2));
    const habits = mapOf(days, (d) => (flag.get(d) ? 0.9 : 0.3));
    const found = find(series({ trained: flag, sleep, habits }));
    expect(found.filter((i) => i.outcome === "habits")).toHaveLength(1);
  });

  // --- adaptive expenditure (NUTRITION)

  it("expenditure_from_intake_and_a_falling_trend", () => {
    const end = "2026-09-30";
    const days = daysBack(28, end);
    const intake = mapOf(days, () => 2000);
    // Losing 0.5 kg a week: 0.5 * 7700 / 7 = 550 kcal a day of deficit.
    const every2 = days.filter((_, i) => i % 2 === 0);
    const weights = mapOf(every2, (d) => 80 + (daysBetween(d, end) * 0.5) / 7);
    const est = estimate(intake, weights, end);
    expect(est.status).toBe("ok");
    expect(Math.abs((est.tdee ?? 0) - 2550)).toBeLessThanOrEqual(5);
    expect(est.trend_kg_per_week).toBe(-0.5);
    expect(est.confidence).toBe("good");
  });

  it("expenditure_refuses_thin_or_impossible_data", () => {
    const end = "2026-09-30";
    expect(
      estimate(
        mapOf(daysBack(10, end), () => 2000),
        new Map(),
        end,
      ).status,
    ).toBe("not_enough");
    const days = daysBack(28, end);
    // 500 kcal a day while gaining weight: meals weren't logged.
    const every2 = days.filter((_, i) => i % 2 === 0);
    const gaining = mapOf(every2, (d) => 80 - (daysBetween(d, end) * 0.5) / 7);
    expect(
      estimate(
        mapOf(days, () => 500),
        gaining,
        end,
      ).status,
    ).toBe("inconsistent");
  });

  it("suggestions_are_gentle", () => {
    const est = estimateOf("ok", 28, 14, { tdee: 1800, trend_kg: 60 });
    const lose = suggest(est, 50);
    // 0.5% of 60 kg a week is 0.3 kg, about 330 kcal a day under.
    expect(lose?.goal).toBe("lose");
    expect(lose?.kcal).toBe(1470);
    expect(lose?.rate_kg_per_week).toBeGreaterThanOrEqual(-0.31);
    expect(suggest(estimateOf("ok", 28, 14, { tdee: 1300, trend_kg: 90 }), 60)?.kcal).toBe(1200);
    expect(suggest(est, 60.5)?.goal).toBe("maintain");
    expect(suggest(est, null)?.kcal).toBe(1800);
    expect(suggest(estimateOf("not_enough", 3, 1), 50)).toBeNull();
  });

  it("expenditure_endpoint_reports_what_is_missing", async () => {
    const { token } = await person();
    const got = await jsonOf<{ status: string; suggestion: unknown }>(
      await api("/v1/nutrition/expenditure", { token }),
    );
    expect(got.status).toBe("not_enough");
    expect(got.suggestion).toBeNull();
  });

  // --- recipes (NUTRITION)

  it("recipe_logs_per_serving_and_snapshots_foods", async () => {
    const { token } = await person();
    const food = async (json: unknown) =>
      jsonOf<{ id: string }>(await api("/v1/nutrition/foods", { token, json }));
    const rice = await food({ name: "Rice", kcal: 200, carbs_g: 44 });
    const chicken = await food({ name: "Chicken", kcal: 165, protein_g: 31 });
    const recipe = await jsonOf<{ id: string; kcal: number; protein_g: number }>(
      await api("/v1/nutrition/recipes", {
        token,
        json: {
          name: "Rice bowl",
          serves: 2,
          items: [{ food_id: rice.id, servings: 2 }, { food_id: chicken.id }],
        },
      }),
    );
    expect(recipe.kcal).toBe(282.5);
    expect(recipe.protein_g).toBe(15.5);
    const body = { date: TODAY, meal: "dinner", recipe_id: recipe.id, servings: 2 };
    const entry = await jsonOf<{ name: string; kcal: number }>(
      await api(`/v1/nutrition/entries/${crypto.randomUUID()}`, { method: "PUT", json: body, token }),
    );
    expect(entry.name).toBe("Rice bowl");
    expect(entry.kcal).toBe(565);
    // Changing a food doesn't rewrite the recipe until it's saved again.
    await api(`/v1/nutrition/foods/${rice.id}`, { method: "PUT", json: { name: "Rice", kcal: 400 }, token });
    const list = await jsonOf<{ kcal: number }[]>(await api("/v1/nutrition/recipes", { token }));
    expect(list[0]?.kcal).toBe(282.5);
    const other = await person();
    const stolen = { name: "Mine", items: [{ food_id: rice.id }] };
    expect((await api("/v1/nutrition/recipes", { token: other.token, json: stolen })).status).toBe(404);
    const exported = await jsonOf<{ recipes: { serves: number }[] }>(
      await api("/v1/me/export?format=json", { token }),
    );
    expect(exported.recipes[0]?.serves).toBe(2);
  });

  // --- journal and insights

  it("journal_round_trip_search_and_privacy", async () => {
    const { token } = await person();
    const other = await person();
    const body = { mood: 4, note: "Long walk by the river" };
    const put = (day: string, json: unknown) => api(`/v1/journal/${day}`, { token, method: "PUT", json });
    expect((await jsonOf<{ mood: number }>(await put(TODAY, body))).mood).toBe(4);
    const hit = await jsonOf<{ note: string }[]>(await api("/v1/journal?q=river", { token }));
    expect(hit[0]?.note).toBe(body.note);
    expect(await jsonOf(await api("/v1/journal?q=mountain", { token }))).toEqual([]);
    expect(await jsonOf(await api("/v1/journal", { token: other.token }))).toEqual([]);
    expect((await put(addDays(TODAY, 2), body)).status).toBe(422);
    expect((await put(TODAY, { mood: 9 })).status).toBe(422);
    // (Python also read the journal back from /v1/me/export, which PROFILE-ACCOUNT owns.)
    const cleared = await put(TODAY, {});
    expect(cleared.status).toBe(200);
    expect(await jsonOf(cleared)).toBeNull();
    expect(await jsonOf(await api("/v1/journal", { token }))).toEqual([]);
  });

  it("insights_endpoint_from_logged_data", async () => {
    const me = await person();
    const token = me.token;
    const { db } = testDb();
    // Mood is high on readiness-good days, for 30 days.
    for (let i = 1; i <= 30; i++) {
      const day = addDays(TODAY, -i);
      await api(`/v1/journal/${day}`, { token, method: "PUT", json: { mood: i % 2 === 0 ? 5 : 2 } });
      if (i <= 2) {
        const now = Date.now();
        await db.insert(readiness).values({
          id: uuid7(),
          userId: me.userId,
          day,
          sleep: 5,
          energy: 4,
          soreness: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const got = await jsonOf<{ coverage: Record<string, number>; insights: unknown[]; window_days: number }>(
      await api("/v1/insights", { token }),
    );
    expect(got.window_days).toBe(90);
    expect(got.coverage.mood).toBe(30);
    // Two readiness days are nowhere near enough to claim a pattern.
    expect(got.insights).toEqual([]);
  });

  // --- habit routines

  it("habit_routine_orders_live_habits", async () => {
    const { token } = await person();
    const a = await habit(token, "Water");
    const b = await habit(token, "Stretch");
    const made = await jsonOf<{ id: string; habit_ids: string[] }>(
      await api("/v1/habit-routines", { token, json: { name: "Morning", habit_ids: [b, a, b] } }),
    );
    expect(made.habit_ids).toEqual([b, a]);
    await api(`/v1/habits/${a}/archive`, { token, method: "POST" });
    const listed = await jsonOf<{ habit_ids: string[] }[]>(await api("/v1/habit-routines", { token }));
    expect(listed[0]?.habit_ids).toEqual([b]);
    const other = await person();
    const bad = { name: "Theirs", habit_ids: [b] };
    expect((await api("/v1/habit-routines", { token: other.token, json: bad })).status).toBe(404);
    expect(
      (await api(`/v1/habit-routines/${made.id}`, { token: other.token, method: "DELETE" })).status,
    ).toBe(404);
  });

  // --- habit import

  it("parse_loop_zip_counts_only_manual_ticks", () => {
    const habits = new Map(parse("Loop Habits CSV.zip", loopZip()).map((h) => [h.name, h]));
    expect(habits.get("Meditate")?.days.size).toBe(7);
    expect(habits.get("Meditate")?.binary).toBe(true);
    expect(habits.get("Read")?.days.size).toBe(2);
  });

  it("parse_long_csv_and_rejects_ambiguous_dates", () => {
    const text = "Date;Habit;Value\n2026-09-01;Pages;12\n2026-09-02;Pages;0\n2026-09-02;Walk;1\n";
    const habits = new Map(parse("habitify.csv", new TextEncoder().encode(text)).map((h) => [h.name, h]));
    expect([...(habits.get("Pages")?.days ?? [])]).toEqual([["2026-09-01", 12]]);
    expect(habits.get("Pages")?.binary).toBe(false);
    expect(habits.get("Walk")?.binary).toBe(true);
    expect(() => parse("x.csv", new TextEncoder().encode("Date,Habit\n03/04/2026,Walk\n"))).toThrow(
      new HabitImportError("Dates must be written year first, like 2026-09-30"),
    );
  });

  it("import_merges_creates_and_never_overwrites", async () => {
    const { token } = await person();
    const existing = await habit(token, "meditate");
    const yesterday = addDays(TODAY, -1);
    await api(`/v1/habits/${existing}/days/${yesterday}`, {
      token,
      method: "PUT",
      json: { amount: 1, note: "mine" },
    });
    const file = { name: "loop.zip", bytes: loopZip(), type: "application/zip" };
    const preview = await jsonOf<{ habits: { name: string; merge: boolean }[] }>(
      await upload(token, file, { dry_run: "true" }),
    );
    expect(Object.fromEntries(preview.habits.map((p) => [p.name, p.merge]))).toEqual({
      Meditate: true,
      Read: false,
    });
    expect(await jsonOf<unknown[]>(await api("/v1/habits", { token }))).toHaveLength(1);

    const done = await jsonOf<{ imported_days: number }>(await upload(token, file));
    // Meditate: 7 ticks, of which yesterday was already here. Read: 2.
    expect(done.imported_days).toBe(6 + 2);
    const habits = await jsonOf<Habit[]>(await api("/v1/habits", { token }));
    expect(habits.map((x) => x.name).sort()).toEqual(["Read", "meditate"]);
    const detail = await jsonOf<{ days: { date: string; note: string | null }[] }>(
      await api(`/v1/habits/${existing}`, { token }),
    );
    expect(detail.days.find((d) => d.date === yesterday)?.note).toBe("mine");
    const again = await jsonOf<{ imported_days: number }>(await upload(token, file));
    expect(again.imported_days).toBe(0);
    const bad = await upload(token, { name: "x.csv", bytes: "nothing,here\n1,2\n", type: "text/csv" });
    expect(bad.status).toBe(422);
  });
});
