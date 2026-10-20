/**
 * /v1/auth (29 routes) and /v1/auth/passkeys (7 routes), spec/auth.md §3. Order inside each route: validation,
 * then the per-IP limit (slowapi counted after validation), then the handler (Turnstile first in the service).
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { emailOff, HttpError } from "../../lib/errors.ts";
import { clientIp } from "../../lib/http.ts";
import { ipRateLimit } from "../../lib/ratelimit.ts";
import { json, param } from "../../lib/validation.ts";
import { auth, optionalAuth } from "./middleware.ts";
import * as passkeys from "./passkeys.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";
import {
  clearAuthCookies,
  clearTrustedCookie,
  refreshCookie,
  requireCsrf,
  setAuthCookies,
  setTrustedCookie,
  trustedCookie,
} from "./tokens.ts";

const meta = (c: Context): service.Meta => ({
  ip: clientIp(c.req),
  userAgent: c.req.header("User-Agent")?.slice(0, 400) || null,
});

/**
 * Routes that exist only to deliver or redeem an emailed code: 404 `{"detail": "Email is turned off"}` with
 * `EMAIL_ENABLED=0`, before validation, since no body could make them work.
 */
const emailOn: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.ctx.cfg.emailEnabled) throw emailOff();
  await next();
};

/** Sets the cookies and returns the body (the refresh token never appears in it). */
function tokens(c: Context, pair: service.TokenPair) {
  setAuthCookies(c, (c.var as AppEnv["Variables"]).ctx, pair.refresh, pair.csrf_token);
  return c.json({
    access_token: pair.access_token,
    token_type: pair.token_type,
    expires_in: pair.expires_in,
    csrf_token: pair.csrf_token,
  });
}

