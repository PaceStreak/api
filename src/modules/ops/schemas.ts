/** Request schemas (Python app/ops/router.py). */
import { z } from "zod";

export const ClientErrorIn = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(20_000).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  release: z.string().max(40).nullable().optional(),
});

/** A raw string, as in Python: a malformed id is simply not found. */
export const ErrorId = z.object({ error_id: z.string() });
