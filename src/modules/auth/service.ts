/**
 * Auth business logic (spec/auth.md §3-§4, DESIGN.md §6). The only file other modules may import.
 *
 * Round trips: password sign-in and refresh are one read batch plus one write batch. Check-then-act steps
 * (single-use codes, challenges, TOTP replay, rotation) are made race free by an `abortUnless` guard placed
 * before the writes in the same atomic batch.
 */
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, runBatch, type Stmt, toWire } from "../../db/batch.ts";
import type { OtpPurpose } from "../../db/schema/index.ts";
import { SETTINGS } from "../../env.ts";
import { dispatchDeliver } from "../../jobs/dispatch.ts";
import { decryptString, encryptString } from "../../lib/crypto/aesgcm.ts";
import { timingSafeEqualStr } from "../../lib/crypto/consttime.ts";
import { hmacSha256Hex, sha256Hex } from "../../lib/crypto/hmac.ts";
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from "../../lib/crypto/pbkdf2.ts";
import { findTotpStep, generateTotpSecret, totpProvisioningUri } from "../../lib/crypto/totp.ts";
import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  isConstraintError,
  unauthorized,
} from "../../lib/errors.ts";
import { createMailer } from "../../lib/mailer/index.ts";
import {
  sendEmailChangedNotice,
  sendEmailChangeEmail,
  sendLoginCodeEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../../lib/mailer/templates.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { verifyTurnstile } from "../../lib/turnstile.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";
import {
  ACCESS_EXPIRES_IN,
  accessToken,
  EMAIL_MFA_EXPIRES_IN,
  MFA_EXPIRES_IN,
  mfaToken,
  newCsrfToken,
  newRefreshToken,
  newTrustedToken,
  readToken,
} from "./tokens.ts";

export { admin, auth, moderator, optionalAuth } from "./middleware.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const REUSE_GRACE_MS = 30_000;
const INVALID_CODE = "Invalid or expired code";
const BAD_PASSWORD = "Password is incorrect";
const SUSPICIOUS = "Refresh token has been revoked due to suspicious activity.";

/** Who is asking: descriptive only, never an authorisation input. */
export interface Meta {
  ip: string | null;
  userAgent: string | null;
}

export interface TokenPair {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  csrf_token: string;
  /** Goes into the cookie, never the body. */
  refresh: string;
}

export interface MfaChallenge {
  mfa_required: true;
  mfa_token: string;
  expires_in: number;
  /** `totp`: an authenticator code. `email`: the six-digit code just mailed. Either accepts a recovery code. */
  method: "totp" | "email";
  /** Email challenges only: seconds until a resend is allowed. */
  resend_in?: number;
}

/** A completed sign-in; `trusted` is the new trusted-device token for the cookie, when one was asked for. */
export type SignedIn = TokenPair & { trusted?: string };

export const CODE_NOT_SENT = "We couldn't send your code. Try again, or use a recovery code.";

const mailer = (ctx: Ctx) => createMailer(ctx.cfg, ctx.env, ctx.log);
const lower = (email: string) => email.toLowerCase();

async function commit(ctx: Ctx, stmts: Stmt[]): Promise<unknown[]> {
  return (await runBatch(ctx.db, stmts)) as unknown[];
}

// ---- secrets and codes ------------------------------------------------------------------------------------

/** A uniform six-digit code (Python `f"{randbelow(10**6):06d}"`). */
export function sixDigitCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] ?? 0;
    if (v < limit) return String(v % 1_000_000).padStart(6, "0");
  }
}

