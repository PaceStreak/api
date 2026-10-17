/**
 * HS256 JWTs with a kid key ring (DESIGN.md §6 "Tokens"). Sign with the ring's current key; verify with the
 * key the header's `kid` names, so a key can be rotated in without invalidating live tokens.
 * Verification mirrors PyJWT as the Python service used it (spec/auth.md §2): alg pinned, iss/aud checked,
 * required claims enforced, `exp <= now` is expired, leeway 0, and `type` must match.
 */
import { b64urlDecode, b64urlEncode, utf8 } from "../b64url.ts";
import { hmacSha256, hmacSha256Verify } from "./hmac.ts";

export interface KeyRing {
  current: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export type JwtClaims = Record<string, unknown> & { exp: number; iat: number; type: string };

export type JwtErrorCode = "malformed" | "unknown_kid" | "bad_signature" | "expired" | "invalid_claims";

export class JwtError extends Error {
  constructor(readonly code: JwtErrorCode) {
    super(`invalid token: ${code}`);
    this.name = "JwtError";
  }
}

export interface VerifyOptions {
  /** Required `type` claim ("access" or "mfa"). */
  type: string;
  issuer: string;
  audience: string;
  /** Claims that must be present besides exp, iat, iss, aud and type. */
  required?: readonly string[];
  /** Current time in epoch ms (`ctx.clock.now()`). */
  nowMs: number;
}

const encodePart = (v: unknown) => b64urlEncode(utf8(JSON.stringify(v)));

export async function signJwt(ring: KeyRing, claims: JwtClaims): Promise<string> {
  const key = ring.keys.get(ring.current);
  if (key === undefined) throw new Error("JWT key ring has no current key");
  const input = `${encodePart({ alg: "HS256", typ: "JWT", kid: ring.current })}.${encodePart(claims)}`;
  return `${input}.${b64urlEncode(await hmacSha256(key, input))}`;
}

function decodePart(part: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64urlDecode(part)));
  } catch {
    throw new JwtError("malformed");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new JwtError("malformed");
  return v as Record<string, unknown>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Returns the claims or throws JwtError. The signature is checked before any claim is trusted. */
export async function verifyJwt(token: string, ring: KeyRing, opts: VerifyOptions): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = decodePart(h);
  if (header.alg !== "HS256") throw new JwtError("malformed");
  if (typeof header.kid !== "string") throw new JwtError("unknown_kid");
  const key = ring.keys.get(header.kid);
  if (key === undefined) throw new JwtError("unknown_kid");
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(s);
  } catch {
    throw new JwtError("malformed");
  }
  if (!(await hmacSha256Verify(key, `${h}.${p}`, sig))) throw new JwtError("bad_signature");

  const c = decodePart(p);
  for (const name of ["exp", "iat", "iss", "aud", "type", ...(opts.required ?? [])]) {
    if (!(name in c)) throw new JwtError("invalid_claims");
  }
  if (!isNum(c.exp) || !isNum(c.iat)) throw new JwtError("invalid_claims");
  const nowSec = Math.floor(opts.nowMs / 1000);
  if (c.exp <= nowSec) throw new JwtError("expired");
  if ("nbf" in c && (!isNum(c.nbf) || c.nbf > nowSec)) throw new JwtError("invalid_claims");
  if (c.iss !== opts.issuer) throw new JwtError("invalid_claims");
  const aud = c.aud;
  if (Array.isArray(aud) ? !aud.includes(opts.audience) : aud !== opts.audience) {
    throw new JwtError("invalid_claims");
  }
  if (c.type !== opts.type) throw new JwtError("invalid_claims");
  return c as JwtClaims;
}
