/** Request schemas (Python app/groups/router.py). Objects are non-strict, like pydantic. */
import * as z from "zod";
import { DISCIPLINE_IDS } from "../../catalog/exercises.ts";
import { cleanOrNull } from "../social/service.ts";

const uuid = z.guid().transform((s) => s.toLowerCase());

/** A naive cursor is read as UTC; a malformed one is a 422 (Python's group feed raised a 500). */
const instant = z.iso
  .datetime({ offset: true, local: true })
  .transform((s) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`));

/** `clean_text(v) or None if v else v`, after pydantic's length checks. */
const cleaned = (min: number, max: number) => z.string().min(min).max(max).transform(cleanOrNull);
/** A required name that cleaning empties is refused (Python stored NULL into a NOT NULL column: a 500). */
const name = (min: number, max: number, msg: string) =>
  z
    .string()
    .min(min)
    .max(max)
    .transform(cleanOrNull)
    .refine((v): v is string => typeof v === "string" && v.length > 0, msg);

export const GroupId = z.object({ group_id: uuid });
export const MemberParams = z.object({ group_id: uuid, member_id: uuid });
export const AnnouncementParams = z.object({ group_id: uuid, announcement_id: uuid });
export const ChallengeId = z.object({ challenge_id: uuid });
export const CodeParam = z.object({ code: z.string() });
export const FeedQuery = z.object({ before: instant.optional() });

export const GroupIn = z.object({
  name: name(2, 60, "Give the group a name"),
  description: cleaned(0, 280).nullable().optional(),
  kind: z
    .string()
    .regex(/^(crew|coaching)$/)
    .default("crew"),
  avatar_hue: z.int().min(0).max(359).nullable().optional(),
});
export type GroupInput = z.output<typeof GroupIn>;

/** Only the keys sent are applied (exclude_unset). An explicit null name, hue or threshold is ignored. */
export const GroupPatch = z.object({
  name: name(2, 60, "Give the group a name").nullable().optional(),
  description: cleaned(0, 280).nullable().optional(),
  avatar_hue: z.int().min(0).max(359).nullable().optional(),
  // 50-100%: below half, a "shared" week would mean most of the crew missed.
  streak_threshold: z.int().min(50).max(100).nullable().optional(),
});
export type GroupPatchInput = z.output<typeof GroupPatch>;

export const JoinIn = z.object({ code: z.string().min(4).max(16) });

export const MemberPatch = z.object({ role: z.string().regex(/^(owner|admin|coach|member)$/) });

export const MembershipPatch = z.object({
  shares_with_coach: z.boolean().nullable().optional(),
  muted: z.boolean().nullable().optional(),
});

export const ChallengeIn = z.object({
  title: name(3, 60, "Give the challenge a title"),
  description: cleaned(0, 280).nullable().optional(),
  kind: z
    .string()
    .regex(/^(active_days|weekly_target|plan_sessions)$/)
    .default("active_days"),
  target: z.int().min(1).max(366).nullable().optional(),
  plan_template_id: z.string().max(40).nullable().optional(),
  plan_id: uuid.nullable().optional(),
  disciplines: z
    .array(z.string())
    .max(11)
    .default([])
    .superRefine((v, ctx) => {
      const bad = v.filter((d) => !DISCIPLINE_IDS.has(d));
      if (bad.length > 0) ctx.addIssue({ code: "custom", message: `unknown disciplines: ${bad.join(", ")}` });
    }),
  starts_on: z.iso.date(),
  ends_on: z.iso.date(),
  group_id: uuid.nullable().optional(),
});
export type ChallengeInput = z.output<typeof ChallengeIn>;

export const AssignIn = z.object({
  plan_template_id: z.string().max(40).nullable().optional(),
  plan_id: uuid.nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});
export type AssignInput = z.output<typeof AssignIn>;

export const AnnouncementIn = z.object({
  body: z.string().min(1).max(500),
  pinned: z.boolean().default(false),
});
