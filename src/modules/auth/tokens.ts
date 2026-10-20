/**
 * Access and MFA JWTs, refresh/CSRF token values, cookies and CSRF (spec/auth.md §1-§2, DESIGN.md §6).
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Ctx } from "../../ctx.ts";
import { type Config, SETTINGS } from "../../env.ts";
import { b64urlEncode, randomBytes } from "../../lib/b64url.ts";
import { timingSafeEqualStr } from "../../lib/crypto/consttime.ts";
import { type JwtClaims, signJwt, verifyJwt } from "../../lib/crypto/hs256.ts";
import { forbidden } from "../../lib/errors.ts";
import { UUID_RE, uuid7 } from "../../lib/uuid7.ts";

export const ACCESS_EXPIRES_IN = SETTINGS.accessTokenMinutes * 60;
export const MFA_EXPIRES_IN = SETTINGS.mfaChallengeMinutes * 60;
const COOKIE_PATH = "/v1/auth";
const COOKIE_MAX_AGE = SETTINGS.refreshTokenDays * 86_400;

/** `secrets.token_urlsafe(64)`: the raw refresh token (86 chars). */
export const newRefreshToken = () => b64urlEncode(randomBytes(64));
/** `secrets.token_urlsafe(32)`: the CSRF token (43 chars). */
export const newCsrfToken = () => b64urlEncode(randomBytes(32));

export async function accessToken(
  ctx: Ctx,
  userId: string,
  tokenVersion: number,
  sessionId: string,
): Promise<string> {
  const now = ctx.clock.now();
  const iat = Math.floor(now / 1000);
  return signJwt(ctx.cfg.jwt, {
    sub: userId,
    type: "access",
    ver: tokenVersion,
    sid: sessionId,
    jti: uuid7(now),
    iss: SETTINGS.jwtIssuer,
    aud: SETTINGS.jwtAudience,
    iat,
    exp: iat + ACCESS_EXPIRES_IN,
  });
}

export const EMAIL_MFA_EXPIRES_IN = SETTINGS.emailMfaChallengeMinutes * 60;

/** `jti` names the pending email-code challenge for email sign-ins; TOTP challenges just need it unique. */
export async function mfaToken(
  ctx: Ctx,
  userId: string,
  tokenVersion: number,
  opts: { jti?: string; expiresIn?: number } = {},
): Promise<string> {
  const now = ctx.clock.now();
  const iat = Math.floor(now / 1000);
  return signJwt(ctx.cfg.jwt, {
    sub: userId,
    type: "mfa",
    ver: tokenVersion,
    jti: opts.jti ?? uuid7(now),
    iss: SETTINGS.jwtIssuer,
    aud: SETTINGS.jwtAudience,
    iat,
    exp: iat + (opts.expiresIn ?? MFA_EXPIRES_IN),
  });
}

export interface Claims {
  userId: string;
  tokenVersion: number;
  sessionId: string | null;
  jti: string;
}

/** Null for anything that is not a valid token of `type` (the caller picks the 401 text). */
export async function readToken(ctx: Ctx, token: string, type: "access" | "mfa"): Promise<Claims | null> {
  let c: JwtClaims;
  try {
    c = await verifyJwt(token, ctx.cfg.jwt, {
      type,
      issuer: SETTINGS.jwtIssuer,
      audience: SETTINGS.jwtAudience,
      required: type === "access" ? ["sub", "ver", "sid", "jti"] : ["sub", "ver", "jti"],
      nowMs: ctx.clock.now(),
    });
  } catch {
    return null;
  }
  const { sub, ver, sid, jti } = c;
  if (typeof sub !== "string" || !UUID_RE.test(sub) || !Number.isSafeInteger(ver)) return null;
  if (type === "access" && (typeof sid !== "string" || !UUID_RE.test(sid))) return null;
  return {
    userId: sub,
    tokenVersion: ver as number,
    sessionId: typeof sid === "string" ? sid : null,
    jti: typeof jti === "string" ? jti : "",
  };
}

// ---- cookies ----------------------------------------------------------------------------------------------

