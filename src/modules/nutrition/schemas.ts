/** Request schemas for /v1/nutrition (Python app/nutrition/router.py, spec/misc.md §1). Non-strict, like pydantic. */
import * as z from "zod";
import { MEALS } from "../../db/schema/nutrition.ts";

/** A UUID path or body field, lowercased (Python `UUID` accepts either case). */
const uuid = z.guid().transform((s) => s.toLowerCase());
const date = z.iso.date();
const meal = z.enum(MEALS);

export const BARCODE = /^\d{8,14}$/;

export const FoodIn = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => s.trim() !== "", "A name is required"),
  brand: z.string().max(120).nullable().default(null),
  barcode: z.string().regex(BARCODE).nullable().default(null),
  serving_label: z.string().max(40).nullable().default(null),
  kcal: z.number().min(0).max(10000),
  protein_g: z.number().min(0).max(1000).default(0),
  carbs_g: z.number().min(0).max(1000).default(0),
  fat_g: z.number().min(0).max(1000).default(0),
});
export type FoodInput = z.output<typeof FoodIn>;

const optMacro = (max: number) => z.number().min(0).max(max).nullable().default(null);

export const EntryIn = z.object({
  date,
  meal,
  food_id: uuid.nullable().default(null),
  recipe_id: uuid.nullable().default(null),
  servings: z.number().gt(0).max(50).default(1),
  name: z.string().max(120).nullable().default(null),
  kcal: optMacro(20000),
  protein_g: optMacro(2000),
  carbs_g: optMacro(2000),
  fat_g: optMacro(2000),
});
export type EntryInput = z.output<typeof EntryIn>;

export const RecipeIn = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => s.trim() !== "", "A name is required"),
  serves: z.number().gt(0).max(50).default(1),
  items: z
    .array(z.object({ food_id: uuid, servings: z.number().gt(0).max(50).default(1) }))
    .min(1)
    .max(40),
});
export type RecipeInput = z.output<typeof RecipeIn>;

export const TargetIn = z.object({
  kcal: z.number().min(500).max(10000).nullable().default(null),
  protein_g: optMacro(1000),
  carbs_g: optMacro(2000),
  fat_g: optMacro(1000),
});
export type TargetInput = z.output<typeof TargetIn>;

export const CopyIn = z.object({ from_date: date, to_date: date, meal: meal.nullable().default(null) });
export type CopyInput = z.output<typeof CopyIn>;

export const DayParam = z.object({ day: date });
export const EntryId = z.object({ entry_id: uuid });
export const FoodId = z.object({ food_id: uuid });
export const RecipeId = z.object({ recipe_id: uuid });
export const HistoryQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
export const FoodsQuery = z.object({ q: z.string().max(60).optional() });