export const authRoutes = new Hono<AppEnv>()
  .post("/signup", json(s.Credentials), ipRateLimit("RL_SIGNUP", "signup"), async (c) =>
    c.json(await service.signup(c.var.ctx, c.req.valid("json"), meta(c)), 201),
  )
  .post("/login", json(s.Credentials), ipRateLimit("RL_LOGIN", "login"), async (c) => {
    const out = await service.login(c.var.ctx, c.req.valid("json"), meta(c), trustedCookie(c, c.var.ctx));
    return "mfa_required" in out ? c.json(out) : tokens(c, out);
  })
  .post("/refresh", async (c) => {
    requireCsrf(c, c.var.ctx);
    return tokens(c, await service.refresh(c.var.ctx, refreshCookie(c, c.var.ctx)));
  })
  .post("/logout", async (c) => {
    requireCsrf(c, c.var.ctx);
    await service.logout(c.var.ctx, refreshCookie(c, c.var.ctx));
    clearAuthCookies(c, c.var.ctx);
    return c.body(null, 204);
  })
  .post("/logout-all", auth(), async (c) => {
    await service.logoutAll(c.var.ctx, c.var.authed, meta(c));
    clearAuthCookies(c, c.var.ctx);
    return c.body(null, 204);
  })
  .get("/me", auth(), async (c) => c.json(await service.me(c.var.authed)))
  .post("/verify-email", emailOn, json(s.EmailCode), ipRateLimit("RL_MFA", "verify-email"), async (c) =>
    c.json(await service.verifyEmail(c.var.ctx, c.req.valid("json"))),
  )
  .post(
    "/resend-verification",
    emailOn,
    optionalAuth(),
    json(s.EmailIn),
    ipRateLimit("RL_PWMAIL", "resend-verification"),
    async (c) => {
      let callerEmail: string | null = null;
      const authed = c.var.authed;
      if (authed !== undefined) {
        try {
          callerEmail = (await authed.read())[0].email;
        } catch (err) {
          // Python `get_optional_user`: a dead session is just an anonymous caller.
          if (!(err instanceof HttpError) || err.status !== 401) throw err;
        }
      }
      return c.json(await service.resendVerification(c.var.ctx, c.req.valid("json"), meta(c), callerEmail));
    },
  )
  .post(
    "/forgot-password",
    emailOn,
    json(s.EmailIn),
    ipRateLimit("RL_PWMAIL", "forgot-password"),
    async (c) => c.json(await service.forgotPassword(c.var.ctx, c.req.valid("json"), meta(c))),
  )
  .post(
    "/reset-password",
    emailOn,
    json(s.ResetPassword),
    ipRateLimit("RL_MFA", "reset-password"),
    async (c) => {
      const out = await service.resetPassword(c.var.ctx, c.req.valid("json"));
      clearAuthCookies(c, c.var.ctx);
      return c.json(out);
    },
  )
  .post("/change-password", auth(), json(s.ChangePassword), async (c) =>
    tokens(c, await service.changePassword(c.var.ctx, c.var.authed, c.req.valid("json"), meta(c))),
  )
  .get("/sessions", auth(), async (c) => c.json(await service.listSessions(c.var.ctx, c.var.authed)))
  .delete("/sessions/:session_id", auth(), param(s.SessionParam), async (c) => {
    const own = await service.revokeSession(c.var.ctx, c.var.authed, c.req.valid("param").session_id);
    if (own) clearAuthCookies(c, c.var.ctx);
    return c.body(null, 204);
  })
  .get("/2fa", auth(), async (c) => c.json(await service.twoFactorStatus(c.var.ctx, c.var.authed)))
  .post("/2fa/setup", auth(), async (c) => c.json(await service.twoFactorSetup(c.var.ctx, c.var.authed)))
  .post("/2fa/enable", auth(), json(s.TotpWithPassword), async (c) =>
    c.json(await service.twoFactorEnable(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post("/2fa/disable", auth(), json(s.TotpWithPassword), async (c) =>
    c.json(await service.twoFactorDisable(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post("/2fa/recovery-codes", auth(), json(s.TotpCode), async (c) =>
    c.json(await service.regenerateRecoveryCodes(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post(
    "/recovery-codes",
    auth(),
    json(s.NewRecoveryCodes),
    ipRateLimit("RL_MFA", "recovery-codes"),
    async (c) =>
      c.json(await service.newAccountRecoveryCodes(c.var.ctx, c.var.authed, c.req.valid("json"), meta(c))),
  )
  .post("/2fa/verify", json(s.MfaVerify), ipRateLimit("RL_MFA", "2fa-verify"), async (c) => {
    const out = await service.mfaVerify(c.var.ctx, c.req.valid("json"), meta(c));
    if (out.trusted !== undefined) setTrustedCookie(c, c.var.ctx, out.trusted);
    return tokens(c, out);
  })
  .post("/2fa/resend", emailOn, json(s.MfaToken), ipRateLimit("RL_MFA", "2fa-resend"), async (c) =>
    c.json(await service.resendLoginCode(c.var.ctx, c.req.valid("json"), meta(c))),
  )
  .post("/2fa/email", emailOn, auth(), json(s.EmailTwoFactor), async (c) => {
    const out = await service.setEmailTwoFactor(c.var.ctx, c.var.authed, c.req.valid("json"), meta(c));
    clearTrustedCookie(c, c.var.ctx);
    return c.json(out);
  })
  .get("/trusted-devices", auth(), async (c) =>
    c.json(await service.listTrustedDevices(c.var.ctx, c.var.authed, trustedCookie(c, c.var.ctx))),
  )
  .delete("/trusted-devices", auth(), async (c) => {
    await service.revokeTrustedDevices(c.var.ctx, c.var.authed);
    clearTrustedCookie(c, c.var.ctx);
    return c.body(null, 204);
  })
  .delete("/trusted-devices/:device_id", auth(), param(s.DeviceParam), async (c) => {
    const own = await service.revokeTrustedDevice(
      c.var.ctx,
      c.var.authed,
      c.req.valid("param").device_id,
      trustedCookie(c, c.var.ctx),
    );
    if (own) clearTrustedCookie(c, c.var.ctx);
    return c.body(null, 204);
  })
  .post("/recover", json(s.Recover), ipRateLimit("RL_MFA", "recover"), async (c) => {
    const out = await service.recover(c.var.ctx, c.req.valid("json"), meta(c));
    clearAuthCookies(c, c.var.ctx);
    return c.json(out);
  })
  .post("/change-email", auth(), json(s.ChangeEmail), ipRateLimit("RL_PWMAIL", "change-email"), async (c) =>
    c.json(await service.changeEmail(c.var.ctx, c.var.authed, c.req.valid("json"), meta(c))),
  )
  .post(
    "/confirm-email-change",
    emailOn,
    json(s.EmailCode),
    ipRateLimit("RL_MFA", "confirm-email-change"),
    async (c) => c.json(await service.confirmEmailChange(c.var.ctx, c.req.valid("json"))),
  );

export const passkeyRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await passkeys.list(c.var.ctx, c.var.authed)))
  .post("/register/options", auth(), json(s.PasswordOnly), async (c) =>
    c.json(await passkeys.registerOptions(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post("/register", auth(), json(s.RegisterPasskey), async (c) =>
    c.json(await passkeys.register(c.var.ctx, c.var.authed, c.req.valid("json"), meta(c)), 201),
  )
  .patch("/:passkey_id", auth(), param(s.PasskeyParam), json(s.RenamePasskey), async (c) =>
    c.json(
      await passkeys.rename(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").passkey_id,
        c.req.valid("json").name,
      ),
    ),
  )
  .post("/:passkey_id/remove", auth(), param(s.PasskeyParam), json(s.PasswordOnly), async (c) => {
    await passkeys.remove(
      c.var.ctx,
      c.var.authed,
      c.req.valid("param").passkey_id,
      c.req.valid("json"),
      meta(c),
    );
    return c.body(null, 204);
  })
  .post("/sign-in/options", ipRateLimit("RL_LOGIN", "passkey-sign-in-options"), async (c) =>
    c.json(await passkeys.signInOptions(c.var.ctx)),
  )
  .post("/sign-in", json(s.PasskeySignIn), ipRateLimit("RL_LOGIN", "passkey-sign-in"), async (c) =>
    tokens(c, await passkeys.signIn(c.var.ctx, c.req.valid("json"), meta(c))),
  );
