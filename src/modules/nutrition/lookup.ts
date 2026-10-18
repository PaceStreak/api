/**
 * Barcode -> nutrition, from Open Food Facts (open data, no account, no key). Python `app/nutrition/lookup.py`.
 *
 * Only the barcode leaves this server: no user id, no cookie, nothing that says who scanned it. Answers are cached
 * in the Workers Cache API (Redis in Python) - hits for a month, misses for a day - so a popular product is fetched
 * once per colo, not once per person.
 */
import type { Ctx } from "../../ctx.ts";
import { formatG, pyRound } from "../../lib/format.ts";

export const HIT_TTL_SEC = 30 * 86400;
export const MISS_TTL_SEC = 86400;
const TIMEOUT_MS = 5000;
const FIELDS = "product_name,brands,nutriments,serving_quantity,serving_size";
const USER_AGENT = "PaceStreak/1.0 (hello@pacestreak.com)";
/** Never fetched: only a Cache API key. */
const CACHE_ORIGIN = "https://food-lookup.cache.pacestreak.internal/";

export interface Product {
  name: string;
  brand: string | null;
  serving_label: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

/** Open Food Facts could not be reached; distinct from "not found". */
export class LookupUnavailable extends Error {
  constructor(cause?: unknown) {
    super("food lookup unavailable", cause === undefined ? undefined : { cause });
  }
}

const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:e[+-]?\d(?:_?\d)*)?|(?:\d(?:_?\d)*)\.)$/i;
const PY_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;

/** Python `float(v)`, then None when negative (or NaN, which compares false). */
function num(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "boolean") n = v ? 1 : 0;
  else if (typeof v === "string") {
    const s = v.trim();
    if (PY_SPECIAL.test(s)) n = /nan/i.test(s) ? Number.NaN : s.startsWith("-") ? -Infinity : Infinity;
    else if (PY_FLOAT.test(s)) n = Number(s.replaceAll("_", ""));
    else return null;
  } else return null;
  return n >= 0 ? n : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/**
 * Per serving when the product says what a serving is, else per 100 g. Null when there is no energy figure at all:
 * a food without calories is no use to a calorie log.
 */
export function parseProduct(product: Record<string, unknown>): Product | null {
  const raw = product.nutriments;
  const n: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = str(product.product_name).trim();
  if (!name) return null;
  const serving = num(product.serving_quantity);
  let suffix: string;
  let label: string;
  if (serving && num(n["energy-kcal_serving"]) !== null) {
    suffix = "_serving";
    label = cut(str(product.serving_size) || `${formatG(serving)} g`, 40);
  } else if (num(n["energy-kcal_100g"]) !== null) {
    suffix = "_100g";
    label = "100 g";
  } else return null;
  const macro = (key: string) => pyRound(num(n[key + suffix]) || 0, 1);
  return {
    name: cut(name, 120),
    brand: (str(product.brands).split(",")[0] ?? "").trim() || null,
    serving_label: label,
    kcal: macro("energy-kcal"),
    protein_g: macro("proteins"),
    carbs_g: macro("carbohydrates"),
    fat_g: macro("fat"),
  };
}

function cache(): Cache | null {
  try {
    return (caches as unknown as { default: Cache }).default;
  } catch {
    return null;
  }
}

/** The product's nutrition, or null if it isn't known. Throws LookupUnavailable when unreachable. */
export async function fetchProduct(ctx: Ctx, barcode: string, url: string): Promise<Product | null> {
  const key = new Request(CACHE_ORIGIN + barcode);
  const store = cache();
  try {
    const hit = await store?.match(key);
    if (hit !== undefined) {
      const body = (await hit.json()) as Partial<Product>;
      return body.name === undefined ? null : (body as Product);
    }
  } catch {
    // A cache failure is a cache miss.
  }
  let found: Product | null;
  try {
    const target = new URL(url.replace("{barcode}", barcode));
    target.searchParams.set("fields", FIELDS);
    const res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) found = null;
    else {
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { status?: unknown; product?: unknown };
      const product = data.product;
      const obj = product !== null && typeof product === "object" ? (product as Record<string, unknown>) : {};
      found = data.status === 1 ? parseProduct(obj) : null;
    }
  } catch (err) {
    ctx.log.warn("food lookup failed", { error: err instanceof Error ? err.message : String(err) });
    throw new LookupUnavailable(err);
  }
  if (store !== null) {
    const ttl = found === null ? MISS_TTL_SEC : HIT_TTL_SEC;
    const value = Response.json(found ?? {}, { headers: { "Cache-Control": `public, max-age=${ttl}` } });
    ctx.defer(store.put(key, value));
  }
  return found;
}
