/**
 * Cloudflare Turnstile siteverify (spec/core.md §2.4). Off when no secret is configured; otherwise fails closed:
 * an unreachable or garbled siteverify is a 503, never a pass. A failed attempt (network error, timeout, 5xx or
 * non-JSON) is retried once, so one dropped connection doesn't fail a sign-in; a definite answer is never retried.
 */
import { HttpError } from "./errors.ts";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 4000;
export const TURNSTILE_ATTEMPTS = 2;
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
  const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp ?? "" });
  let payload: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      });
      if (res.status >= 500) throw new Error(`siteverify ${res.status}`);
      payload = await res.json();
      break;
    } catch {
      if (attempt >= TURNSTILE_ATTEMPTS) throw new HttpError(503, VERIFY_UNAVAILABLE);
    }
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
