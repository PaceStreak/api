/** Request schemas (Python app/social/router.py, app/social/buddies.py). Objects are non-strict, like pydantic. */
import * as z from "zod";
import { REACTIONS } from "../../db/schema/social.ts";
import { cleanText, decodeCursor, type FeedCursor } from "./people.ts";

export const uuid = z.guid().transform((s) => s.toLowerCase());

/** A cursor: the `next` a page returned (ISO instant); a naive value is read as UTC. */
export const instant = z.iso
  .datetime({ offset: true, local: true })
  .transform((s) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`));

export const HandleParam = z.object({ handle: z.string() });
export const EventId = z.object({ event_id: uuid });
export const CommentId = z.object({ comment_id: uuid });
export const PairId = z.object({ pair_id: uuid });
/** `decision` is checked in the handler: anything but accept/decline is a 404, as in Python. */
export const RequestParams = z.object({ request_id: uuid, decision: z.string() });

/**
 * A feed cursor: the opaque `next` a page returned (base64url `(created_at, id)`), or the old ISO instant, which
 * still pages by time alone. Anything else is a 422.
 */
export const feedCursor = z.string().transform((s, c): FeedCursor => {
  const composite = decodeCursor(s);
  if (composite !== null) return composite;
  const old = instant.safeParse(s);
  if (old.success && Number.isFinite(old.data)) return { at: old.data, id: null };
  c.issues.push({ code: "custom", message: "Invalid cursor", input: s });
  return z.NEVER;
});

export const BeforeQuery = z.object({ before: feedCursor.optional() });
export const SearchQuery = z.object({ q: z.string().min(1).max(40) });

/** Pydantic checks the length first, then the cleaned text must not be empty. */
export const CommentIn = z.object({
  body: z
    .string()
    .min(1)
    .max(280)
    .transform(cleanText)
    .refine((v) => v.length > 0, "Say something"),
});
export type CommentInput = z.output<typeof CommentIn>;

export const KudosIn = z.object({ reaction: z.enum(REACTIONS).default("kudos") });
export type Reaction = (typeof REACTIONS)[number];

export const ReportIn = z.object({
  target_type: z.string().regex(/^(user|comment|event|group|challenge)$/),
  target_id: z.string().min(1).max(64),
  reason: z.string().regex(/^(spam|harassment|inappropriate|impersonation|self_harm|other)$/),
  detail: z.string().max(500).nullable().optional(),
});
export type ReportInput = z.output<typeof ReportIn>;

export const InviteIn = z.object({ handle: z.string().min(1).max(31) });
export const EncourageIn = z.object({ preset: z.string().max(20) });
