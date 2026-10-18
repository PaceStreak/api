/** Request schemas (Python app/notifications/router.py). Objects are non-strict, like pydantic. */
import { z } from "zod";

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "f", "false", "n", "no", "off"]);

/** pydantic's lax `bool`: true/false, 0/1 and the usual strings; anything else is a 422. */
const laxBool = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
  }
  if (v === 0 || v === 1) return v === 1;
  return v;
}, z.boolean());

/** A naive datetime is read as UTC (the column holds UTC instants). */
const instant = z.iso
  .datetime({ offset: true, local: true })
  .transform((s) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`));

export const InboxQuery = z.object({
  before: instant.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const ReadIn = z.object({ ids: z.array(z.guid()).max(200).nullable().optional() });

export const PreferencesIn = z.object({
  channels: z.record(z.string(), z.record(z.string(), laxBool)).nullable().optional(),
  habit_summary_hour: z.int().min(0).max(23).nullable().optional(),
  backup_attachment: z.boolean().nullable().optional(),
  backup_frequency: z.enum(["monthly", "weekly"]).nullable().optional(),
});
export type PreferencesInput = z.infer<typeof PreferencesIn>;

export const SubscriptionIn = z.object({
  endpoint: z
    .string()
    .min(10)
    .max(2000)
    .regex(/^https:\/\//),
  keys: z.record(z.string(), z.string()),
});

export const PushUnsubscribeIn = z.object({ endpoint: z.string().max(2000) });

export const EmailUnsubscribeIn = z.object({ u: z.guid(), c: z.string(), s: z.string().max(64) });
export type EmailUnsubscribeInput = z.infer<typeof EmailUnsubscribeIn>;
