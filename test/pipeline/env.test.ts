import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/env.ts";

const KEY = btoa("k".repeat(32));
const prodEnv = (over: Record<string, unknown> = {}) =>
  ({
    ...env,
    ENVIRONMENT: "production",
    MAILER: "cloudflare",
    COOKIE_DOMAIN: "pacestreak.com",
    CORS_ORIGINS: "https://app.pacestreak.com",
    FRONTEND_URL: "https://app.pacestreak.com",
    PUBLIC_API_URL: "https://api.pacestreak.com",
    JWT_KEYS: JSON.stringify({ current: "k1", keys: { k1: KEY } }),
    PEPPER: KEY,
    DATA_KEY: KEY,
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    // wrangler.jsonc has no send_email binding in production (MAILER=smtp); a stand-in for MAILER=cloudflare.
    EMAIL: { send: async () => ({ messageId: "test" }) },
    ...over,
  }) as Env;

function reasons(e: Env): string[] {
  const r = parseConfig(e);
  return r.ok ? [] : r.reasons;
}

describe("config gate", () => {
  it("boots with production vars and fake secrets", () => {
    const r = parseConfig(prodEnv());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.cookieSecure).toBe(true);
      expect(r.config.rpId).toBe("app.pacestreak.com");
      expect(r.config.passkeyOrigin).toBe("https://app.pacestreak.com");
      expect([...r.config.corsOrigins]).toEqual(["https://app.pacestreak.com"]);
    }
  });

  it("refuses production without its required settings", () => {
    expect(reasons(prodEnv({ COOKIE_DOMAIN: "" }))).toContain("COOKIE_DOMAIN must be set");
    expect(reasons(prodEnv({ TURNSTILE_SECRET_KEY: "" }))).toContain("TURNSTILE_SECRET_KEY must be set");
    expect(reasons(prodEnv({ PUBLIC_API_URL: "http://api.pacestreak.com" }))).toContain(
      "PUBLIC_API_URL must be https://",
    );
    expect(reasons(prodEnv({ MAILER: "console" }))).toContain(
      "MAILER must be smtp, brevo or cloudflare when EMAIL_ENABLED=1",
    );
    expect(reasons(prodEnv({ EMAIL: undefined }))).toContain("the EMAIL send_email binding is missing");
  });

  it("smtp and brevo: each needs its secrets when email is on, and neither needs the EMAIL binding", () => {
    const smtp = { MAILER: "smtp", EMAIL_ENABLED: "1", EMAIL: undefined };
    expect(reasons(prodEnv({ ...smtp, SMTP_USER: "u", SMTP_PASSWORD: "p" }))).toEqual([]);
    const ok = parseConfig(prodEnv({ ...smtp, SMTP_USER: "u", SMTP_PASSWORD: "p" }));
    if (ok.ok)
      expect(ok.config.smtp).toEqual({ host: "smtp-relay.brevo.com", port: 587, user: "u", password: "p" });
    expect(reasons(prodEnv(smtp))).toEqual([
      "SMTP_USER must be set when MAILER=smtp and EMAIL_ENABLED=1",
      "SMTP_PASSWORD must be set when MAILER=smtp and EMAIL_ENABLED=1",
    ]);
    expect(reasons(prodEnv({ ...smtp, SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_PORT: "25" }))).toEqual([
      "SMTP_PORT 25 is blocked on Workers: use 587",
    ]);
    const custom = parseConfig(
      prodEnv({
        ...smtp,
        SMTP_USER: "u",
        SMTP_PASSWORD: "p",
        SMTP_HOST: "smtp.example.net",
        SMTP_PORT: "2525",
      }),
    );
    if (custom.ok)
      expect([custom.config.smtp.host, custom.config.smtp.port]).toEqual(["smtp.example.net", 2525]);
    expect(custom.ok).toBe(true);

    const brevo = { MAILER: "brevo", EMAIL_ENABLED: "1", EMAIL: undefined };
    expect(reasons(prodEnv({ ...brevo, BREVO_API_KEY: "k" }))).toEqual([]);
    expect(reasons(prodEnv(brevo))).toEqual([
      "BREVO_API_KEY must be set when MAILER=brevo and EMAIL_ENABLED=1",
    ]);
    // Email off: no transport secret is needed.
    expect(reasons(prodEnv({ ...smtp, EMAIL_ENABLED: "0" }))).toEqual([]);
    expect(reasons(prodEnv({ ...brevo, EMAIL_ENABLED: "0" }))).toEqual([]);
    // The gate applies outside production too (a dev run that would send).
    expect(reasons({ ...env, ENVIRONMENT: "development", ...smtp } as unknown as Env)).toContain(
      "SMTP_USER must be set when MAILER=smtp and EMAIL_ENABLED=1",
    );
  });

  it("EMAIL_ENABLED: off by default, and off needs no mailer, binding or verified addresses", () => {
    const { EMAIL_ENABLED: _drop, ...rest } = prodEnv() as unknown as Record<string, unknown>;
    const unset = parseConfig(rest as unknown as Env);
    expect(unset.ok && unset.config.emailEnabled).toBe(false);
    const off = parseConfig(prodEnv({ EMAIL_ENABLED: "0", MAILER: "console", EMAIL: undefined }));
    expect(off.ok).toBe(true);
    if (off.ok) expect([off.config.emailEnabled, off.config.requireVerifiedEmail]).toEqual([false, false]);
    const on = parseConfig(prodEnv({ EMAIL_ENABLED: "1" }));
    expect(on.ok).toBe(true);
    if (on.ok) expect([on.config.emailEnabled, on.config.requireVerifiedEmail]).toEqual([true, true]);
    expect(reasons(prodEnv({ EMAIL_ENABLED: "yes" })).join()).toContain("EMAIL_ENABLED");
  });

  it("accepts IP_LIMITS_OFF only in development", () => {
    expect(reasons(prodEnv({ IP_LIMITS_OFF: "1" }))).toContain(
      "IP_LIMITS_OFF is accepted only in development",
    );
    expect(reasons({ ...env, ENVIRONMENT: "staging", IP_LIMITS_OFF: "1" } as Env)).toContain(
      "IP_LIMITS_OFF is accepted only in development",
    );
    const dev = parseConfig({ ...env, ENVIRONMENT: "development", IP_LIMITS_OFF: "1" } as Env);
    expect(dev.ok && dev.config.ipLimitsOff).toBe(true);
    const off = parseConfig(prodEnv());
    expect(off.ok && off.config.ipLimitsOff).toBe(false);
  });

  it("refuses a wildcard origin in any environment", () => {
    expect(reasons({ ...env, CORS_ORIGINS: "*" } as Env)[0]).toMatch(/must not contain "\*"/);
  });

  it("refuses short or malformed keys", () => {
    const short = btoa("short");
    expect(reasons(prodEnv({ PEPPER: short })).join()).toMatch(/PEPPER must decode to at least 32 bytes/);
    expect(
      reasons(prodEnv({ JWT_KEYS: JSON.stringify({ current: "k1", keys: { k1: short } }) })).join(),
    ).toMatch(/k1 must be at least 32 bytes/);
    expect(
      reasons(prodEnv({ JWT_KEYS: JSON.stringify({ current: "k2", keys: { k1: KEY } }) })).join(),
    ).toMatch(/current kid has no key/);
    expect(reasons(prodEnv({ JWT_KEYS: "{" })).join()).toMatch(/must be JSON/);
  });

  it("the test environment is valid and not production", () => {
    const r = parseConfig(env);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect([r.config.isProduction, r.config.cookieSecure, r.config.requireVerifiedEmail]).toEqual([
        false,
        false,
        false,
      ]);
  });
});
