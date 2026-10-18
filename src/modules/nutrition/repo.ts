/**
 * Query builders for nutrition and the coach (spec/misc.md §1, spec/habits.md §2.5). Every function returns an
 * un-awaited statement. Day windows depend on the person's local date, which needs their time zone; reads that
 * share a round trip with the time zone use a UTC-safe superset (local dates are within a day of UTC) and the
 * service trims them.
 */
import { and, asc, avg, between, count, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { foldLike, withFold, withFoldPatch } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  foods,
  mealEntries,
  nutritionTargets,
  profiles,
  type RecipeItem,
  readiness,
  recipes,
  type TrashPayload,
  trashItems,
  weighIns,
  weightGoals,
} from "../../db/schema/index.ts";

export type FoodRow = typeof foods.$inferSelect;
export type EntryRow = typeof mealEntries.$inferSelect;
export type RecipeRow = typeof recipes.$inferSelect;
export type TargetRow = typeof nutritionTargets.$inferSelect;

export const timezoneOf = (db: Db, userId: string) =>
  db.select({ timezone: profiles.timezone }).from(profiles).where(eq(profiles.userId, userId));

// ---- entries --------------------------------------------------------------------------------------------------

export const entriesOn = (db: Db, userId: string, day: string, meal: EntryRow["meal"] | null = null) =>
  db
    .select()
    .from(mealEntries)
    .where(
      and(
        eq(mealEntries.userId, userId),
        eq(mealEntries.day, day),
        meal === null ? undefined : eq(mealEntries.meal, meal),
      ),
    )
    .orderBy(asc(mealEntries.createdAt), asc(mealEntries.id));

export const entriesBetween = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select()
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), between(mealEntries.day, lo, hi)));

export const entriesSinceNewest = (db: Db, userId: string, since: string) =>
  db
    .select()
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), gte(mealEntries.day, since)))
    .orderBy(desc(mealEntries.createdAt), desc(mealEntries.id));

const total = (col: SQLiteColumn) => sql<number>`${sum(col)}`.mapWith(Number);

export const dailyTotalsSince = (db: Db, userId: string, since: string) =>
  db
    .select({
      day: mealEntries.day,
      kcal: total(mealEntries.kcal),
      protein_g: total(mealEntries.proteinG),
      carbs_g: total(mealEntries.carbsG),
      fat_g: total(mealEntries.fatG),
    })
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), gte(mealEntries.day, since)))
    .groupBy(mealEntries.day)
    .orderBy(asc(mealEntries.day));

export const intakeBetween = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ day: mealEntries.day, kcal: total(mealEntries.kcal) })
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), between(mealEntries.day, lo, hi)))
    .groupBy(mealEntries.day);

export const entryById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(mealEntries)
    .where(and(eq(mealEntries.id, id), eq(mealEntries.userId, userId)));

/**
 * Upsert on the client's id. `setWhere` keeps someone else's row untouched, and RETURNING is then empty: the
 * caller answers 404 (Python checked ownership before writing).
 */
export const upsertEntry = (db: Db, v: typeof mealEntries.$inferInsert, now: number) =>
  db
    .insert(mealEntries)
    .values(v)
    .onConflictDoUpdate({
      target: mealEntries.id,
      set: {
        day: v.day,
        meal: v.meal,
        name: v.name,
        foodId: v.foodId ?? null,
        servings: v.servings ?? 1,
        kcal: v.kcal,
        proteinG: v.proteinG ?? 0,
        carbsG: v.carbsG ?? 0,
        fatG: v.fatG ?? 0,
        updatedAt: now,
      },
      setWhere: eq(mealEntries.userId, v.userId),
    })
    .returning();

export const insertEntries = (db: Db, rows: (typeof mealEntries.$inferInsert)[]) =>
  db.insert(mealEntries).values(rows).returning();

export const deleteEntry = (db: Db, userId: string, id: string) =>
  db.delete(mealEntries).where(and(eq(mealEntries.id, id), eq(mealEntries.userId, userId)));

// ---- foods ----------------------------------------------------------------------------------------------------

export const listFoods = (db: Db, userId: string, q: string | null) =>
  db
    .select()
    .from(foods)
    .where(and(eq(foods.userId, userId), q === null ? undefined : foldLike(foods.nameFold, q, "contains")))
    .orderBy(asc(foods.nameFold), asc(foods.name));

