/** Request schemas (Python app/search/router.py). */
import * as z from "zod";

/** 2..60 characters, checked before stripping (FastAPI validates the raw query value). */
export const SearchQuery = z.object({ q: z.string().min(2).max(60) });
export const DayParam = z.object({ day: z.iso.date() });
