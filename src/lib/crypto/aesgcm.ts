/**
 * AES-256-GCM for small secrets at rest (TOTP secrets under DATA_KEY, DESIGN.md §6).
 * Format `v1.<iv b64url 12B>.<ciphertext+tag b64url>`. Optional `aad` binds a ciphertext to its context
 * (for example the owning user id) so it cannot be copied to another row.
 */
import { b64urlDecode, b64urlEncode, randomBytes, utf8 } from "../b64url.ts";

type Bytes = Uint8Array<ArrayBuffer>;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function aesKey(key: Uint8Array): Promise<CryptoKey> {
  let k = keyCache.get(key);
  if (k === undefined) {
    if (key.length !== 32) throw new RangeError("AES-256-GCM needs a 32-byte key");
    k = crypto.subtle.importKey("raw", key as Bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(key, k);
  }
  return k;
}

function params(iv: Uint8Array, aad: string | undefined): SubtleCryptoEncryptAlgorithm {
  return aad === undefined
    ? { name: "AES-GCM", iv: iv as Bytes }
    : { name: "AES-GCM", iv: iv as Bytes, additionalData: utf8(aad) as Bytes };
}

export async function encryptString(key: Uint8Array, plaintext: string, aad?: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(params(iv, aad), await aesKey(key), utf8(plaintext) as Bytes);
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

/**
 * Null for anything that does not decrypt (wrong key, tampering, wrong aad, malformed): callers treat it
 * as "no secret", as the Python service did with Fernet's InvalidToken.
 */
export async function decryptString(key: Uint8Array, stored: string, aad?: string): Promise<string | null> {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const iv = b64urlDecode(parts[1] ?? "");
    const ct = b64urlDecode(parts[2] ?? "");
    if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) return null;
    const pt = await crypto.subtle.decrypt(params(iv, aad), await aesKey(key), ct as Bytes);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(pt);
  } catch {
    return null;
  }
}
