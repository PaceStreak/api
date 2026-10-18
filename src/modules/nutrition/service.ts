/**
 * Calorie and macro logging: meals by day, saved foods, recipes, a daily target, barcode lookup and adaptive
 * expenditure (Python `app/nutrition/router.py`, spec/misc.md §1). All private to their owner; ownership
 * failures are always 404 "Not found", never 403, so ids cannot be probed.
 *
 * Round trips: reads 1; entry upsert, copy, deletes and recipe writes 2 (a read, then one write batch); food
 * create/update and the target 1.
 */
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, type Stmt } from "../../db/batch.ts";
import type { RecipeItem } from "../../db/schema/index.ts";
import { SETTINGS } from "../../env.ts";
import { conflict, HttpError, isConstraintError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { addDays, localDate, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { estimate, suggest, WINDOW_DAYS } from "./expenditure.ts";
import { fetchProduct, LookupUnavailable } from "./lookup.ts";
import * as repo from "./repo.ts";
import type { CopyInput, EntryInput, FoodInput, RecipeInput, TargetInput } from "./schemas.ts";
import { BARCODE } from "./schemas.ts";

export const MAX_FOODS = 500;
export const MAX_RECIPES = 200;
export const MAX_BACKDATE_DAYS = 60;
export const RECENT_DAYS = 30;
export const RECENT_LIMIT = 20;

type Macros = { kcal: number; proteinG: number; carbsG: number; fatG: number };

// ---- shapes ---------------------------------------------------------------------------------------------------

const macrosOut = (m: Macros) => ({ kcal: m.kcal, protein_g: m.proteinG, carbs_g: m.carbsG, fat_g: m.fatG });

export const foodOut = (f: repo.FoodRow) => ({
  id: f.id,
  name: f.name,
  brand: f.brand,
  barcode: f.barcode,
  serving_label: f.servingLabel,
  ...macrosOut(f),
});

export const entryOut = (e: repo.EntryRow) => ({
  id: e.id,
  date: e.day,
  meal: e.meal,
  name: e.name,
  food_id: e.foodId,
  servings: e.servings,
  ...macrosOut(e),
});

export const targetOut = (t: repo.TargetRow | undefined) =>
  t === undefined ? null : { kcal: t.kcal, protein_g: t.proteinG, carbs_g: t.carbsG, fat_g: t.fatG };

export const recipeOut = (r: repo.RecipeRow) => ({
  id: r.id,
  name: r.name,
  serves: r.serves,
  items: r.items,
  ...macrosOut(r),
});

/** Python `totals`: each macro summed in order and rounded to 1 dp. */
export function totals(entries: readonly Macros[]) {
  let kcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const e of entries) {
    kcal += e.kcal;
    protein += e.proteinG;
    carbs += e.carbsG;
    fat += e.fatG;
  }
  return {
    kcal: pyRound(kcal, 1),
    protein_g: pyRound(protein, 1),
    carbs_g: pyRound(carbs, 1),
    fat_g: pyRound(fat, 1),
  };
}

// ---- helpers --------------------------------------------------------------------------------------------------

const utcToday = (ctx: Ctx) => new Date(ctx.clock.now()).toISOString().slice(0, 10);
const localToday = (ctx: Ctx, rows: readonly { timezone: string }[]) =>
  localDate(ctx.clock.now(), zone(rows[0]?.timezone));

function checkDay(day: string, today: string): void {
  if (day > today) throw new HttpError(422, "That day hasn't happened yet");
  if (day < addDays(today, -MAX_BACKDATE_DAYS))
    throw new HttpError(422, `Meals can be backdated up to ${MAX_BACKDATE_DAYS} days`);
}

const scaled = (m: Macros, by: number): Macros => ({
  kcal: pyRound(m.kcal * by, 1),
  proteinG: pyRound(m.proteinG * by, 1),
  carbsG: pyRound(m.carbsG * by, 1),
  fatG: pyRound(m.fatG * by, 1),
});

function trashed(
  ctx: Ctx,
  userId: string,
  kind: "meal" | "food" | "recipe",
  row: { id: string; name: string },
): { trashId: string; stmt: Stmt } {
  const now = ctx.clock.now();
  const trashId = uuid7(now);
  return {
    trashId,
    stmt: repo.insertTrash(
      ctx.db,
      { id: trashId, userId, kind, itemId: row.id, label: row.name },
      { row },
      now,
    ),
  };
}

// ---- days -----------------------------------------------------------------------------------------------------

/** No range check on the day, as in Python. One round trip. */
export async function getDay(ctx: Ctx, authed: AuthedBatch, day: string) {
  const [, entries, target] = await authed.read(
    repo.entriesOn(ctx.db, authed.userId, day),
    repo.targetOf(ctx.db, authed.userId),
  );
  return { date: day, entries: entries.map(entryOut), totals: totals(entries), target: targetOut(target[0]) };
}

/** Daily totals, oldest first, only days with something logged. One round trip. */
export async function history(ctx: Ctx, authed: AuthedBatch, days: number) {
  const [, tz, rows] = await authed.read(
    repo.timezoneOf(ctx.db, authed.userId),
    repo.dailyTotalsSince(ctx.db, authed.userId, addDays(utcToday(ctx), -days)),
  );
  const since = addDays(localToday(ctx, tz), -(days - 1));
  return rows
    .filter((r) => r.day >= since)
    .map((r) => ({
      date: r.day,
      kcal: pyRound(r.kcal, 1),
      protein_g: pyRound(r.protein_g, 1),
      carbs_g: pyRound(r.carbs_g, 1),
      fat_g: pyRound(r.fat_g, 1),
    }));
}

// ---- entries --------------------------------------------------------------------------------------------------

/** Client-chosen id, so an offline retry updates rather than duplicates. Two round trips. */
export async function putEntry(ctx: Ctx, authed: AuthedBatch, id: string, body: EntryInput) {
  const db = ctx.db;
  const u = authed.userId;
  const [, tz, recipe, food] = await authed.read(
    repo.timezoneOf(db, u),
    repo.recipeById(db, u, body.recipe_id ?? ""),
    repo.foodById(db, u, body.food_id ?? ""),
  );
  checkDay(body.date, localToday(ctx, tz));
  let values: Macros & { name: string };
  // A recipe wins over a food when both are sent, as in Python; the recipe id itself is not stored.
  if (body.recipe_id !== null) {
    const r = recipe[0];
    if (r === undefined) throw notFound();
    values = { name: r.name, ...scaled(r, body.servings) };
  } else if (body.food_id !== null) {
    const f = food[0];
    if (f === undefined) throw notFound();
    values = { name: f.name, ...scaled(f, body.servings) };
  } else {
    const name = (body.name ?? "").trim();
    if (!name || body.kcal === null) throw new HttpError(422, "A name and calories, or a saved food");
    values = {
      name,
      kcal: body.kcal,
      proteinG: body.protein_g ?? 0,
      carbsG: body.carbs_g ?? 0,
      fatG: body.fat_g ?? 0,
    };
  }
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    repo.upsertEntry(
      db,
      {
        id,
        userId: u,
        day: body.date,
        meal: body.meal,
        foodId: body.food_id,
        servings: body.servings,
        ...values,
        createdAt: now,
        updatedAt: now,
      },
      now,
    ),
  );
  const row = rows[0];
  // Somebody else's id: their row is untouched and nothing comes back.
  if (row === undefined) throw notFound();
  return entryOut(row);
}

