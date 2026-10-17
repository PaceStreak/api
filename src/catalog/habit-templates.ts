/** Ready-made habits (Python `app/habits/catalog.py`, spec/habits.md), frozen once per isolate. */
import { type DeepReadonly, deepFreeze } from "./freeze.ts";
import { HABIT_CATEGORIES_DATA, HABIT_TEMPLATES_DATA } from "./habit-templates.data.ts";
import type { HabitTemplate } from "./types.ts";

export type CatalogHabitTemplate = DeepReadonly<HabitTemplate>;

export const HABIT_CATEGORIES = deepFreeze(HABIT_CATEGORIES_DATA);
export const HABIT_TEMPLATES = deepFreeze(HABIT_TEMPLATES_DATA);
export const HABIT_TEMPLATE_BY_ID: ReadonlyMap<string, CatalogHabitTemplate> = new Map(
  HABIT_TEMPLATES.map((t) => [t.id, t]),
);

/** Habits catalogue body (Python `catalog_payload()`). */
export const HABIT_CATALOG_PAYLOAD = deepFreeze({ categories: HABIT_CATEGORIES, templates: HABIT_TEMPLATES });