const emailCodeHmac = (ctx: Ctx, purpose: OtpPurpose, userId: string, code: string) =>
  hmacSha256Hex(ctx.cfg.pepper, `${purpose}|${userId}|${code}`);

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** `XXXXX-XXXXX` from a 32-letter alphabet (no 0/O/1/I). 256 is a multiple of 32, so `& 31` is unbiased. */
export function recoveryCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  const s = [...b].map((x) => RECOVERY_ALPHABET[x & 31]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Python normalisation: strip, upper-case, drop spaces. The hyphen stays significant. */
const normaliseRecovery = (code: string) => code.trim().toUpperCase().replace(/ /g, "");

const recoveryHmac = (ctx: Ctx, userId: string, code: string) =>
  hmacSha256Hex(ctx.cfg.pepper, `recovery|${userId}|${normaliseRecovery(code)}`);

/** `auth_failures.email_hash`: HMAC under the pepper, so the table never holds an address. */
export const emailHash = (ctx: Ctx, email: string) =>
  hmacSha256Hex(ctx.cfg.pepper, `auth-failure|${email.trim().toLowerCase()}`);

const totpAad = (userId: string) => `totp|${userId}`;

const loginCodeHmac = (ctx: Ctx, userId: string, code: string) =>
  hmacSha256Hex(ctx.cfg.pepper, `login_email|${userId}|${code}`);

/** The stored form of a trusted-device cookie: keyed under PEPPER, so the table alone cannot mint one. */
export const trustedHash = (ctx: Ctx, token: string) =>
  hmacSha256Hex(ctx.cfg.pepper, `trusted-device|${token}`);

/** Email codes at sign-in apply: email is on, the owner left the setting on, and no authenticator app is set up. */
export const emailCodesApply = (ctx: Ctx, u: { email2faEnabled: boolean; totpEnabled: boolean }) =>
  ctx.cfg.emailEnabled && u.email2faEnabled && !u.totpEnabled;

async function totpSecret(ctx: Ctx, userId: string, stored: string | null): Promise<string> {
  if (stored === null) return "";
  return (await decryptString(ctx.cfg.dataKey, stored, totpAad(userId))) ?? "";
}

/** The step a fresh TOTP code is valid for, or null (wrong, or replayed: step <= last used). */
async function freshTotpStep(
  ctx: Ctx,
  u: { id: string; totpSecret: string | null; totpLastUsedStep: number | null },
  code: string,
): Promise<number | null> {
  const step = await findTotpStep(
    await totpSecret(ctx, u.id, u.totpSecret),
    code,
    ctx.clock.now(),
    SETTINGS.totpValidWindow,
  );
  if (step === null || (u.totpLastUsedStep !== null && step <= u.totpLastUsedStep)) return null;
  return step;
}

async function newRecoveryCodes(ctx: Ctx, userId: string): Promise<{ codes: string[]; hmacs: string[] }> {
  const codes = Array.from({ length: SETTINGS.recoveryCodeCount }, recoveryCode);
  return { codes, hmacs: await Promise.all(codes.map((c) => recoveryHmac(ctx, userId, c))) };
}

/** Python `record_failure`: best effort, never fails the request. */
async function recordFailure(
  ctx: Ctx,
  kind: string,
  meta: Meta,
  who: { email?: string; userId?: string },
): Promise<void> {
  try {
    const email = who.email === undefined ? null : who.email.trim().toLowerCase();
    await runBatch(ctx.db, [
      repo.insertAuthFailure(
        ctx.db,
        {
          kind,
          ip: meta.ip,
          emailHash: email === null ? null : await emailHash(ctx, email),
          userId: who.userId ?? null,
          email,
        },
        ctx.clock.now(),
      ),
    ]);
  } catch (err) {
    ctx.log.error("could not record an auth failure", err);
  }
}

const event = (ctx: Ctx, userId: string, kind: string, meta: Meta | null, extra?: Record<string, unknown>) =>
  repo.insertEvent(ctx.db, {
    userId,
    kind,
    now: ctx.clock.now(),
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
    meta: extra ?? null,
  });

// ---- sessions ---------------------------------------------------------------------------------------------

/** "Firefox on Linux" from a user agent (Python `describe_agent`). */
export function describeAgent(agent: string | null): string {
  if (!agent) return "an unknown device";
  const pick = (pairs: [string, string][], fallback: string) =>
    pairs.find(([k]) => agent.includes(k))?.[1] ?? fallback;
  const browser = pick(
    [
      ["Edg/", "Edge"],
      ["OPR/", "Opera"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
    ],
    "a browser",
  );
  const system = pick(
    [
      ["iPhone", "iPhone"],
      ["iPad", "iPad"],
      ["Android", "Android"],
      ["Mac OS X", "macOS"],
      ["Windows", "Windows"],
      ["CrOS", "ChromeOS"],
      ["Linux", "Linux"],
    ],
    "an unknown system",
  );
  return `${browser} on ${system}`;
}

export interface History {
  hasHistory: number | boolean;
  knownAgent: number | boolean;
}

/**
 * The last step of every way in (password, second factor, passkey): one write batch with `before` (guards and
 * the caller's own writes) first, then the session, its refresh token, the `login` event and, for a new device on
 * an account with history, the "new sign-in" notification (Python `start_session` + `note_sign_in`).
 */
async function startSession(
  ctx: Ctx,
  user: { id: string; tokenVersion: number },
  meta: Meta,
  history: History | undefined,
  before: Stmt[] = [],
  opts: { recordLogin?: boolean; codeMailed?: boolean } = {},
): Promise<TokenPair> {
  const now = ctx.clock.now();
  const sessionId = uuid7(now);
  const refresh = newRefreshToken();
  const stmts: Stmt[] = [
    ...before,
    ...repo.insertSession(ctx.db, {
      userId: user.id,
      sessionId,
      tokenId: uuid7(now),
      tokenHash: await sha256Hex(refresh),
      now,
      userAgent: meta.userAgent,
      ip: meta.ip,
      days: SETTINGS.refreshTokenDays,
    }),
  ];
  let notificationId: string | null = null;
  if (opts.recordLogin !== false) {
    stmts.push(event(ctx, user.id, "login", meta));
    if (history?.hasHistory && !history.knownAgent && meta.userAgent !== null) {
      notificationId = uuid7(now);
      stmts.push(
        repo.insertNotification(
          ctx.db,
          {
            id: notificationId,
            userId: user.id,
            kind: "new_sign_in",
            category: "security",
            title: "New sign-in to your PaceStreak account",
            body: `From ${describeAgent(meta.userAgent)}. If this was not you, change your password and sign out everywhere.`,
            url: "/settings/security",
            // A sign-in code was just mailed to this inbox for this very sign-in: the notice stays in the app
            // and on push, but a second email a few seconds later would only be noise.
            data: opts.codeMailed ? { no_email: true } : null,
          },
          now,
        ),
      );
    }
  }
  await commit(ctx, stmts);
  if (notificationId !== null) ctx.defer(dispatchDeliver(ctx.env.JOBS, [notificationId]));
  return {
    access_token: await accessToken(ctx, user.id, user.tokenVersion, sessionId),
    token_type: "bearer",
    expires_in: ACCESS_EXPIRES_IN,
    csrf_token: newCsrfToken(),
    refresh,
  };
}

const userOut = (u: { id: string; email: string; isActive: boolean; isVerified: boolean }) => ({
  id: u.id,
  email: u.email,
  is_active: u.isActive,
  is_verified: u.isVerified,
});

// ---- signup, login, refresh, logout -----------------------------------------------------------------------

export async function signup(
  ctx: Ctx,
  body: { email: string; password: string; turnstile_token?: string | null | undefined },
  meta: Meta,
) {
  await verifyTurnstile({ secret: ctx.cfg.turnstileSecret, token: body.turnstile_token, remoteIp: meta.ip });
  const now = ctx.clock.now();
  const email = lower(body.email);
  const userId = uuid7(now);
  const hashed = await hashPassword(body.password, ctx.cfg.pepper);
  // Email on: a verification code goes out. Email off: there is no inbox to recover through, so the account starts
  // with recovery codes instead, shown once in this response (the only time they exist in clear).
  let code: string | null = null;
  let recovery: { codes: string[]; hmacs: string[] } | null = null;
  const follow: Stmt[] = [];
  if (ctx.cfg.emailEnabled) {
    code = sixDigitCode();
    follow.push(
      ...repo.issueCode(
        ctx.db,
        {
          id: uuid7(now),
          userId,
          purpose: "email_verify",
          codeHmac: await emailCodeHmac(ctx, "email_verify", userId, code),
          expiresAt: now + SETTINGS.emailVerifyTokenHours * HOUR,
        },
        now,
      ),
    );
  } else {
    recovery = await newRecoveryCodes(ctx, userId);
    follow.push(...repo.replaceRecoveryCodes(ctx.db, userId, recovery.hmacs, now));
  }
  try {
    await commit(ctx, [
      ctx.db
        .insert(repo.tables.users)
        .values({ id: userId, email, hashedPassword: hashed, createdAt: now, updatedAt: now }),
      event(ctx, userId, "signup", meta),
      ...follow,
    ]);
  } catch (err) {
    if (isConstraintError(err)) throw conflict("Email already registered");
    throw err;
  }
  const out = userOut({ id: userId, email, isActive: true, isVerified: false });
  // After the commit: a failed send leaves the account, and the user can ask for another code.
  if (code !== null) await sendVerificationEmail(mailer(ctx), email, code);
  return recovery === null ? out : { ...out, recovery_codes: recovery.codes };
}

export async function login(
  ctx: Ctx,
  body: { email: string; password: string; turnstile_token?: string | null | undefined },
  meta: Meta,
  trustedToken?: string,
): Promise<TokenPair | MfaChallenge> {
  await verifyTurnstile({ secret: ctx.cfg.turnstileSecret, token: body.turnstile_token, remoteIp: meta.ip });
  const email = lower(body.email);
  const now = ctx.clock.now();
  // No cookie: a hash no row can have, so the batch keeps one shape.
  const trustedKey = trustedToken === undefined ? "-" : await trustedHash(ctx, trustedToken);
  const [rows, hist, trusted] = await runBatch(ctx.db, [
    repo.userByEmail(ctx.db, email),
    repo.loginHistory(ctx.db, { email }, meta.userAgent),
    repo.trustedForLogin(ctx.db, email, trustedKey, now),
  ] as const);
  const user = rows[0];
  // Unknown addresses still pay for a hash, so timing does not reveal which addresses exist.
  const stored = user?.hashedPassword ?? (await dummyPasswordHash(ctx.cfg.pepper));
  const ok = await verifyPassword(stored, body.password, ctx.cfg.pepper);
  if (user === undefined || !ok || !user.isActive) {
    await recordFailure(ctx, "login", meta, { email: body.email });
    throw unauthorized("Incorrect email or password");
  }
  // An unconfirmed address with email codes on gets the code instead of the 403: entering it confirms the address.
  if (ctx.cfg.requireVerifiedEmail && !user.isVerified && !emailCodesApply(ctx, user))
    throw forbidden("Email address not verified");
  if (user.totpEnabled) {
    return {
      mfa_required: true,
      mfa_token: await mfaToken(ctx, user.id, user.tokenVersion),
      expires_in: MFA_EXPIRES_IN,
      method: "totp",
    };
  }
  const before: Stmt[] = [];
  if (emailCodesApply(ctx, user)) {
    const device = trusted[0];
    if (device === undefined || !user.isVerified) return emailChallenge(ctx, user, meta);
    before.push(repo.touchTrustedDevice(ctx.db, device.id, now));
  }
  if (needsRehash(user.hashedPassword)) {
    const rehashed = await hashPassword(body.password, ctx.cfg.pepper);
    before.push(
      ctx.db.update(repo.tables.users).set({ hashedPassword: rehashed }).where(repo.byUserId(user.id)),
    );
  }
  return startSession(ctx, user, meta, hist[0], before);
}

/**
 * Password accepted, email code needed: one write (the challenge), then the email. The MFA token's `jti` is the
 * challenge id. A failed send is a 503 that still carries the challenge, so the owner can finish with a recovery
 * code, but nothing in it signs anyone in.
 */
async function emailChallenge(
  ctx: Ctx,
  user: { id: string; email: string; tokenVersion: number },
  meta: Meta,
): Promise<MfaChallenge> {
  const now = ctx.clock.now();
  const id = uuid7(now);
  const code = sixDigitCode();
  await commit(ctx, [
    repo.insertLoginChallenge(
      ctx.db,
      {
        id,
        userId: user.id,
        codeHmac: await loginCodeHmac(ctx, user.id, code),
        expiresAt: now + SETTINGS.loginCodeMinutes * MINUTE,
      },
      now,
    ),
  ]);
  const challenge: MfaChallenge = {
    mfa_required: true,
    mfa_token: await mfaToken(ctx, user.id, user.tokenVersion, { jti: id, expiresIn: EMAIL_MFA_EXPIRES_IN }),
    expires_in: EMAIL_MFA_EXPIRES_IN,
    method: "email",
    resend_in: SETTINGS.loginCodeResendSeconds,
  };
  if (!(await sendLoginCodeEmail(mailer(ctx), user.email, code, describeAgent(meta.userAgent)))) {
    throw new HttpError(503, CODE_NOT_SENT, {}, { detail: CODE_NOT_SENT, ...challenge, email_sent: false });
  }
  return challenge;
}

const CHALLENGE = "Invalid or expired challenge";

/** A new email code for a pending sign-in: one per minute, five per hour per account. */
export async function resendLoginCode(ctx: Ctx, body: { mfa_token: string }, meta: Meta) {
  const claims = await readToken(ctx, body.mfa_token, "mfa");
  if (claims === null) throw unauthorized(CHALLENGE);
  const [rows, chs] = await runBatch(ctx.db, [
    repo.userById(ctx.db, claims.userId),
    repo.loginChallenge(ctx.db, claims.jti),
  ] as const);
  const u = rows[0];
  const ch = chs[0];
  if (
    u === undefined ||
    !u.isActive ||
    u.tokenVersion !== claims.tokenVersion ||
    !emailCodesApply(ctx, u) ||
    ch === undefined ||
    ch.userId !== u.id ||
    ch.usedAt !== null
  )
    throw unauthorized(CHALLENGE);
  const now = ctx.clock.now();
  const cooldown = SETTINGS.loginCodeResendSeconds * 1000;
  const wait = Math.ceil((ch.lastSentAt + cooldown - now) / 1000);
  const tooSoon = (sec: number) =>
    new HttpError(
      429,
      `Wait ${sec} s before asking for another code.`,
      { "Retry-After": String(sec) },
      {
        detail: `Wait ${sec} s before asking for another code.`,
        resend_in: sec,
      },
    );
  if (wait > 0) throw tooSoon(wait);
  const limit = perUser(ctx.db, BUCKETS.loginCodeResend, u.id, now);
  const code = sixDigitCode();
  const [counter, updated] = await commit(ctx, [
    limit.counter,
    repo.resendLoginChallenge(ctx.db, {
      id: ch.id,
      codeHmac: await loginCodeHmac(ctx, u.id, code),
      expiresAt: now + SETTINGS.loginCodeMinutes * MINUTE,
      now,
      cooldownMs: cooldown,
      allowed: limit.allowed,
    }),
  ]);
  limit.check(counter as { count: number }[]);
  // Lost a race with a parallel resend: that one sent the code.
  if ((updated as unknown[]).length === 0) throw tooSoon(SETTINGS.loginCodeResendSeconds);
  if (!(await sendLoginCodeEmail(mailer(ctx), u.email, code, describeAgent(meta.userAgent))))
    throw new HttpError(503, CODE_NOT_SENT);
  return {
    detail: "A new code is on its way.",
    expires_in: SETTINGS.loginCodeMinutes * 60,
    resend_in: SETTINGS.loginCodeResendSeconds,
  };
}

/**
 * Rotation (spec/auth.md §4): a live token rotates; a token rotated away less than 30 s ago (two tabs reloading at
 * once) rotates from the session's live tip instead; any other reuse burns the session. The write is guarded on
 * the tip still being live, so of two concurrent rotations one wins and the other retries through the grace path.
 */
export async function refresh(ctx: Ctx, raw: string | undefined): Promise<TokenPair> {
  if (raw === undefined) throw unauthorized("Missing refresh token");
  const hash = await sha256Hex(raw);
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = ctx.clock.now();
    const [rows, tips] = await runBatch(ctx.db, [
      repo.refreshByHash(ctx.db, hash),
      repo.liveTipByHash(ctx.db, hash),
    ] as const);
    const t = rows[0];
    if (t === undefined) throw unauthorized("Invalid refresh token");
    if (t.revokedAt !== null) throw unauthorized(SUSPICIOUS);
    let from = { id: t.tokenId, expiresAt: t.expiresAt };
    if (t.replacedBy !== null) {
      const tip = tips[0];
      if (tip === undefined || t.usedAt === null || now - t.usedAt > REUSE_GRACE_MS) {
        await commit(ctx, [repo.revokeSession(ctx.db, t.sessionId, now)]);
        throw unauthorized(SUSPICIOUS);
      }
      from = tip;
    }
    if (from.expiresAt <= now) throw unauthorized("Refresh token has expired.");
    if (!t.isActive) throw unauthorized("User account is inactive or does not exist.");
    const next = newRefreshToken();
    const nextId = uuid7(now);
    try {
      await commit(
        ctx,
        repo.rotate(ctx.db, {
          sessionId: t.sessionId,
          fromId: from.id,
          nextId,
          nextHash: await sha256Hex(next),
          now,
          days: SETTINGS.refreshTokenDays,
        }),
      );
    } catch (err) {
      if (isCondAbort(err)) continue;
      throw err;
    }
    return {
      access_token: await accessToken(ctx, t.userId, t.tokenVersion, t.sessionId),
      token_type: "bearer",
      expires_in: ACCESS_EXPIRES_IN,
      csrf_token: newCsrfToken(),
      refresh: next,
    };
  }
  throw unauthorized("Invalid refresh token");
}

/** Ends the cookie's session, if any. One write, no read. */
export async function logout(ctx: Ctx, raw: string | undefined): Promise<void> {
  if (raw === undefined) return;
  await commit(ctx, [repo.revokeSessionByToken(ctx.db, await sha256Hex(raw), ctx.clock.now())]);
}

export async function logoutAll(ctx: Ctx, authed: AuthedBatch, meta: Meta): Promise<void> {
  const now = ctx.clock.now();
  await authed.write(
    ...(repo.revokeAllSessions(ctx.db, authed.userId, now) as readonly [Stmt, Stmt]),
    event(ctx, authed.userId, "logout_all", meta),
  );
}

export async function me(authed: AuthedBatch) {
  const [u] = await authed.read();
  return userOut(u);
}

export async function listSessions(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listSessions(ctx.db, authed.userId, ctx.clock.now()));
  return rows.map((s) => ({
    id: s.id,
    created_at: toWire(s.createdAt),
    last_used_at: toWire(s.lastUsedAt),
    expires_at: toWire(s.expiresAt),
    user_agent: s.userAgent,
    ip_address: s.ip,
    current: s.id === authed.principal.sessionId,
  }));
}

