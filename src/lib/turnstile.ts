/**
 * Cloudflare Turnstile siteverify (spec/core.md §2.4). Off when no secret is configured; otherwise fails closed:
 * an unreachable or garbled siteverify is a 503, never a pass.
 */
import { HttpError } from "./errors.ts";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 5000;
export const NEED_TOKEN = "Complete the verification challenge";
export const VERIFY_FAILED = "Verification failed, please try again";
export const VERIFY_UNAVAILABLE = "Verification is temporarily unavailable";

export interface TurnstileOptions {
  /** `cfg.turnstileSecret`; null turns verification off. */
  secret: string | null;
  token: string | null | undefined;
  /** The caller's IP (`clientIp`), sent as `remoteip`; null sends "". */
  remoteIp: string | null;
}

/** Throws 400 for a missing or rejected token, 503 when Cloudflare can't be asked. Resolves when it passes. */
export async function verifyTurnstile({ secret, token, remoteIp }: TurnstileOptions): Promise<void> {
  if (secret === null) return;
  if (!token) throw new HttpError(400, NEED_TOKEN);
  let payload: unknown;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp ?? "" }),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    payload = await res.json();
  } catch {
    throw new HttpError(503, VERIFY_UNAVAILABLE);
  }
  const ok = typeof payload === "object" && payload !== null && (payload as { success?: unknown }).success;
  if (!ok) throw new HttpError(400, VERIFY_FAILED);
}

/**
 * resend-verification skips the challenge only for a signed-in caller asking about their own address; anyone
 * else's address still needs a token, or a session would bypass the mailer guard.
 */
export function turnstileExempt(callerEmail: string | null, requestedEmail: string): boolean {
  return callerEmail !== null && callerEmail === requestedEmail.trim().toLowerCase();
}
