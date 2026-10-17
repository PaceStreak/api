/**
 * Password hashing (OWNER-DECISIONS: PBKDF2-SHA256, 100k iterations, pepper; DESIGN.md §6).
 *
 * Format: `pbkdf2-sha256$v=1$i=<iterations>$<salt b64url 16B>$<dk b64url 32B>`.
 * The PBKDF2 input is `HMAC-SHA256(PEPPER, password)`, so a database dump alone cannot be brute-forced.
 * Verify reads `i` from the string, so the iteration count can change without a migration: `needsRehash`
 * tells the login path to re-hash a stale string. 100,000 is the Workers WebCrypto ceiling (higher throws).
 */
import { b64urlDecode, b64urlEncode, randomBytes } from "../b64url.ts";
import { timingSafeEqualBytes } from "./consttime.ts";
import { hmacSha256 } from "./hmac.ts";

export const PBKDF2_ITERATIONS = 100_000;
/** Workers rejects more than this many iterations (NotSupportedError). */
export const PBKDF2_MAX_ITERATIONS = 100_000;
const SCHEME = "pbkdf2-sha256";
const VERSION = 1;
const SALT_BYTES = 16;
const DK_BYTES = 32;
const FORMAT = /^pbkdf2-sha256\$v=(\d{1,9})\$i=(\d{1,9})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

type Bytes = Uint8Array<ArrayBuffer>;

export interface ParsedPasswordHash {
  version: number;
  iterations: number;
  salt: Uint8Array;
  dk: Uint8Array;
}

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const m = FORMAT.exec(stored);
  if (m === null) return null;
  const version = Number(m[1]);
  const iterations = Number(m[2]);
  if (version !== VERSION || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) return null;
  try {
    const salt = b64urlDecode(m[3] ?? "");
    const dk = b64urlDecode(m[4] ?? "");
    if (salt.length !== SALT_BYTES || dk.length !== DK_BYTES) return null;
    return { version, iterations, salt, dk };
  } catch {
    return null;
  }
}

async function derive(
  password: string,
  pepper: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const peppered = await hmacSha256(pepper, password);
  const base = await crypto.subtle.importKey("raw", peppered as Bytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Bytes, iterations },
    base,
    DK_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  pepper: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(`iterations must be 1..${PBKDF2_MAX_ITERATIONS}`);
  }
  const salt = randomBytes(SALT_BYTES);
  const dk = await derive(password, pepper, salt, iterations);
  return `${SCHEME}$v=${VERSION}$i=${iterations}$${b64urlEncode(salt)}$${b64urlEncode(dk)}`;
}

/** False for a wrong password and for any unparseable string (never throws, like pwdlib's verify). */
export async function verifyPassword(stored: string, password: string, pepper: Uint8Array): Promise<boolean> {
  const p = parsePasswordHash(stored);
  if (p === null) return false;
  const dk = await derive(password, pepper, p.salt, p.iterations);
  return timingSafeEqualBytes(dk, p.dk);
}

/** True when the string should be replaced on the next successful login. */
export function needsRehash(stored: string, iterations: number = PBKDF2_ITERATIONS): boolean {
  const p = parsePasswordHash(stored);
  return p === null || p.iterations < iterations;
}

const dummyHashes = new WeakMap<Uint8Array, Promise<string>>();

/**
 * A per-isolate hash of a random password, verified against on unknown-email login so the response
 * takes as long as a real one (DESIGN.md §6, timing parity).
 */
export function dummyPasswordHash(pepper: Uint8Array): Promise<string> {
  let h = dummyHashes.get(pepper);
  if (h === undefined) {
    h = hashPassword(b64urlEncode(randomBytes(24)), pepper);
    dummyHashes.set(pepper, h);
  }
  return h;
}