/** Returns true when the caller revoked their own session (the route then clears the cookies). */
export async function revokeSession(ctx: Ctx, authed: AuthedBatch, sessionId: string): Promise<boolean> {
  const now = ctx.clock.now();
  try {
    await authed.write(
      abortUnless(ctx.db, repo.sessionOwned(authed.userId, sessionId)),
      repo.revokeOwnSession(ctx.db, authed.userId, sessionId, now),
      event(ctx, authed.userId, "session_revoked", null, { session: sessionId }),
    );
  } catch (err) {
    if (isCondAbort(err)) throw new HttpError(404, "Session not found");
    throw err;
  }
  return sessionId === authed.principal.sessionId;
}

// ---- passwords --------------------------------------------------------------------------------------------

export async function changePassword(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { current_password: string; new_password: string },
  meta: Meta,
): Promise<TokenPair> {
  const [, rows] = await authed.read(repo.userById(ctx.db, authed.userId));
  const u = rows[0];
  if (u === undefined || !(await verifyPassword(u.hashedPassword, body.current_password, ctx.cfg.pepper))) {
    throw unauthorized("Current password is incorrect");
  }
  if (body.current_password === body.new_password)
    throw badRequest("New password must differ from the current one");
  const now = ctx.clock.now();
  const hashed = await hashPassword(body.new_password, ctx.cfg.pepper);
  // Revoke first, so the new session written by startSession stays live; its token carries the bumped version.
  const pair = await startSession(
    ctx,
    { id: u.id, tokenVersion: u.tokenVersion + 1 },
    meta,
    undefined,
    [
      repo.sessionGuardFor(authed),
      ctx.db
        .update(repo.tables.users)
        .set({ hashedPassword: hashed, passwordChangedAt: now, updatedAt: now })
        .where(repo.byUserId(u.id)),
      ...repo.revokeAllSessions(ctx.db, u.id, now),
      event(ctx, u.id, "password_changed", meta),
    ],
    { recordLogin: false },
  ).catch((err: unknown) => {
    throw repo.mapSessionGuard(err);
  });
  await sendPasswordChangedEmail(mailer(ctx), u.email, ctx.cfg.frontendUrl);
  return pair;
}

