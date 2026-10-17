import { index, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, enumCheck, json } from "./columns.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export const foods = sqliteTable(
  "foods",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    nameFold: text().notNull(),
    brand: text(),
    barcode: text(),
    servingLabel: text(),
    kcal: real().notNull(),
    proteinG: real().notNull().default(0),
    carbsG: real().notNull().default(0),
    fatG: real().notNull().default(0),
  },
  (t) => [
    unique("uq_food_barcode").on(t.userId, t.barcode),
    index("ix_foods_user_name").on(t.userId, t.nameFold),
  ],
);

export const mealEntries = sqliteTable(
  "meal_entries",
  {
    ...base(),
    userId: userFk(),
    day: text().notNull(),
    meal: text({ enum: MEALS }).notNull(),
    name: text().notNull(),
    foodId: text().references(() => foods.id, { onDelete: "set null" }),
    servings: real().notNull().default(1),
    kcal: real().notNull(),
    proteinG: real().notNull().default(0),
    carbsG: real().notNull().default(0),
    fatG: real().notNull().default(0),
  },
  (t) => [
    index("ix_meal_entries_user_day").on(t.userId, t.day),
    index("ix_meal_entries_food_id").on(t.foodId),
    enumCheck("ck_meal_entries_meal", t.meal, MEALS),
  ],
);

export const nutritionTargets = sqliteTable(
  "nutrition_targets",
  {
    ...base(),
    userId: userFk(),
    kcal: real(),
    proteinG: real(),
    carbsG: real(),
    fatG: real(),
  },
  (t) => [uniqueIndex("uq_nutrition_targets_user_id").on(t.userId)],
);

export type RecipeItem = { food_id: string | null; name: string; servings: number };

export const recipes = sqliteTable(
  "recipes",
  {
    ...base(),
    userId: userFk(),
    name: text().notNull(),
    nameFold: text().notNull(),
    serves: real().notNull().default(1),
    items: json<RecipeItem[]>().notNull(),
    kcal: real().notNull(),
    proteinG: real().notNull().default(0),
    carbsG: real().notNull().default(0),
    fatG: real().notNull().default(0),
  },
  (t) => [index("ix_recipes_user_name").on(t.userId, t.nameFold)],
);
