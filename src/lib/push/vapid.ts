/**
 * RFC 8292 VAPID: an ES256 JWT `{aud: origin(endpoint), exp: now + 12h, sub}` sent as
 * `Authorization: vapid t=<jwt>, k=<public key>`. One signer per invocation caches the imported key and one JWT
 * per audience origin (DESIGN.md §11), so a fan-out to many endpoints on one push service signs once.
 */
import { b64urlEncode, utf8 } from "../b64url.ts";

export interface VapidConfig {
  /** Private key as a JWK JSON string (EC P-256 with `d`, `x`, `y`). */
  privateJwk: string;
  /** base64url (no padding) of the uncompressed P-256 public point: the app's applicationServerKey. */
  publicKey: string;
  /** `mailto:` or `https:` contact for the push service. */
  subject: string;
}

export const VAPID_TTL_SECONDS = 12 * 60 * 60;
/** A cached token is re-signed once less than this much of its life is left. */
const REFRESH_MARGIN_SECONDS = 60 * 60;

export interface VapidSigner {
  /** The `Authorization` header value for a request to `endpoint`. */
  authorization(endpoint: string): Promise<string>;
}

export function createVapidSigner(cfg: VapidConfig, now: () => number): VapidSigner {
  let key: Promise<CryptoKey> | null = null;
  const cache = new Map<string, { value: string; exp: number }>();
  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));

  const privateKey = (): Promise<CryptoKey> => {
    key ??= crypto.subtle.importKey(
      "jwk",
      JSON.parse(cfg.privateJwk) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return key;
  };

  return {
    async authorization(endpoint) {
      const aud = new URL(endpoint).origin;
      const nowS = Math.floor(now() / 1000);
      const hit = cache.get(aud);
      if (hit !== undefined && hit.exp - nowS > REFRESH_MARGIN_SECONDS) return hit.value;
      const exp = nowS + VAPID_TTL_SECONDS;
      const input = `${header}.${b64urlEncode(utf8(JSON.stringify({ aud, exp, sub: cfg.subject })))}`;
      // WebCrypto ECDSA emits raw r||s (IEEE P1363), which is exactly the JWS ES256 signature format.
      const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        await privateKey(),
        utf8(input),
      );
      const value = `vapid t=${input}.${b64urlEncode(new Uint8Array(sig))}, k=${cfg.publicKey}`;
      cache.set(aud, { value, exp });
      return value;
    },
  };
}