/** Python `issue_one_time_token`: the statements, plus the code for the email. */
async function issue(
  ctx: Ctx,
  userId: string,
  purpose: OtpPurpose,
  lifeMs: number,
): Promise<{ code: string; stmts: Stmt[] }> {
  const now = ctx.clock.now();
  const code = sixDigitCode();
  const codeHmac = await emailCodeHmac(ctx, purpose, userId, code);
  return {
    code,
    stmts: repo.issueCode(
      ctx.db,
      { id: uuid7(now), userId, purpose, codeHmac, expiresAt: now + lifeMs },
      now,
    ),
  };
}

/**
 * Finds the user whose newest live code of `purpose` matches. A miss counts an attempt on every candidate code,
 * and the count is saved (Python rolled it back, so its 5-attempt cap never applied: CHANGES-FROM-PYTHON.md).
 * The caller's write batch starts with `codeGuard(...)`, which makes the code single-use under concurrency.
 */
async function matchCode<E extends Stmt[]>(
  ctx: Ctx,
  email: string,
  code: string,
  purpose: OtpPurpose,
  ...extra: E
) {
  const now = ctx.clock.now();
  const [cands, ...rest] = (await runBatch(ctx.db, [
    repo.codeCandidates(ctx.db, lower(email), purpose, now),
    ...extra,
  ] as const)) as readonly [Awaited<ReturnType<typeof repo.codeCandidates>>, ...unknown[]];
  const live = cands.filter((c) => c.attempts < SETTINGS.emailCodeMaxAttempts);
  let match: (typeof live)[number] | undefined;
  for (const c of live) {
    if (
      timingSafeEqualStr(await emailCodeHmac(ctx, purpose, c.userId, code), c.codeHmac) &&
      match === undefined
    )
      match = c;
  }
  if (match === undefined) {
    if (live.length > 0)
      await commit(ctx, [
        repo.bumpAttempts(
          ctx.db,
          live.map((c) => c.tokenId),
          now,
        ),
      ]);
    throw badRequest(INVALID_CODE);
  }
  return { match, rest };
}

