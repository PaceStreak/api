/** Request schemas (Python app/game/router.py, leaderboards.py). Objects are non-strict, like pydantic. */
import { z } from "zod";

export const WagerIn = z.object({ week: z.enum(["this", "next"]) });

export const WagerWeek = z.object({ week: z.iso.date() });

export const MonthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const RecapQuery = z.object({ week: z.iso.date().optional() });

export const ReviewQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export const HistoryQuery = z.object({ key: z.string().max(100) });

export const ProgressQuery = z.object({ weeks: z.coerce.number().int().min(4).max(104).default(12) });

export const BoardParam = z.object({ board: z.string() });

export const BoardQuery = z.object({
  scope: z
    .string()
    .regex(/^(global|following|group|similar)$/)
    .default("global"),
  group_id: z.guid().optional(),
});
