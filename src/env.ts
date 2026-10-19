/**
 * Configuration: vars and secrets from `Env`, zod-parsed once per isolate (DESIGN.md §2 "Startup config gate").
 * A production misconfiguration makes every request return 500 and logs `refusing to start: <reason>`, the
 * Workers equivalent of the Python service refusing to boot.
 */
import * as z from "zod";
import { b64ToBytes } from "./lib/b64url.ts";
import { parseOrigins } from "./lib/http.ts";

export const ENVIRONMENTS = ["production", "staging", "development", "test"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Settings that are product decisions, not deployment configuration. */
export const SETTINGS = {
  appName: "PaceStreak",
  termsVersion: "2026-10-19",
  accessTokenMinutes: 15,
  refreshTokenDays: 7,
  mfaChallengeMinutes: 5,
  emailVerifyTokenHours: 24,
  passwordResetTokenMinutes: 30,
  emailChangeTokenHours: 24,
  emailCodeMaxAttempts: 5,
  totpValidWindow: 1,
  recoveryCodeCount: 10,
  webauthnRpName: "PaceStreak",
  webauthnChallengeSeconds: 300,
  maxPasskeys: 10,
  deletionGraceDays: 30,
  jwtIssuer: "api.pacestreak.com",
  jwtAudience: "pacestreak",
  foodLookupUrl: "https://world.openfoodfacts.org/api/v2/product/{barcode}.json",
  emailReplyTo: "hello@pacestreak.com",
} as const;

export interface Config {
  environment: Environment;
  isProduction: boolean;
  mailer: "cloudflare" | "console";
  /**
   * Outgoing email as a capability (`EMAIL_ENABLED`). Off: nothing is sent or queued for email, no address needs
   * confirming, and the email-code routes answer 404 `{"detail": "Email is turned off"}`. Account recovery is then
   * by recovery code, issued at signup (README "Email switch").
   */
  emailEnabled: boolean;
  /** Null when unset: cookies are then host-only (staging, dev, tests). */
  cookieDomain: string | null;
  /** `__Secure-` cookie names and the `Secure` attribute; off only for local http development and tests. */
  cookieSecure: boolean;
  corsOrigins: ReadonlySet<string>;
  frontendUrl: string;
  publicApiUrl: string;
  jwt: { current: string; keys: ReadonlyMap<string, Uint8Array> };
  pepper: Uint8Array;
  dataKey: Uint8Array;
  turnstileSecret: string | null;
  vapid: { privateJwk: string; publicKey: string; subject: string } | null;
  r2: { accessKeyId: string; secretAccessKey: string; accountHost: string } | null;
  mailFrom: string;
  pushHostAllowlist: readonly string[];
  /** WebAuthn relying party: hostname of FRONTEND_URL, origin without a trailing slash. */
  /** Sign-in needs a verified address: production and staging with email on. Off in development and tests. */
  requireVerifiedEmail: boolean;
  /** Per-IP minute limits skipped, for local end-to-end runs. Accepted only in development. */
  ipLimitsOff: boolean;
  rpId: string;
  passkeyOrigin: string;
}

const optional = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s.trim() === "" ? null : s.trim()));

const key32 = (name: string) =>
  z.string().transform((s, ctx) => {
    try {
      const bytes = b64ToBytes(s.trim());
      if (bytes.length >= 32) return bytes;
      ctx.addIssue({ code: "custom", message: `${name} must decode to at least 32 bytes` });
    } catch {
      ctx.addIssue({ code: "custom", message: `${name} must be base64` });
    }
    return z.NEVER;
  });

const jwtKeys = z.string().transform((s, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "JWT_KEYS must be JSON" });
    return z.NEVER;
  }
  const shape = z
    .object({ current: z.string().min(1), keys: z.record(z.string(), z.string()) })
    .safeParse(parsed);
  if (!shape.success) {
    ctx.addIssue({ code: "custom", message: 'JWT_KEYS must be {"current": kid, "keys": {kid: base64}}' });
    return z.NEVER;
  }
  const keys = new Map<string, Uint8Array>();
  for (const [kid, b64] of Object.entries(shape.data.keys)) {
    let bytes: Uint8Array;
    try {
      bytes = b64ToBytes(b64);
    } catch {
      ctx.addIssue({ code: "custom", message: `JWT_KEYS key ${kid} must be base64` });
      continue;
    }
    if (bytes.length < 32)
      ctx.addIssue({ code: "custom", message: `JWT_KEYS key ${kid} must be at least 32 bytes` });
    keys.set(kid, bytes);
  }
  if (!keys.has(shape.data.current)) {
    ctx.addIssue({ code: "custom", message: "JWT_KEYS current kid has no key" });
  }
  return { current: shape.data.current, keys: keys as ReadonlyMap<string, Uint8Array> };
});