const codeGuard = (ctx: Ctx, tokenId: string) => [
  abortUnless(ctx.db, repo.codeStillLive(tokenId, SETTINGS.emailCodeMaxAttempts, ctx.clock.now())),
  repo.markCodeUsed(ctx.db, tokenId, ctx.clock.now()),
];

async function commitWithCode(ctx: Ctx, stmts: Stmt[]): Promise<void> {
  try {
    await commit(ctx, stmts);
  } catch (err) {
    if (isCondAbort(err)) throw badRequest(INVALID_CODE);
    throw err;
  }
}

export async function verifyEmail(ctx: Ctx, body: { email: string; code: string }) {
  const { match } = await matchCode(ctx, body.email, body.code, "email_verify");
  const now = ctx.clock.now();
  const stmts: Stmt[] = codeGuard(ctx, match.tokenId);
  if (!match.isVerified) {
    stmts.push(
      ctx.db
        .update(repo.tables.users)
        .set({ isVerified: true, verifiedAt: now, updatedAt: now })
        .where(repo.byUserId(match.userId)),
      event(ctx, match.userId, "email_verified", null),
    );
  }
  await commitWithCode(ctx, stmts);
  return { detail: "Email address verified" };
}

export async function resendVerification(
  ctx: Ctx,
  body: { email: string; turnstile_token?: string | null | undefined },
  meta: Meta,
  callerEmail: string | null,
) {
  const email = lower(body.email);
  if (callerEmail === null || callerEmail !== email) {
    await verifyTurnstile({
      secret: ctx.cfg.turnstileSecret,
      token: body.turnstile_token,
      remoteIp: meta.ip,
    });
  }
  const [rows] = await runBatch(ctx.db, [repo.userByEmail(ctx.db, email)] as const);
  const u = rows[0];
  if (u?.isActive && !u.isVerified) {
    const { code, stmts } = await issue(ctx, u.id, "email_verify", SETTINGS.emailVerifyTokenHours * HOUR);
    await commit(ctx, stmts);
    await sendVerificationEmail(mailer(ctx), u.email, code);
  }
  return { detail: "If that address needs verification, a code has been sent." };
}

export async function forgotPassword(
  ctx: Ctx,
  body: { email: string; turnstile_token?: string | null | undefined },
  meta: Meta,
) {
  await verifyTurnstile({ secret: ctx.cfg.turnstileSecret, token: body.turnstile_token, remoteIp: meta.ip });
  const [rows] = await runBatch(ctx.db, [repo.userByEmail(ctx.db, lower(body.email))] as const);
  const u = rows[0];
  if (u?.isActive) {
    const { code, stmts } = await issue(
      ctx,
      u.id,
      "password_reset",
      SETTINGS.passwordResetTokenMinutes * MINUTE,
    );
    await commit(ctx, stmts);
    await sendPasswordResetEmail(mailer(ctx), u.email, code);
  }
  return { detail: "If that address has an account, a reset code has been sent." };
}

export async function resetPassword(ctx: Ctx, body: { email: string; code: string; new_password: string }) {
  const { match } = await matchCode(ctx, body.email, body.code, "password_reset");
  const now = ctx.clock.now();
  const hashed = await hashPassword(body.new_password, ctx.cfg.pepper);
  await commitWithCode(ctx, [
    ...codeGuard(ctx, match.tokenId),
    ctx.db
      .update(repo.tables.users)
      .set({
        hashedPassword: hashed,
        passwordChangedAt: now,
        isVerified: true,
        verifiedAt: repo.coalesceVerifiedAt(now),
        updatedAt: now,
      })
      .where(repo.byUserId(match.userId)),
    event(ctx, match.userId, "password_reset", null),
    ...repo.revokeAllSessions(ctx.db, match.userId, now),
  ]);
  await sendPasswordChangedEmail(mailer(ctx), match.email, ctx.cfg.frontendUrl);
  return { detail: "Password updated. All sessions have been signed out." };
}

export async function recover(
  ctx: Ctx,
  body: {
    email: string;
    recovery_code: string;
    new_password: string;
    turnstile_token?: string | null | undefined;
  },
  meta: Meta,
) {
  await verifyTurnstile({ secret: ctx.cfg.turnstileSecret, token: body.turnstile_token, remoteIp: meta.ip });
  const email = lower(body.email);
  const fail = "That email and recovery code don't match.";
  const [rows, codes] = await runBatch(ctx.db, [
    repo.userByEmail(ctx.db, email),
    repo.unusedRecoveryCodesByEmail(ctx.db, email),
  ] as const);
  const u = rows[0];
  // Any account holding codes may recover: 2FA accounts, and every account made while email was off.
  if (u === undefined || !u.isActive) {
    await recordFailure(ctx, "recover", meta, { email: body.email });
    throw unauthorized(fail);
  }
  const want = await recoveryHmac(ctx, u.id, body.recovery_code);
  const hit = codes.find((c) => timingSafeEqualStr(c.codeHmac, want));
  if (hit === undefined) {
    await recordFailure(ctx, "recover", meta, { userId: u.id });
    throw unauthorized(fail);
  }
  const now = ctx.clock.now();
  const hashed = await hashPassword(body.new_password, ctx.cfg.pepper);
  try {
    await commit(ctx, [
      abortUnless(ctx.db, repo.recoveryCodeUnused(hit.id)),
      repo.useRecoveryCode(ctx.db, hit.id, now),
      ctx.db
        .update(repo.tables.users)
        .set({ hashedPassword: hashed, passwordChangedAt: now, updatedAt: now })
        .where(repo.byUserId(u.id)),
      event(ctx, u.id, "password_recovered", meta),
      ...repo.revokeAllSessions(ctx.db, u.id, now),
    ]);
  } catch (err) {
    if (isCondAbort(err)) throw unauthorized(fail);
    throw err;
  }
  await sendPasswordChangedEmail(mailer(ctx), u.email, ctx.cfg.frontendUrl);
  return { detail: "Password updated with a recovery code. Sign in again." };
}

