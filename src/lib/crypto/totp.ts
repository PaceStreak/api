/**
 * TOTP (RFC 6238 over RFC 4226): HMAC-SHA1, 6 digits, 30 s steps, pyotp defaults (spec/auth.md §4).
 * Secrets are 20 random bytes, shown to the user as unpadded RFC 4648 base32.
 */
import { randomBytes } from "../b64url.ts";
import { timingSafeEqualStr } from "./consttime.ts";
import { importHmacKey } from "./hmac.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

type Bytes = Uint8Array<ArrayBuffer>;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; ignores whitespace and `=` padding. Throws on any other character. */
export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new secret as base32 (32 characters for 20 bytes). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 4226 HOTP. `hash` exists for the RFC 6238 SHA-256 vectors; the product only uses SHA-1. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
  hash: "SHA-1" | "SHA-256" = "SHA-1",
): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await importHmacKey(secret, hash);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as Bytes));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** The code for the step containing `nowMs`. */
export async function totpAt(secretB32: string, nowMs: number): Promise<string> {
  return hotp(base32Decode(secretB32), totpStep(nowMs));
}

/**
 * The step `code` is valid for within ±`window` steps (checked -1, 0, +1 like Python), or null. Spaces are
 * stripped first. The caller enforces replay protection by rejecting a step <= `totp_last_used_step`.
 * An empty or undecodable secret never matches (a failed decrypt arrives here as "").
 */
export async function findTotpStep(
  secretB32: string,
  code: string,
  nowMs: number,
  window = 1,
): Promise<number | null> {
  const clean = code.trim().replace(/ /g, "");
  if (secretB32 === "" || clean === "") return null;
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretB32);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  for (let off = -window; off <= window; off++) {
    // Every step is compared even after a match, so timing does not reveal which one matched.
    const ok = timingSafeEqualStr(await hotp(secret, now + off), clean);
    if (ok && found === null) found = now + off;
  }
  return found;
}

/** The otpauth:// URI for authenticator apps, in pyotp's `provisioning_uri(name, issuer_name)` layout. */
export function totpProvisioningUri(secretB32: string, accountName: string, issuer: string): string {
  const q = encodeURIComponent;
  return `otpauth://totp/${q(issuer)}:${q(accountName)}?secret=${secretB32}&issuer=${q(issuer)}`;
}