/** Idempotent, because the app queues it offline: something already gone succeeds with no trash entry. */
export async function deleteEntry(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows] = await authed.read(repo.entryById(ctx.db, authed.userId, id));
  const row = rows[0];
  if (row === undefined) return { trash_id: null };
  const t = trashed(ctx, authed.userId, "meal", row);
  await authed.write(t.stmt, repo.deleteEntry(ctx.db, authed.userId, id));
  return { trash_id: t.trashId };
}

/** Rows per multi-row insert: D1 binds at most 100 parameters, and a meal entry has 13 columns. */
const ENTRY_ROWS_PER_INSERT = Math.floor(100 / 13);

/** "Same breakfast as yesterday" in one tap. Only the target day is range-checked. No dedupe, as in Python. */
export async function copy(ctx: Ctx, authed: AuthedBatch, body: CopyInput) {
  const [, tz, source] = await authed.read(
    repo.timezoneOf(ctx.db, authed.userId),
    repo.entriesOn(ctx.db, authed.userId, body.from_date, body.meal),
  );
  checkDay(body.to_date, localToday(ctx, tz));
  if (source.length === 0) return [];
  const now = ctx.clock.now();
  // created_at steps by 1 ms so the copies keep the source order on the day view.
  const rows = source.map((e, i) => ({
    id: uuid7(now + i),
    userId: authed.userId,
    day: body.to_date,
    meal: e.meal,
    name: e.name,
    foodId: e.foodId,
    servings: e.servings,
    kcal: e.kcal,
    proteinG: e.proteinG,
    carbsG: e.carbsG,
    fatG: e.fatG,
    createdAt: now + i,
    updatedAt: now,
  }));
  const stmts: Stmt[] = [];
  for (let i = 0; i < rows.length; i += ENTRY_ROWS_PER_INSERT)
    stmts.push(repo.insertEntries(ctx.db, rows.slice(i, i + ENTRY_ROWS_PER_INSERT)));
  const results = (await authed.write(...(stmts as [Stmt, ...Stmt[]]))) as unknown as repo.EntryRow[][];
  return results.flat().map(entryOut);
}