// ---- email change -----------------------------------------------------------------------------------------

export async function changeEmail(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { password: string; new_email: string },
  meta: Meta,
) {
  const next = lower(body.new_email);
  const [, rows, taken] = await authed.read(
    repo.userById(ctx.db, authed.userId),
    repo.emailTaken(ctx.db, next),
  );
  const u = rows[0];
  if (u === undefined || !(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper)))
    throw unauthorized(BAD_PASSWORD);
  if (next === u.email) throw new HttpError(422, "That's already your address");
  if (!ctx.cfg.emailEnabled) return changeEmailDirectly(ctx, authed, u, next, taken.length > 0, meta);
  const detail = `If ${next} can be used, a confirmation code is on its way there.`;
  if (taken.length > 0) return { detail };
  const now = ctx.clock.now();
  const { code, stmts } = await issue(ctx, u.id, "email_change", SETTINGS.emailChangeTokenHours * HOUR);
  await authed.write(
    ctx.db.update(repo.tables.users).set({ pendingEmail: next, updatedAt: now }).where(repo.byUserId(u.id)),
    ...stmts,
    event(ctx, u.id, "email_change_requested", meta, { to: next }),
  );
  await sendEmailChangeEmail(mailer(ctx), next, code);
  return { detail };
}

/**
 * Email off: no code can prove the new address, so the current password (already checked) is the whole proof, the
 * same bar as changing the password. The address stays unconfirmed, sessions stay, and a security notice lands in
 * the inbox and on every pushed device. Recovery codes are bound to the account, not the address, so the change
 * cannot lock the owner out.
 */
async function changeEmailDirectly(
  ctx: Ctx,
  authed: AuthedBatch,
  u: { id: string; email: string },
  next: string,
  taken: boolean,
  meta: Meta,
) {
  if (taken) throw conflict("That address is already in use by another account");
  const now = ctx.clock.now();
  const notificationId = uuid7(now);
  try {
    await authed.write(
      ctx.db
        .update(repo.tables.users)
        .set({ email: next, pendingEmail: null, isVerified: false, verifiedAt: null, updatedAt: now })
        .where(repo.byUserId(u.id)),
      event(ctx, u.id, "email_changed", meta, { from: u.email, to: next }),
      repo.insertNotification(
        ctx.db,
        {
          id: notificationId,
          userId: u.id,
          kind: "email_changed",
          category: "security",
          title: "Your sign-in email changed",
          body: `It is now ${next}. If this was not you, change your password and sign out everywhere.`,
          url: "/settings/security",
        },
        now,
      ),
    );
  } catch (err) {
    if (isConstraintError(err)) throw conflict("That address is already in use by another account");
    throw err;
  }
  ctx.defer(dispatchDeliver(ctx.env.JOBS, [notificationId]));
  return { detail: "Your email address is updated.", email: next };
}

export async function confirmEmailChange(ctx: Ctx, body: { email: string; code: string }) {
  const next = lower(body.email);
  const { match, rest } = await matchCode(
    ctx,
    next,
    body.code,
    "email_change",
    repo.emailTaken(ctx.db, next),
  );
  const taken = rest[0] as { id: string }[];
  if (match.pendingEmail === null) throw badRequest("Invalid or expired token");
  if (taken.some((r) => r.id !== match.userId))
    throw conflict("That address is now in use by another account");
  const now = ctx.clock.now();
  await commitWithCode(ctx, [
    ...codeGuard(ctx, match.tokenId),
    ctx.db
      .update(repo.tables.users)
      .set({ email: next, pendingEmail: null, isVerified: true, verifiedAt: now, updatedAt: now })
      .where(repo.byUserId(match.userId)),
    event(ctx, match.userId, "email_changed", null, { from: match.email, to: next }),
  ]);
  await sendEmailChangedNotice(mailer(ctx), match.email, next);
  return { detail: "Your email address is updated." };
}

// ---- two-factor -------------------------------------------------------------------------------------------

async function dbUser(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(
    repo.userById(ctx.db, authed.userId),
    repo.unusedRecoveryCodes(ctx.db, authed.userId),
  );
  const u = rows[0];
  if (u === undefined) throw unauthorized("User is inactive or missing");
  return u;
}

export async function twoFactorStatus(ctx: Ctx, authed: AuthedBatch) {
  const [, rows, codes] = await authed.read(
    repo.userById(ctx.db, authed.userId),
    repo.unusedRecoveryCodes(ctx.db, authed.userId),
  );
  const u = rows[0];
  if (u === undefined) throw unauthorized("User is inactive or missing");
  return {
    enabled: u.totpEnabled,
    confirmed_at: toWire(u.totpConfirmedAt),
    recovery_codes_remaining: codes.length,
    // The owner's choice, and whether it is in force: never with email off, and TOTP takes its place.
    email_codes: u.email2faEnabled,
    email_codes_active: emailCodesApply(ctx, u),
    email_available: ctx.cfg.emailEnabled,
  };
}

export async function twoFactorSetup(ctx: Ctx, authed: AuthedBatch) {
  const u = await dbUser(ctx, authed);
  if (u.totpEnabled) throw conflict("Two-factor authentication is already enabled");
  const secret = generateTotpSecret();
  const now = ctx.clock.now();
  await authed.write(
    ctx.db
      .update(repo.tables.users)
      .set({ totpSecret: await encryptString(ctx.cfg.dataKey, secret, totpAad(u.id)), updatedAt: now })
      .where(repo.byUserId(u.id)),
  );
  return { secret, provisioning_uri: totpProvisioningUri(secret, u.email, SETTINGS.appName) };
}

/** Writes guarded by the TOTP replay check; a lost race reads as a wrong code. */
async function writeWithStep(
  ctx: Ctx,
  authed: AuthedBatch,
  userId: string,
  step: number,
  stmts: Stmt[],
): Promise<void> {
  try {
    await authed.write(abortUnless(ctx.db, repo.totpStepFresh(userId, step)), ...stmts);
  } catch (err) {
    if (isCondAbort(err)) throw badRequest("Invalid code");
    throw err;
  }
}

