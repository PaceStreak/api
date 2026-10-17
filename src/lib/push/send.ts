/**
 * One Web Push delivery and what it means for the stored subscription (DESIGN.md §11, spec/misc.md §2):
 * 404/410 delete it, 2xx resets its failure count, anything else (other statuses, redirects, timeouts, transport
 * errors) increments it and deletes it at the tenth failure. The caller applies the outcome in its write batch;
 * this module never touches D1.
 */
import { encryptPayload, type PushKeys } from "./encrypt.ts";
import { isSafePushEndpoint } from "./guard.ts";
import type { VapidSigner } from "./vapid.ts";

export const PUSH_TTL_SECONDS = 43200;
export const PUSH_TIMEOUT_MS = 10_000;
export const MAX_FAILURES = 10;

export interface PushTarget extends PushKeys {
  endpoint: string;
  /** Stored consecutive failure count before this attempt. */
  failures: number;
}

export type PushOutcome =
  | { kind: "delivered" }
  | { kind: "delete"; reason: "gone" | "unsafe" | "failures" }
  | { kind: "failed"; failures: number; status: number };

export interface SendDeps {
  signer: VapidSigner;
  allowlist: readonly string[];
}

/** Status 0 stands for "no HTTP answer" (timeout, transport error), as in the Python worker. */
export function outcomeFor(status: number, failures: number): PushOutcome {
  if (status === 404 || status === 410) return { kind: "delete", reason: "gone" };
  if (status >= 200 && status < 300) return { kind: "delivered" };
  const next = failures + 1;
  return next >= MAX_FAILURES
    ? { kind: "delete", reason: "failures" }
    : { kind: "failed", failures: next, status };
}

export async function sendPush(deps: SendDeps, target: PushTarget, payload: string): Promise<PushOutcome> {
  // Re-checked at send time: the allowlist may have shrunk since the subscription was stored.
  if (!isSafePushEndpoint(target.endpoint, deps.allowlist)) return { kind: "delete", reason: "unsafe" };
  let status = 0;
  try {
    const body = await encryptPayload(payload, target);
    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await deps.signer.authorization(target.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_SECONDS),
      },
      body,
      // A redirect could point anywhere, guard or not; it counts as a failure.
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    status = res.status;
    await res.body?.cancel();
  } catch {
    status = 0;
  }
  return outcomeFor(status, target.failures);
}