const RawEnv = z.object({
  ENVIRONMENT: z.enum(ENVIRONMENTS),
  MAILER: z.enum(["cloudflare", "console"]),
  EMAIL_ENABLED: z.enum(["0", "1"]).default("0"),
  COOKIE_DOMAIN: optional,
  CORS_ORIGINS: z.string(),
  FRONTEND_URL: z.url(),
  PUBLIC_API_URL: z.url(),
  JWT_KEYS: jwtKeys,
  PEPPER: key32("PEPPER"),
  DATA_KEY: key32("DATA_KEY").refine((k) => k.length === 32, "DATA_KEY must be exactly 32 bytes (AES-256)"),
  TURNSTILE_SECRET_KEY: optional,
  VAPID_PRIVATE_JWK: optional,
  VAPID_PUBLIC_KEY: optional,
  VAPID_SUBJECT: z.string().default("mailto:hello@pacestreak.com"),
  R2_ACCESS_KEY_ID: optional,
  R2_SECRET_ACCESS_KEY: optional,
  R2_ACCOUNT_HOST: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  PUSH_HOST_ALLOWLIST: z.string().default(""),
  IP_LIMITS_OFF: z.enum(["0", "1"]).default("0"),
});

export type ConfigResult = { ok: true; config: Config } | { ok: false; reasons: string[] };

/** Production rules on top of the shape checks (spec/core.md §2.7, adapted). */
function productionReasons(c: Config, env: Env): string[] {
  const r: string[] = [];
  if (c.cookieDomain === null) r.push("COOKIE_DOMAIN must be set");
  if (c.turnstileSecret === null) r.push("TURNSTILE_SECRET_KEY must be set");
  if (!c.publicApiUrl.startsWith("https://")) r.push("PUBLIC_API_URL must be https://");
  if (!c.frontendUrl.startsWith("https://")) r.push("FRONTEND_URL must be https://");
  // Email off needs neither: nothing is ever handed to a transport.
  if (c.emailEnabled) {
    if (c.mailer !== "cloudflare") r.push("MAILER must be cloudflare when EMAIL_ENABLED=1");
    if ((env as { EMAIL?: unknown }).EMAIL === undefined) r.push("the EMAIL send_email binding is missing");
  }
  return r;
}

export function parseConfig(env: Env): ConfigResult {
  const res = RawEnv.safeParse(env);
  if (!res.success) {
    return {
      ok: false,
      reasons: res.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`),
    };
  }
  const e = res.data;
  const origins = parseOrigins(e.CORS_ORIGINS);
  const reasons: string[] = [];
  if (origins.has("*")) reasons.push('CORS_ORIGINS must not contain "*" (credentials need explicit origins)');
  const frontend = new URL(e.FRONTEND_URL);
  const config: Config = {
    environment: e.ENVIRONMENT,
    isProduction: e.ENVIRONMENT === "production",
    mailer: e.MAILER,
    emailEnabled: e.EMAIL_ENABLED === "1",
    cookieDomain: e.COOKIE_DOMAIN,
    cookieSecure: e.ENVIRONMENT === "production" || e.ENVIRONMENT === "staging",
    corsOrigins: origins,
    frontendUrl: e.FRONTEND_URL.replace(/\/+$/, ""),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/+$/, ""),
    jwt: e.JWT_KEYS,
    pepper: e.PEPPER,
    dataKey: e.DATA_KEY,
    turnstileSecret: e.TURNSTILE_SECRET_KEY,
    vapid:
      e.VAPID_PRIVATE_JWK !== null && e.VAPID_PUBLIC_KEY !== null
        ? { privateJwk: e.VAPID_PRIVATE_JWK, publicKey: e.VAPID_PUBLIC_KEY, subject: e.VAPID_SUBJECT }
        : null,
    r2:
      e.R2_ACCESS_KEY_ID !== null && e.R2_SECRET_ACCESS_KEY !== null
        ? {
            accessKeyId: e.R2_ACCESS_KEY_ID,
            secretAccessKey: e.R2_SECRET_ACCESS_KEY,
            accountHost: e.R2_ACCOUNT_HOST,
          }
        : null,
    mailFrom: e.MAIL_FROM,
    pushHostAllowlist: e.PUSH_HOST_ALLOWLIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    requireVerifiedEmail:
      e.EMAIL_ENABLED === "1" && (e.ENVIRONMENT === "production" || e.ENVIRONMENT === "staging"),
    ipLimitsOff: e.IP_LIMITS_OFF === "1",
    rpId: frontend.hostname,
    passkeyOrigin: frontend.origin,
  };
  if (config.ipLimitsOff && config.environment !== "development") {
    reasons.push("IP_LIMITS_OFF is accepted only in development");
  }
  if (config.isProduction) reasons.push(...productionReasons(config, env));
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, config };
}

const cache = new WeakMap<object, ConfigResult>();

/** Parsed once per isolate (per env object). */
export function loadConfig(env: Env): ConfigResult {
  let r = cache.get(env);
  if (r === undefined) {
    r = parseConfig(env);
    cache.set(env, r);
  }
  return r;
}