export const foodById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(foods)
    .where(and(eq(foods.id, id), eq(foods.userId, userId)));

export const foodsByIds = (db: Db, userId: string, ids: readonly string[]) =>
  db
    .select()
    .from(foods)
    .where(and(eq(foods.userId, userId), inArray(foods.id, [...ids])));

export const foodByBarcode = (db: Db, userId: string, barcode: string) =>
  db
    .select()
    .from(foods)
    .where(and(eq(foods.userId, userId), eq(foods.barcode, barcode)));

export const foodCountBelow = (userId: string, limit: number) =>
  sql`(SELECT count(*) FROM ${foods} WHERE ${foods.userId} = ${userId}) < ${limit}`;

export const insertFood = (db: Db, v: Omit<typeof foods.$inferInsert, "nameFold">) =>
  db.insert(foods).values(withFold(foods, v)).returning();

export const updateFood = (
  db: Db,
  userId: string,
  id: string,
  v: Omit<FoodRow, "id" | "userId" | "createdAt" | "nameFold">,
) =>
  db
    .update(foods)
    .set(withFoldPatch(foods, v))
    .where(and(eq(foods.id, id), eq(foods.userId, userId)))
    .returning();

export const deleteFood = (db: Db, userId: string, id: string) =>
  db.delete(foods).where(and(eq(foods.id, id), eq(foods.userId, userId)));

// ---- recipes --------------------------------------------------------------------------------------------------

export const listRecipes = (db: Db, userId: string) =>
  db
    .select()
    .from(recipes)
    .where(eq(recipes.userId, userId))
    .orderBy(asc(recipes.nameFold), asc(recipes.name));

export const recipeById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.userId, userId)));

export const recipeCount = (db: Db, userId: string) =>
  db.select({ n: count() }).from(recipes).where(eq(recipes.userId, userId));

export const recipeCountBelow = (userId: string, limit: number) =>
  sql`(SELECT count(*) FROM ${recipes} WHERE ${recipes.userId} = ${userId}) < ${limit}`;

export interface RecipeValues {
  name: string;
  serves: number;
  items: RecipeItem[];
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export const insertRecipe = (
  db: Db,
  v: RecipeValues & { id: string; userId: string; createdAt: number; updatedAt: number },
) => db.insert(recipes).values(withFold(recipes, v)).returning();

export const updateRecipe = (db: Db, userId: string, id: string, v: RecipeValues, now: number) =>
  db
    .update(recipes)
    .set(withFoldPatch(recipes, { ...v, updatedAt: now }))
    .where(and(eq(recipes.id, id), eq(recipes.userId, userId)))
    .returning();

export const deleteRecipe = (db: Db, userId: string, id: string) =>
  db.delete(recipes).where(and(eq(recipes.id, id), eq(recipes.userId, userId)));

// ---- target ---------------------------------------------------------------------------------------------------

export const targetOf = (db: Db, userId: string) =>
  db.select().from(nutritionTargets).where(eq(nutritionTargets.userId, userId));

export const upsertTarget = (
  db: Db,
  v: {
    id: string;
    userId: string;
    kcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  },
  now: number,
) =>
  db
    .insert(nutritionTargets)
    .values({ ...v, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: nutritionTargets.userId,
      set: { kcal: v.kcal, proteinG: v.proteinG, carbsG: v.carbsG, fatG: v.fatG, updatedAt: now },
    })
    .returning();

export const deleteTarget = (db: Db, userId: string) =>
  db.delete(nutritionTargets).where(eq(nutritionTargets.userId, userId));

// ---- expenditure ----------------------------------------------------------------------------------------------

export const weightsBetween = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({ day: weighIns.localDate, kg: sql<number>`${avg(weighIns.weightKg)}`.mapWith(Number) })
    .from(weighIns)
    .where(and(eq(weighIns.userId, userId), between(weighIns.localDate, lo, hi)))
    .groupBy(weighIns.localDate);

export const goalOf = (db: Db, userId: string) =>
  db.select({ targetKg: weightGoals.targetKg }).from(weightGoals).where(eq(weightGoals.userId, userId));

// ---- coach ----------------------------------------------------------------------------------------------------

export const readinessBetween = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({
      day: readiness.day,
      sleep: readiness.sleep,
      energy: readiness.energy,
      soreness: readiness.soreness,
    })
    .from(readiness)
    .where(and(eq(readiness.userId, userId), between(readiness.day, lo, hi)));

export const dailyTotalsBetween = (db: Db, userId: string, lo: string, hi: string) =>
  db
    .select({
      day: mealEntries.day,
      kcal: total(mealEntries.kcal),
      protein_g: total(mealEntries.proteinG),
      carbs_g: total(mealEntries.carbsG),
      fat_g: total(mealEntries.fatG),
    })
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), between(mealEntries.day, lo, hi)))
    .groupBy(mealEntries.day);

