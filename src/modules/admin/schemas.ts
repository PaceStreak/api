/**
 * Request schemas (Python app/admin/router.py). Python used `pattern=` for the choice fields, so they stay
 * regexes (the 422 says "String should match pattern ..."), narrowed to their unions after validation.
 */
import { z } from "zod";

const choice = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .regex(new RegExp(`^(${values.join("|")})$`))
    .transform((s) => s as T);

export const ReportsQuery = z.object({
  status: choice(["open", "actioned", "dismissed"] as const).default("open"),
});

export const ReportId = z.object({ report_id: z.uuid() });
export const UserId = z.object({ user_id: z.uuid() });

export const ResolveIn = z.object({
  action: choice(["dismiss", "hide_content", "suspend_user", "hide_and_suspend"] as const),
  note: z.string().max(200).nullable().optional(),
});

export const UsersQuery = z.object({ q: z.string().max(100).default("") });

export const UserPatch = z.object({
  role: choice(["user", "moderator", "admin"] as const)
    .nullable()
    .optional(),
  social_suspended: z.boolean().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

export const OfficialIn = z.object({
  official: z.boolean(),
  handle: z.string().max(31).nullable().optional(),
});

export const MergeIn = z.object({
  into: z.uuid(),
  confirm_email: z.string().min(3).max(320),
  keep_source_profile: z.boolean().default(false),
});
