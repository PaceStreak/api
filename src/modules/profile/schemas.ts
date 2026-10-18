/** Request schemas (Python app/profile/router.py). Objects are non-strict, like pydantic. */
import * as z from "zod";

const unit = (re: RegExp) => z.string().regex(re);
const WEIGHT = /^(kg|lb)$/;
const DISTANCE = /^(km|mi)$/;
const VISIBILITY = /^(private|followers|public)$/;

export const OnboardingIn = z.object({
  handle: z.string().min(3).max(31),
  display_name: z.string().max(50).nullable().optional(),
  birth_year: z.int().min(1900).max(2100),
  accept_terms: z.boolean(),
  timezone: z.string().default("UTC"),
  week_starts_on: z.int().min(0).max(6).default(0),
  weight_unit: unit(WEIGHT).default("kg"),
  distance_unit: unit(DISTANCE).default("km"),
  weekly_target: z.int().min(1).max(7).default(3),
  visibility: unit(VISIBILITY).default("followers"),
});
export type OnboardingInput = z.infer<typeof OnboardingIn>;

export const TermsIn = z.object({ version: z.string().max(20) });

/** pydantic's `@field_validator` strips after the length check. */
const stripped = (n: number) =>
  z
    .string()
    .max(n)
    .transform((s) => s.trim());

/** Every field optional; absent and `null` differ (Python `exclude_unset`). */
export const ProfilePatch = z.object({
  handle: z.string().max(31).nullable().optional(),
  display_name: stripped(50).nullable().optional(),
  bio: stripped(160).nullable().optional(),
  avatar_hue: z.int().min(0).max(359).nullable().optional(),
  timezone: z.string().nullable().optional(),
  week_starts_on: z.int().min(0).max(6).nullable().optional(),
  weight_unit: unit(WEIGHT).nullable().optional(),
  distance_unit: unit(DISTANCE).nullable().optional(),
  training_days: z.int().min(0).max(127).nullable().optional(),
  max_hr: z.int().min(100).max(230).nullable().optional(),
  life_target: z.int().min(1).max(7).nullable().optional(),
  favourite_disciplines: z.array(z.string()).max(20).nullable().optional(),
  visibility: unit(VISIBILITY).nullable().optional(),
  sharing_paused: z.boolean().nullable().optional(),
  gamification_enabled: z.boolean().nullable().optional(),
  leaderboard_opt_in: z.boolean().nullable().optional(),
  reminder_hour: z.int().min(0).max(23).nullable().optional(),
  reminder_mode: unit(/^(fixed|smart)$/)
    .nullable()
    .optional(),
  quiet_start: z.int().min(0).max(23).nullable().optional(),
  quiet_end: z.int().min(0).max(23).nullable().optional(),
  quiet_days: z.int().min(0).max(127).nullable().optional(),
  weekly_target: z.int().min(1).max(7).nullable().optional(),
});
export type ProfilePatchInput = z.infer<typeof ProfilePatch>;

export const HandleParam = z.object({ handle: z.string() });
