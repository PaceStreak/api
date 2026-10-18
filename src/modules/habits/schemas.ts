/** Request schemas (Python app/habits/router.py, routines.py). Objects are non-strict, like pydantic. */
import * as z from "zod";
import { HABIT_CATEGORIES } from "../../catalog/habit-templates.ts";
import { HABIT_KINDS, ROUTINE_TIMES } from "../../db/schema/index.ts";

/**
 * A string whose length is counted in code points, as pydantic does (`.max()` counts UTF-16 units, so an emoji
 * such as "🛏️" would be three, not two). Errors render as pydantic's string_too_short / string_too_long.
 */
export const cpString = (min: number, max: number) =>
  z.string().superRefine((s, ctx) => {
    const n = Array.from(s).length;
    if (n < min)
      ctx.addIssue({ code: "too_small", origin: "string", minimum: min, inclusive: true, input: s });
    else if (n > max)
      ctx.addIssue({ code: "too_big", origin: "string", maximum: max, inclusive: true, input: s });
  });

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "f", "false", "n", "no", "off"]);

/** pydantic's lax `bool` for query and form values. */
export const laxBool = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
  }
  return v;
}, z.boolean());

export const parseLaxBool = (v: string): boolean | null => {
  const s = v.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : null;
};

const TIMES = ["morning", "afternoon", "evening", "anytime"] as const;

/** Create and PATCH body. Absent and explicit null differ (pydantic `exclude_unset`), so nothing has a default. */
export const HabitIn = z.object({
  template_id: z.string().nullable().optional(),
  name: cpString(1, 60).nullable().optional(),
  emoji: cpString(1, 8).nullable().optional(),
  category: z
    .string()
    .refine((v) => Object.hasOwn(HABIT_CATEGORIES, v), "unknown category")
    .nullable()
    .optional(),
  kind: z.enum(HABIT_KINDS).nullable().optional(),
  unit: cpString(0, 20).nullable().optional(),
  daily_goal: z.number().gt(0).max(100_000).nullable().optional(),
  weekly_target: z.int().min(1).max(7).nullable().optional(),
  time_of_day: z.enum(TIMES).nullable().optional(),
  cue: cpString(0, 120).nullable().optional(),
  why: cpString(0, 200).nullable().optional(),
  total_goal: z.number().gt(0).max(10_000_000).nullable().optional(),
  remind_hour: z.int().min(0).max(23).nullable().optional(),
  days_mask: z.int().min(1).max(127).nullable().optional(),
});
export type HabitInput = z.infer<typeof HabitIn>;

export const HabitId = z.object({ id: z.guid().transform((s) => s.toLowerCase()) });
export const HabitDay = z.object({ id: z.guid().transform((s) => s.toLowerCase()), day: z.iso.date() });

export const ListQuery = z.object({ archived: laxBool.default(false) });
export const DetailQuery = z.object({ days: z.coerce.number().int().min(7).max(730).default(365) });
export const StatsQuery = z.object({ weeks: z.coerce.number().int().min(4).max(52).default(26) });

export const DayIn = z.object({
  amount: z.number().min(0).max(100_000),
  note: cpString(0, 280).nullable().optional(),
});
export type DayInput = z.infer<typeof DayIn>;

export const AddIn = z.object({ amount: z.number().gt(0).max(100_000).default(1) });

export const BACKFILL_DAYS = 60;
export const BulkIn = z.object({
  days: z
    .array(z.object({ date: z.iso.date(), amount: z.number().min(0).max(100_000) }))
    .min(1)
    .max(BACKFILL_DAYS + 1),
});

export const PauseIn = z.object({
  start: z.iso.date().nullable().optional(),
  until: z.iso.date().nullable().optional(),
});

export const SnoozeIn = z.object({ minutes: z.int().min(15).max(240) });

export const MAX_HABITS = 30;
export const OrderIn = z.object({
  ids: z.array(z.guid().transform((s) => s.toLowerCase())).max(MAX_HABITS * 3),
});

export const ActionQuery = z.object({
  a: z.string(),
  u: z.guid().transform((s) => s.toLowerCase()),
  d: z.iso.date(),
  e: z.coerce.number().int(),
  s: z.string(),
});

// ---- routines -------------------------------------------------------------------------------------------------

export const MAX_ROUTINES = 10;
export const MAX_STEPS = 20;

export const RoutineIn = z.object({
  name: cpString(1, 60),
  emoji: cpString(1, 8).default("🌅"),
  time_of_day: z.enum(ROUTINE_TIMES).default("morning"),
  habit_ids: z
    .array(z.guid().transform((s) => s.toLowerCase()))
    .min(1)
    .max(MAX_STEPS),
});
export type RoutineInput = z.infer<typeof RoutineIn>;