export function cookieNames(cfg: Pick<Config, "cookieSecure">) {
  return cfg.cookieSecure
    ? { refresh: "__Secure-refresh_token", csrf: "__Secure-csrf_token", trusted: "__Secure-trusted_device" }
    : { refresh: "refresh_token", csrf: "csrf_token", trusted: "trusted_device" };
}

/**
 * Starlette's `set_cookie` layout (Python `http.cookies` sorts attributes): `name=value; Domain=..; expires=..;
 * HttpOnly; Max-Age=..; Path=/v1/auth; SameSite=lax; Secure`.
 */
function cookie(
  cfg: Config,
  name: string,
  value: string,
  maxAge: number,
  httpOnly: boolean,
  now: number,
): string {
  const parts = [`${name}=${value}`];
  if (cfg.cookieDomain !== null) parts.push(`Domain=${cfg.cookieDomain}`);
  parts.push(`expires=${new Date(maxAge === 0 ? 0 : now + maxAge * 1000).toUTCString()}`);
  if (httpOnly) parts.push("HttpOnly");
  parts.push(`Max-Age=${maxAge}`, `Path=${COOKIE_PATH}`, "SameSite=lax");
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function setAuthCookies(c: Context, ctx: Ctx, refresh: string, csrf: string): void {
  const n = cookieNames(ctx.cfg);
  const now = ctx.clock.now();
  c.header("Set-Cookie", cookie(ctx.cfg, n.refresh, refresh, COOKIE_MAX_AGE, true, now), { append: true });
  c.header("Set-Cookie", cookie(ctx.cfg, n.csrf, csrf, COOKIE_MAX_AGE, false, now), { append: true });
}

/**
 * Deletion with the same name, Domain and Path. Unlike Python's `delete_cookie`, it keeps `Secure` (and HttpOnly on
 * the refresh cookie): browsers ignore a `__Secure-` Set-Cookie without `Secure`, so the old code never actually
 * cleared the production cookies (CHANGES-FROM-PYTHON.md).
 */
export function clearAuthCookies(c: Context, ctx: Ctx): void {
  const n = cookieNames(ctx.cfg);
  c.header("Set-Cookie", cookie(ctx.cfg, n.refresh, '""', 0, true, 0), { append: true });
  c.header("Set-Cookie", cookie(ctx.cfg, n.csrf, '""', 0, false, 0), { append: true });
}

export function refreshCookie(c: Context, ctx: Ctx): string | undefined {
  const v = getCookie(c, cookieNames(ctx.cfg).refresh);
  return v === undefined || v === "" || v === '""' ? undefined : v;
}

/** `require_csrf`: cookie and `X-CSRF-Token` both present and equal (constant time), else 403. */
export function requireCsrf(c: Context, ctx: Ctx): void {
  const cookieValue = getCookie(c, cookieNames(ctx.cfg).csrf);
  const header = c.req.header("X-CSRF-Token");
  if (!cookieValue || !header || !timingSafeEqualStr(cookieValue, header))
    throw forbidden("Invalid CSRF token");
}

// ---- trusted device ---------------------------------------------------------------------------------------

const TRUSTED_MAX_AGE = SETTINGS.trustedDeviceDays * 86_400;

/** 32 random bytes; only its keyed hash is stored. */
export const newTrustedToken = () => b64urlEncode(randomBytes(32));

/**
 * "Trust this device": HttpOnly, the refresh cookie's Domain, Path and SameSite, 30 days. Its value is a random
 * token the server keys under PEPPER before storing, so a forged or guessed value matches no row.
 */
export function setTrustedCookie(c: Context, ctx: Ctx, token: string): void {
  const name = cookieNames(ctx.cfg).trusted;
  c.header("Set-Cookie", cookie(ctx.cfg, name, token, TRUSTED_MAX_AGE, true, ctx.clock.now()), {
    append: true,
  });
}

export function clearTrustedCookie(c: Context, ctx: Ctx): void {
  c.header("Set-Cookie", cookie(ctx.cfg, cookieNames(ctx.cfg).trusted, '""', 0, true, 0), { append: true });
}

export function trustedCookie(c: Context, ctx: Ctx): string | undefined {
  const v = getCookie(c, cookieNames(ctx.cfg).trusted);
  return v === undefined || v === "" || v === '""' || v.length > 128 ? undefined : v;
}
