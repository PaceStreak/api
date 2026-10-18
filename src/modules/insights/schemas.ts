/** Request schemas (Python app/insights/router.py). Objects are non-strict, like pydantic. */
import { z } from "zod";

export const JournalQuery = z.object({
  days: z.coerce.number().int().min(1).max(1100).default(366),
  q: z.string().max(60).optional(),
});

export const JournalDay = z.object({ day: z.iso.date() });

export const JournalIn = z.object({
  mood: z.int().min(1).max(5).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});
