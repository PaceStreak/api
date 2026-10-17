/**
 * HTTP helpers for route tests, through the real Worker entry (`SELF`), so middleware order, CORS, errors and
 * the config gate are all exercised.
 */
import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const BASE = "https://api.pacestreak.test";
export const APP_ORIGIN = "https://app.pacestreak.com";

export interface CallOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  /** `Authorization: Bearer <token>` once AUTH lands. */
  token?: string;
}

export function api(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  // Per-IP limits are real in tests: a fresh address per call keeps unrelated tests from sharing a bucket.
  headers["CF-Connecting-IP"] ??= randomIp();
  return SELF.fetch(`${BASE}${path}`, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export function randomIp(): string {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

export async function jsonOf<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Asserts the D1 round trips a request spent (from the `X-D1-Round-Trips` header the app adds in the test
 * environment only). Budgets come from DESIGN.md §17: auth-gated read 1, simple write 1-2, workout write 2.
 */
export function expectRoundTrips(res: Response, max: number): void {
  const n = Number(res.headers.get("X-D1-Round-Trips"));
  expect(Number.isNaN(n), "X-D1-Round-Trips header missing").toBe(false);
  expect(n, `D1 round trips for ${res.url}`).toBeLessThanOrEqual(max);
}