export async function twoFactorEnable(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { password: string; code: string },
) {
  const u = await dbUser(ctx, authed);
  if (u.totpEnabled) throw conflict("Two-factor authentication is already enabled");
  if (u.totpSecret === null) throw badRequest("Start with /v1/auth/2fa/setup");
  if (!(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper)))
    throw unauthorized(BAD_PASSWORD);
  const step = await freshTotpStep(ctx, u, body.code);
  if (step === null) throw badRequest("Invalid code");
  const now = ctx.clock.now();
  const { codes, hmacs } = await newRecoveryCodes(ctx, u.id);
  await writeWithStep(ctx, authed, u.id, step, [
    ctx.db
      .update(repo.tables.users)
      .set({ totpEnabled: true, totpConfirmedAt: now, totpLastUsedStep: step, updatedAt: now })
      .where(repo.byUserId(u.id)),
    ...repo.replaceRecoveryCodes(ctx.db, u.id, hmacs, now),
    repo.deleteTrustedDevices(ctx.db, u.id),
    event(ctx, u.id, "totp_enabled", null),
  ]);
  return { recovery_codes: codes };
}

export async function twoFactorDisable(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { password: string; code: string },
) {
  const u = await dbUser(ctx, authed);
  if (!u.totpEnabled) throw badRequest("Two-factor authentication is not enabled");
  if (!(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper)))
    throw unauthorized(BAD_PASSWORD);
  const step = await freshTotpStep(ctx, u, body.code);
  if (step === null) throw badRequest("Invalid code");
  const now = ctx.clock.now();
  await writeWithStep(ctx, authed, u.id, step, [
    ctx.db
      .update(repo.tables.users)
      .set({
        totpEnabled: false,
        totpSecret: null,
        totpConfirmedAt: null,
        totpLastUsedStep: null,
        updatedAt: now,
      })
      .where(repo.byUserId(u.id)),
    // Email off, the codes are the only way back in after a lost password: they outlive 2FA.
    ...(ctx.cfg.emailEnabled ? [repo.deleteRecoveryCodes(ctx.db, u.id)] : []),
    repo.deleteTrustedDevices(ctx.db, u.id),
    event(ctx, u.id, "totp_disabled", null),
  ]);
  return { detail: "Two-factor authentication disabled" };
}

export async function regenerateRecoveryCodes(ctx: Ctx, authed: AuthedBatch, body: { code: string }) {
  const u = await dbUser(ctx, authed);
  if (!u.totpEnabled) throw badRequest("Two-factor authentication is not enabled");
  const step = await freshTotpStep(ctx, u, body.code);
  if (step === null) throw badRequest("Invalid code");
  const now = ctx.clock.now();
  const { codes, hmacs } = await newRecoveryCodes(ctx, u.id);
  await writeWithStep(ctx, authed, u.id, step, [
    repo.setTotpStep(ctx.db, u.id, step, now),
    ...repo.replaceRecoveryCodes(ctx.db, u.id, hmacs, now),
    event(ctx, u.id, "recovery_codes_regenerated", null),
  ]);
  return { recovery_codes: codes };
}

/**
 * New recovery codes for any account, 2FA or not (they replace the old set). The password is required; with 2FA on,
 * a fresh TOTP code too, so a password alone never mints codes that skip the second factor.
 */
export async function newAccountRecoveryCodes(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { password: string; code?: string | null | undefined },
  meta: Meta,
) {
  const u = await dbUser(ctx, authed);
  if (!(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper))) {
    await recordFailure(ctx, "recovery_codes", meta, { userId: u.id });
    throw unauthorized(BAD_PASSWORD);
  }
  const now = ctx.clock.now();
  const { codes, hmacs } = await newRecoveryCodes(ctx, u.id);
  const writes: Stmt[] = [
    ...repo.replaceRecoveryCodes(ctx.db, u.id, hmacs, now),
    event(ctx, u.id, "recovery_codes_regenerated", meta),
  ];
  if (u.totpEnabled) {
    const step = body.code ? await freshTotpStep(ctx, u, body.code) : null;
    if (step === null) throw badRequest("Invalid code");
    await writeWithStep(ctx, authed, u.id, step, [repo.setTotpStep(ctx.db, u.id, step, now), ...writes]);
  } else {
    await authed.write(...(writes as [Stmt, ...Stmt[]]));
  }
  return { recovery_codes: codes };
}

/**
 * The second step of a password sign-in. TOTP accounts: an authenticator code, or else a recovery code. Email-code
 * accounts: the mailed code, or else a recovery code, and optionally "trust this device" (a new trusted-device row
 * in the same batch as the session).
 */