// ---- foods ----------------------------------------------------------------------------------------------------

/** Contains-search on the folded name (Python ILIKE, with `%` and `_` stripped from the term). */
export async function listFoods(ctx: Ctx, authed: AuthedBatch, q: string | undefined) {
  const term = q ? q.replace(/[%_]/g, "") : "";
  const [, rows] = await authed.read(repo.listFoods(ctx.db, authed.userId, term === "" ? null : term));
  return rows.map(foodOut);
}

/** The most-logged things of the last 30 days, for quick re-entry. One round trip. */
export async function recent(ctx: Ctx, authed: AuthedBatch) {
  const [, tz, rows] = await authed.read(
    repo.timezoneOf(ctx.db, authed.userId),
    repo.entriesSinceNewest(ctx.db, authed.userId, addDays(utcToday(ctx), -(RECENT_DAYS + 1))),
  );
  const since = addDays(localToday(ctx, tz), -RECENT_DAYS);
  // Newest first, so the first entry seen per key is the latest, and ties keep recency order (stable sort).
  const seen = new Map<string, { latest: repo.EntryRow; times: number }>();
  for (const e of rows) {
    if (e.day < since) continue;
    const key = `${e.foodId ?? ""}\u0000${e.name}`;
    const s = seen.get(key);
    if (s === undefined) seen.set(key, { latest: e, times: 1 });
    else s.times++;
  }
  return [...seen.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, RECENT_LIMIT)
    .map(({ latest: e, times }) => {
      const per = Math.max(e.servings, 0.01);
      return {
        name: e.name,
        food_id: e.foodId,
        times,
        kcal: pyRound(e.kcal / per, 1),
        protein_g: pyRound(e.proteinG / per, 1),
        carbs_g: pyRound(e.carbsG / per, 1),
        fat_g: pyRound(e.fatG / per, 1),
      };
    });
}

const BARCODE_TAKEN = "That barcode is already saved";

const foodValues = (body: FoodInput) => ({
  name: body.name.trim(),
  brand: body.brand,
  barcode: body.barcode,
  servingLabel: body.serving_label,
  kcal: body.kcal,
  proteinG: body.protein_g,
  carbsG: body.carbs_g,
  fatG: body.fat_g,
});

