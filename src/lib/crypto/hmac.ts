/** HMAC-SHA256 / SHA-256 helpers over WebCrypto. Imported keys are cached per key buffer for the isolate. */
import { hex, utf8 } from "../b64url.ts";

type Bytes = Uint8Array<ArrayBuffer>;
const keyCache = new WeakMap<Uint8Array, Map<string, Promise<CryptoKey>>>();

/** Imports raw `key` as an HMAC key for `hash`, reusing the import for the same Uint8Array (config keys). */
export function importHmacKey(key: Uint8Array, hash: "SHA-256" | "SHA-1" = "SHA-256"): Promise<CryptoKey> {
  let byHash = keyCache.get(key);
  if (byHash === undefined) {
    byHash = new Map();
    keyCache.set(key, byHash);
  }
  let k = byHash.get(hash);
  if (k === undefined) {
    k = crypto.subtle.importKey("raw", key as Bytes, { name: "HMAC", hash }, false, ["sign", "verify"]);
    byHash.set(hash, k);
  }
  return k;
}

function asBytes(data: Uint8Array | string): Bytes {
  return (typeof data === "string" ? utf8(data) : data) as Bytes;
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await importHmacKey(key), asBytes(data)));
}

/** Lowercase hex HMAC: the stored form of recovery codes and email codes (DESIGN.md §6). */
export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array | string): Promise<string> {
  return hex(await hmacSha256(key, data));
}

/** WebCrypto's verify compares in constant time. */
export async function hmacSha256Verify(
  key: Uint8Array,
  data: Uint8Array | string,
  mac: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify("HMAC", await importHmacKey(key), mac as Bytes, asBytes(data));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(data)));
}

/** Lowercase hex SHA-256: the stored form of refresh tokens (spec/auth.md §2). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await sha256(data));
}