export async function mfaVerify(
  ctx: Ctx,
  body: { mfa_token: string; code: string; trust_device?: boolean | null | undefined },
  meta: Meta,
): Promise<SignedIn> {
  const claims = await readToken(ctx, body.mfa_token, "mfa");
  if (claims === null) throw unauthorized(CHALLENGE);
  const [rows, codes, hist, chs] = await runBatch(ctx.db, [
    repo.userById(ctx.db, claims.userId),
    repo.unusedRecoveryCodes(ctx.db, claims.userId),
    repo.loginHistory(ctx.db, { id: claims.userId }, meta.userAgent),
    repo.loginChallenge(ctx.db, claims.jti),
  ] as const);
  const u = rows[0];
  if (u === undefined || !u.isActive || u.tokenVersion !== claims.tokenVersion) throw unauthorized(CHALLENGE);
  const now = ctx.clock.now();
  const recovery = async (): Promise<Stmt[] | null> => {
    const want = await recoveryHmac(ctx, u.id, body.code);
    const hit = codes.find((c) => timingSafeEqualStr(c.codeHmac, want));
    return hit === undefined
      ? null
      : [abortUnless(ctx.db, repo.recoveryCodeUnused(hit.id)), repo.useRecoveryCode(ctx.db, hit.id, now)];
  };
  let before: Stmt[];
  let codeMailed = false;
  let trusted: string | undefined;
  if (u.totpEnabled) {
    const step = await freshTotpStep(ctx, u, body.code);
    if (step !== null) {
      before = [
        abortUnless(ctx.db, repo.totpStepFresh(u.id, step)),
        repo.setTotpStep(ctx.db, u.id, step, now),
      ];
    } else {
      const r = await recovery();
      if (r === null) {
        await recordFailure(ctx, "mfa", meta, { userId: u.id });
        throw unauthorized("Invalid code");
      }
      before = r;
    }
  } else {
    const ch = chs[0];
    if (!emailCodesApply(ctx, u) || ch === undefined || ch.userId !== u.id || ch.usedAt !== null)
      throw unauthorized(CHALLENGE);
    const close = repo.useLoginChallenge(ctx.db, ch.id, now);
    if (/^\d{6}$/.test(body.code.trim())) {
      const live = ch.expiresAt > now && ch.attempts < SETTINGS.emailCodeMaxAttempts;
      if (!live) {
        throw unauthorized(
          ch.attempts >= SETTINGS.emailCodeMaxAttempts
            ? "Too many wrong codes. Ask for a new one, or use a recovery code."
            : "That code has expired. Ask for a new one, or use a recovery code.",
        );
      }
      if (!timingSafeEqualStr(await loginCodeHmac(ctx, u.id, body.code.trim()), ch.codeHmac)) {
        await commit(ctx, [repo.bumpLoginAttempts(ctx.db, ch.id)]);
        await recordFailure(ctx, "mfa", meta, { userId: u.id });
        throw unauthorized("Invalid code");
      }
      before = [abortUnless(ctx.db, repo.loginCodeLive(ch.id, SETTINGS.emailCodeMaxAttempts, now)), close];
      codeMailed = true;
      // The code reached this inbox: that confirms the address as well as a verification code would.
      if (!u.isVerified) {
        before.push(
          ctx.db
            .update(repo.tables.users)
            .set({ isVerified: true, verifiedAt: repo.coalesceVerifiedAt(now), updatedAt: now })
            .where(repo.byUserId(u.id)),
          event(ctx, u.id, "email_verified", meta),
        );
      }
    } else {
      // A recovery code proves the account, not the inbox.
      if (ctx.cfg.requireVerifiedEmail && !u.isVerified) throw forbidden("Email address not verified");
      const r = await recovery();
      if (r === null) {
        await recordFailure(ctx, "mfa", meta, { userId: u.id });
        throw unauthorized("Invalid code");
      }
      before = [abortUnless(ctx.db, repo.loginChallengeOpen(ch.id)), ...r, close];
    }
    if (body.trust_device) {
      trusted = newTrustedToken();
      before.push(
        repo.insertTrustedDevice(
          ctx.db,
          {
            id: uuid7(now),
            userId: u.id,
            tokenHash: await trustedHash(ctx, trusted),
            tokenVersion: u.tokenVersion,
            expiresAt: now + SETTINGS.trustedDeviceDays * 24 * HOUR,
            userAgent: meta.userAgent,
            ip: meta.ip,
          },
          now,
        ),
      );
    }
  }
  try {
    const pair = await startSession(ctx, u, meta, hist[0], before, { codeMailed });
    return trusted === undefined ? pair : { ...pair, trusted };
  } catch (err) {
    if (isCondAbort(err)) throw unauthorized("Invalid code");
    throw err;
  }
}

// ---- email codes at sign-in: the setting and trusted devices ---------------------------------------------

export async function setEmailTwoFactor(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { password: string; enabled: boolean },
  meta: Meta,
) {
  const [, rows] = await authed.read(repo.userById(ctx.db, authed.userId));
  const u = rows[0];
  if (u === undefined) throw unauthorized("User is inactive or missing");
  if (!(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper))) {
    await recordFailure(ctx, "email_2fa", meta, { userId: u.id });
    throw unauthorized(BAD_PASSWORD);
  }
  const now = ctx.clock.now();
  await authed.write(
    ctx.db
      .update(repo.tables.users)
      .set({ email2faEnabled: body.enabled, updatedAt: now })
      .where(repo.byUserId(u.id)),
    // Either way the old trust was granted under the old rule.
    repo.deleteTrustedDevices(ctx.db, u.id),
    event(ctx, u.id, body.enabled ? "email_2fa_enabled" : "email_2fa_disabled", meta),
  );
  return { email_enabled: body.enabled };
}

export async function listTrustedDevices(ctx: Ctx, authed: AuthedBatch, cookie: string | undefined) {
  const [, rows] = await authed.read(repo.listTrustedDevices(ctx.db, authed.userId, ctx.clock.now()));
  const mine = cookie === undefined ? null : await trustedHash(ctx, cookie);
  return rows.map((d) => ({
    id: d.id,
    created_at: toWire(d.createdAt),
    last_used_at: toWire(d.lastUsedAt),
    expires_at: toWire(d.expiresAt),
    user_agent: d.userAgent,
    device: describeAgent(d.userAgent),
    ip_address: d.ip,
    current: mine !== null && timingSafeEqualStr(d.tokenHash, mine),
  }));
}

/** Returns true when the caller's own device was the one revoked (the route then clears its cookie). */
export async function revokeTrustedDevice(
  ctx: Ctx,
  authed: AuthedBatch,
  id: string,
  cookie: string | undefined,
): Promise<boolean> {
  const [gone] = await authed.write(
    repo.deleteTrustedDevice(ctx.db, authed.userId, id),
    event(ctx, authed.userId, "trusted_device_revoked", null, { device: id }),
  );
  const row = gone[0];
  if (row === undefined) throw new HttpError(404, "Device not found");
  return cookie !== undefined && timingSafeEqualStr(row.tokenHash, await trustedHash(ctx, cookie));
}

export async function revokeTrustedDevices(ctx: Ctx, authed: AuthedBatch): Promise<void> {
  await authed.write(
    repo.deleteTrustedDevices(ctx.db, authed.userId),
    event(ctx, authed.userId, "trusted_devices_revoked", null),
  );
}

// ---- shared with passkeys.ts ------------------------------------------------------------------------------

export const internal = { startSession, recordFailure, event, dbUser, commit, BAD_PASSWORD };

/** Worker sweep: drops expired WebAuthn challenges (Python `sweep_expired_challenges`). */
export async function sweepExpiredChallenges(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await commit(ctx, [repo.sweepChallenges(ctx.db, now), ...repo.sweepLoginState(ctx.db, now)]);
}

/** A security-event insert for another module's write batch (Python `account.service.record`). */
export const securityEvent = (
  ctx: Ctx,
  userId: string,
  kind: string,
  meta: Meta | null,
  extra?: Record<string, unknown>,
) => event(ctx, userId, kind, meta, extra);

/** Python `revoke_all_sessions` for another module's write batch: every session ends, every access token dies. */
export const revokeAllStatements = (ctx: Ctx, userId: string) =>
  repo.revokeAllSessions(ctx.db, userId, ctx.clock.now());