/** One round trip: the limit is a guard in the batch, the barcode clash the UNIQUE (user_id, barcode). */
export async function createFood(ctx: Ctx, authed: AuthedBatch, body: FoodInput) {
  const now = ctx.clock.now();
  try {
    const [, rows] = await authed.write(
      abortUnless(ctx.db, repo.foodCountBelow(authed.userId, MAX_FOODS)),
      repo.insertFood(ctx.db, {
        id: uuid7(now),
        userId: authed.userId,
        ...foodValues(body),
        createdAt: now,
        updatedAt: now,
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("food insert returned nothing");
    return foodOut(row);
  } catch (err) {
    if (isCondAbort(err)) throw conflict(`${MAX_FOODS} saved foods is the limit`);
    if (isConstraintError(err)) throw conflict(BARCODE_TAKEN);
    throw err;
  }
}

/** Full replace; a null barcode clears it. Meal entries and recipes keep their snapshots. One round trip. */
export async function updateFood(ctx: Ctx, authed: AuthedBatch, id: string, body: FoodInput) {
  try {
    const [rows] = await authed.write(
      repo.updateFood(ctx.db, authed.userId, id, { ...foodValues(body), updatedAt: ctx.clock.now() }),
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return foodOut(row);
  } catch (err) {
    if (isConstraintError(err)) throw conflict(BARCODE_TAKEN);
    throw err;
  }
}

/**
 * Logged meals keep their numbers; they just stop pointing here (`ON DELETE SET NULL`). Recipes keep the food id in
 * their items, as in Python.
 */
export async function deleteFood(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows] = await authed.read(repo.foodById(ctx.db, authed.userId, id));
  const row = rows[0];
  if (row === undefined) throw notFound();
  const t = trashed(ctx, authed.userId, "food", row);
  await authed.write(t.stmt, repo.deleteFood(ctx.db, authed.userId, id));
  return { trash_id: t.trashId };
}

/**
 * A saved food first, so a correction someone made sticks; then Open Food Facts. `source` says which, and an
 * outside result is not saved until the person confirms it with POST /foods.
 */
export async function barcode(ctx: Ctx, authed: AuthedBatch, code: string) {
  if (!BARCODE.test(code)) throw new HttpError(422, "Not a product barcode");
  const [, saved] = await authed.read(repo.foodByBarcode(ctx.db, authed.userId, code));
  const own = saved[0];
  if (own !== undefined) return { source: "saved", food: foodOut(own) };
  let found: Awaited<ReturnType<typeof fetchProduct>>;
  try {
    found = await fetchProduct(ctx, code, SETTINGS.foodLookupUrl);
  } catch (err) {
    if (err instanceof LookupUnavailable) throw new HttpError(503, "Barcode lookup is unavailable right now");
    throw err;
  }
  if (found === null) throw notFound("Product not found");
  return { source: "openfoodfacts", food: { ...found, barcode: code } };
}

// ---- target ---------------------------------------------------------------------------------------------------

export async function getTarget(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.targetOf(ctx.db, authed.userId));
  return targetOut(rows[0]);
}

/** All four empty removes the target. One round trip. */
export async function putTarget(ctx: Ctx, authed: AuthedBatch, body: TargetInput) {
  if (body.kcal === null && body.protein_g === null && body.carbs_g === null && body.fat_g === null) {
    await authed.write(repo.deleteTarget(ctx.db, authed.userId));
    return null;
  }
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    repo.upsertTarget(
      ctx.db,
      {
        id: uuid7(now),
        userId: authed.userId,
        kcal: body.kcal,
        proteinG: body.protein_g,
        carbsG: body.carbs_g,
        fatG: body.fat_g,
      },
      now,
    ),
  );
  return targetOut(rows[0]);
}

// ---- recipes --------------------------------------------------------------------------------------------------

export async function listRecipes(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listRecipes(ctx.db, authed.userId));
  return rows.map(recipeOut);
}

/**
 * Python `_fill_recipe`: snapshot the foods as they are now. Per-serving macros are the sum of the items divided by
 * how many it serves. Duplicate items are fine and kept.
 */
