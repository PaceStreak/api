/**
 * Constant-time comparison (DESIGN.md §6: CSRF, TOTP codes, token hashes).
 * Built on workerd's `crypto.subtle.timingSafeEqual`, which throws on a length mismatch; a mismatch is
 * answered `false` after a same-length self-compare so the early exit does not skip the comparison work.
 */
import { utf8 } from "../b64url.ts";

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    crypto.subtle.timingSafeEqual(a, a);
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Compares UTF-8 encodings. Only the lengths can leak, never the content. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqualBytes(utf8(a), utf8(b));
}