// ---- trash ----------------------------------------------------------------------------------------------------

export const RETENTION_DAYS = 30;

/** `label` is cut to 160 code points, as Python did. The payload holds the drizzle-shaped row (camelCase). */
export const insertTrash = (
  db: Db,
  v: { id: string; userId: string; kind: "meal" | "food" | "recipe"; itemId: string; label: string },
  payload: TrashPayload,
  now: number,
) =>
  db.insert(trashItems).values({
    ...v,
    label: Array.from(v.label).slice(0, 160).join(""),
    payload,
    deletedAt: now,
    purgeAfter: now + RETENTION_DAYS * 86_400_000,
    createdAt: now,
    updatedAt: now,
  });

// ---- EXPLAIN lint ---------------------------------------------------------------------------------------------

const U = "u";
const D = "2026-01-01";
export const explain: ExplainCase[] = [
  { name: "nutrition.timezoneOf", build: (db) => timezoneOf(db, U) },
  { name: "nutrition.entriesOn", build: (db) => entriesOn(db, U, D) },
  { name: "nutrition.entriesOnMeal", build: (db) => entriesOn(db, U, D, "lunch") },
  { name: "nutrition.entriesBetween", build: (db) => entriesBetween(db, U, D, D) },
  { name: "nutrition.entriesSinceNewest", build: (db) => entriesSinceNewest(db, U, D) },
  { name: "nutrition.dailyTotalsSince", build: (db) => dailyTotalsSince(db, U, D) },
  { name: "nutrition.intakeBetween", build: (db) => intakeBetween(db, U, D, D) },
  { name: "nutrition.entryById", build: (db) => entryById(db, U, "e") },
  { name: "nutrition.deleteEntry", build: (db) => deleteEntry(db, U, "e") },
  { name: "nutrition.listFoods", build: (db) => listFoods(db, U, null) },
  { name: "nutrition.listFoodsSearch", build: (db) => listFoods(db, U, "oat") },
  { name: "nutrition.foodById", build: (db) => foodById(db, U, "f") },
  { name: "nutrition.foodsByIds", build: (db) => foodsByIds(db, U, ["a", "b"]) },
  { name: "nutrition.foodByBarcode", build: (db) => foodByBarcode(db, U, "12345678") },
  { name: "nutrition.foodCountBelow", build: () => sql`SELECT ${foodCountBelow(U, 500)}` },
  { name: "nutrition.deleteFood", build: (db) => deleteFood(db, U, "f") },
  { name: "nutrition.listRecipes", build: (db) => listRecipes(db, U) },
  { name: "nutrition.recipeById", build: (db) => recipeById(db, U, "r") },
  { name: "nutrition.recipeCount", build: (db) => recipeCount(db, U) },
  { name: "nutrition.recipeCountBelow", build: () => sql`SELECT ${recipeCountBelow(U, 200)}` },
  { name: "nutrition.deleteRecipe", build: (db) => deleteRecipe(db, U, "r") },
  { name: "nutrition.targetOf", build: (db) => targetOf(db, U) },
  { name: "nutrition.deleteTarget", build: (db) => deleteTarget(db, U) },
  { name: "nutrition.weightsBetween", build: (db) => weightsBetween(db, U, D, D) },
  { name: "nutrition.goalOf", build: (db) => goalOf(db, U) },
  { name: "nutrition.readinessBetween", build: (db) => readinessBetween(db, U, D, D) },
  { name: "nutrition.dailyTotalsBetween", build: (db) => dailyTotalsBetween(db, U, D, D) },
];