function fillRecipe(body: RecipeInput, foods: readonly repo.FoodRow[]): repo.RecipeValues {
  const byId = new Map(foods.map((f) => [f.id, f]));
  if (byId.size !== new Set(body.items.map((i) => i.food_id)).size)
    throw notFound("A food in this recipe isn't saved");
  const items: RecipeItem[] = [];
  const sum = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const i of body.items) {
    const f = byId.get(i.food_id);
    if (f === undefined) throw notFound("A food in this recipe isn't saved");
    items.push({ food_id: i.food_id, name: f.name, servings: i.servings });
    sum.kcal += f.kcal * i.servings;
    sum.proteinG += f.proteinG * i.servings;
    sum.carbsG += f.carbsG * i.servings;
    sum.fatG += f.fatG * i.servings;
  }
  return {
    name: body.name.trim(),
    serves: body.serves,
    items,
    kcal: pyRound(sum.kcal / body.serves, 1),
    proteinG: pyRound(sum.proteinG / body.serves, 1),
    carbsG: pyRound(sum.carbsG / body.serves, 1),
    fatG: pyRound(sum.fatG / body.serves, 1),
  };
}

const itemIds = (body: RecipeInput) => [...new Set(body.items.map((i) => i.food_id))];

/** Two round trips: the foods, then the insert behind the limit guard. */
export async function createRecipe(ctx: Ctx, authed: AuthedBatch, body: RecipeInput) {
  const [, count, foods] = await authed.read(
    repo.recipeCount(ctx.db, authed.userId),
    repo.foodsByIds(ctx.db, authed.userId, itemIds(body)),
  );
  const limit = conflict(`${MAX_RECIPES} recipes is the limit`);
  if ((count[0]?.n ?? 0) >= MAX_RECIPES) throw limit;
  const values = fillRecipe(body, foods);
  const now = ctx.clock.now();
  try {
    const [, rows] = await authed.write(
      abortUnless(ctx.db, repo.recipeCountBelow(authed.userId, MAX_RECIPES)),
      repo.insertRecipe(ctx.db, {
        id: uuid7(now),
        userId: authed.userId,
        ...values,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("recipe insert returned nothing");
    return recipeOut(row);
  } catch (err) {
    if (isCondAbort(err)) throw limit;
    throw err;
  }
}

export async function updateRecipe(ctx: Ctx, authed: AuthedBatch, id: string, body: RecipeInput) {
  const [, own, foods] = await authed.read(
    repo.recipeById(ctx.db, authed.userId, id),
    repo.foodsByIds(ctx.db, authed.userId, itemIds(body)),
  );
  if (own[0] === undefined) throw notFound();
  const values = fillRecipe(body, foods);
  const [rows] = await authed.write(repo.updateRecipe(ctx.db, authed.userId, id, values, ctx.clock.now()));
  const row = rows[0];
  if (row === undefined) throw notFound();
  return recipeOut(row);
}

export async function deleteRecipe(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows] = await authed.read(repo.recipeById(ctx.db, authed.userId, id));
  const row = rows[0];
  if (row === undefined) throw notFound();
  const t = trashed(ctx, authed.userId, "recipe", row);
  await authed.write(t.stmt, repo.deleteRecipe(ctx.db, authed.userId, id));
  return { trash_id: t.trashId };
}

// ---- expenditure ----------------------------------------------------------------------------------------------

/**
 * Estimated daily burn from the last four weeks of food and weigh-ins (ending yesterday), and a target toward the
 * weight goal. One round trip: the window is read from a UTC-safe superset and trimmed to the local one.
 */
export async function expenditure(ctx: Ctx, authed: AuthedBatch) {
  const db = ctx.db;
  const u = authed.userId;
  const utc = utcToday(ctx);
  const lo = addDays(utc, -WINDOW_DAYS - 1);
  const [, tz, intakeRows, weightRows, goal] = await authed.read(
    repo.timezoneOf(db, u),
    repo.intakeBetween(db, u, lo, utc),
    repo.weightsBetween(db, u, lo, utc),
    repo.goalOf(db, u),
  );
  const end = addDays(localToday(ctx, tz), -1);
  const start = addDays(end, -(WINDOW_DAYS - 1));
  const inWindow = (d: string) => start <= d && d <= end;
  const intake = new Map(intakeRows.filter((r) => inWindow(r.day)).map((r) => [r.day, r.kcal]));
  const weights = new Map(weightRows.filter((r) => inWindow(r.day)).map((r) => [r.day, r.kg]));
  const est = estimate(intake, weights, end);
  return { window_days: WINDOW_DAYS, ...est, suggestion: suggest(est, goal[0]?.targetKg ?? null) };
}
