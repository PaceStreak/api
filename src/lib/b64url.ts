/** base64 / base64url over bytes, without Node's Buffer. */

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts padded or unpadded input. Throws on characters outside the base64url alphabet. */
export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("invalid base64url");
  const std = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(std + "=".repeat((4 - (std.length % 4)) % 4));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
