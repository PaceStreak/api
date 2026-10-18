/**
 * Signed links behind a reminder's "Done" and "Snooze" buttons (Python `app/habits/actions.py`).
 *
 * The service worker that handles a push has no access token, so the action URL carries an HMAC instead,
 * scoped to one user, one habit, one action and one day, and expiring after 18 hours.
 */
import type { Ctx } from "../../ctx.ts";
import { timingSafeEqualStr } from "../../lib/crypto/consttime.ts";
import { hmacSha256, hmacSha256Hex } from "../../lib/crypto/hmac.ts";

export const ACTIONS = ["done", "snooze"] as const;
export type HabitAction = (typeof ACTIONS)[number];
export const LIFETIME_SECONDS = 18 * 3600;

const secrets = new WeakMap<Uint8Array, Promise<Uint8Array>>();

/** Derived from PEPPER (Python derived it from the RS256 key, which no longer exists): rotating it rotates these. */
function secret(ctx: Ctx): Promise<Uint8Array> {
  let s = secrets.get(ctx.cfg.pepper);
  if (s === undefined) {
    s = hmacSha256(ctx.cfg.pepper, "habit-action");
    secrets.set(ctx.cfg.pepper, s);
  }
  return s;
}

/** 40 hex characters of HMAC-SHA256 over `user:habit:action:day:expires` (UUIDs lowercase), as in Python. */
export async function sign(
  ctx: Ctx,
  userId: string,
  habitId: string,
  action: string,
  day: string,
  expires: number,
): Promise<string> {
  const message = `${userId.toLowerCase()}:${habitId.toLowerCase()}:${action}:${day}:${expires}`;
  return (await hmacSha256Hex(await secret(ctx), message)).slice(0, 40);
}

export async function verify(
  ctx: Ctx,
  userId: string,
  habitId: string,
  action: string,
  day: string,
  expires: number,
  sig: string,
): Promise<boolean> {
  if (!(ACTIONS as readonly string[]).includes(action)) return false;
  if (expires < ctx.clock.now() / 1000) return false;
  return timingSafeEqualStr(await sign(ctx, userId, habitId, action, day, expires), sig);
}

/** The URL a reminder push carries for one button (the habit reminder job builds two). */
export async function actionUrl(
  ctx: Ctx,
  userId: string,
  habitId: string,
  action: HabitAction,
  day: string,
): Promise<string> {
  const expires = Math.floor(ctx.clock.now() / 1000) + LIFETIME_SECONDS;
  const sig = await sign(ctx, userId, habitId, action, day, expires);
  const base = ctx.cfg.publicApiUrl.replace(/\/+$/, "");
  return `${base}/v1/habits/${habitId}/action?a=${action}&u=${userId}&d=${day}&e=${expires}&s=${sig}`;
}
