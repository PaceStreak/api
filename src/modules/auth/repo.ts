/**
 * Auth query builders. Every function returns an un-awaited statement; services batch them (CONVENTIONS §3).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { type AuthedBatch, abortUnless, guardError } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  authFailures,
  emailLoginChallenges,
  notifications,
  type OtpPurpose,
  oneTimeTokens,
  passkeys,
  recoveryCodes,
  refreshTokens,
  securityEvents,
  sessions,
  trustedDevices,
  users,
  webauthnChallenges,
} from "../../db/schema/index.ts";

const DAY_MS = 86_400_000;

// ---- users ------------------------------------------------------------------------------------------------

const userCols = {
  id: users.id,
  email: users.email,
  hashedPassword: users.hashedPassword,
  isActive: users.isActive,
  isVerified: users.isVerified,
  tokenVersion: users.tokenVersion,
  pendingEmail: users.pendingEmail,
  totpSecret: users.totpSecret,
  totpEnabled: users.totpEnabled,
  totpConfirmedAt: users.totpConfirmedAt,
  totpLastUsedStep: users.totpLastUsedStep,
  email2faEnabled: users.email2faEnabled,
};

export type UserRow = Awaited<ReturnType<typeof userByEmail>>[number];

export const userByEmail = (db: Db, email: string) =>
  db.select(userCols).from(users).where(eq(users.email, email));

export const userById = (db: Db, id: string) => db.select(userCols).from(users).where(eq(users.id, id));

export const emailTaken = (db: Db, email: string) =>
  db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

/** Revoke every session and invalidate every access token (Python `revoke_all_sessions`). */
export const revokeAllSessions = (db: Db, userId: string, now: number) =>
  [
    db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: now })
      .where(eq(users.id, userId)),
  ] as const;

// ---- sessions and refresh tokens --------------------------------------------------------------------------

export interface NewSession {
  userId: string;
  sessionId: string;
  tokenId: string;
  tokenHash: string;
  now: number;
  userAgent: string | null;
  ip: string | null;
  days: number;
}

export const insertSession = (db: Db, s: NewSession) => [
  db.insert(sessions).values({
    id: s.sessionId,
    userId: s.userId,
    createdAt: s.now,
    lastUsedAt: s.now,
    expiresAt: s.now + s.days * DAY_MS,
    userAgent: s.userAgent,
    ip: s.ip,
  }),
  db.insert(refreshTokens).values({
    id: s.tokenId,
    sessionId: s.sessionId,
    tokenHash: s.tokenHash,
    expiresAt: s.now + s.days * DAY_MS,
    createdAt: s.now,
  }),
];

/** The presented refresh token with its session and user. */
export const refreshByHash = (db: Db, tokenHash: string) =>
  db
    .select({
      tokenId: refreshTokens.id,
      sessionId: refreshTokens.sessionId,
      replacedBy: refreshTokens.replacedBy,
      usedAt: refreshTokens.usedAt,
      expiresAt: refreshTokens.expiresAt,
      userId: sessions.userId,
      revokedAt: sessions.revokedAt,
      isActive: users.isActive,
      tokenVersion: users.tokenVersion,
    })
    .from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(refreshTokens.tokenHash, tokenHash));

/** The live tip of the presented token's session (at most one row has no successor). */
export const liveTipByHash = (db: Db, tokenHash: string) =>
  db
    .select({ id: refreshTokens.id, expiresAt: refreshTokens.expiresAt })
    .from(refreshTokens)
    .where(
      and(
        eq(
          refreshTokens.sessionId,
          sql`(SELECT session_id FROM refresh_tokens WHERE token_hash = ${tokenHash})`,
        ),
        isNull(refreshTokens.replacedBy),
      ),
    )
    .limit(1);

export const sessionIdByHash = (db: Db, tokenHash: string) =>
  db
    .select({ sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash));

export const revokeSession = (db: Db, sessionId: string, now: number) =>
  db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

export const listSessions = (db: Db, userId: string, now: number) =>
  db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.createdAt));

/** Revokes one of the caller's sessions; an already revoked one keeps its time. RETURNING is empty when not theirs. */
export const revokeOwnSession = (db: Db, userId: string, sessionId: string, now: number) =>
  db
    .update(sessions)
    .set({ revokedAt: sql`COALESCE(${sessions.revokedAt}, ${now})` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });

// ---- security events, failures, notifications -------------------------------------------------------------

export interface EventIn {
  userId: string;
  kind: string;
  now: number;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}

export const insertEvent = (db: Db, e: EventIn) =>
  db.insert(securityEvents).values({
    userId: e.userId,
    kind: e.kind,
    ipAddress: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    meta: e.meta ?? null,
    createdAt: e.now,
    updatedAt: e.now,
  });

/**
 * Python `note_sign_in`: has this account signed in before, and ever with this user agent? The outer column is
 * written qualified by hand: drizzle renders `${users.id}` unqualified in a one-table select, and inside the
 * subquery a bare `"id"` binds to `security_events.id`, so the notice never fired (CHANGES-FROM-PYTHON.md).
 */
export const loginHistory = (db: Db, by: { id: string } | { email: string }, userAgent: string | null) =>
  db
    .select({
      hasHistory: sql<number>`EXISTS (SELECT 1 FROM security_events e WHERE e.user_id = "users"."id" AND e.kind = 'login')`,
      knownAgent:
        userAgent === null
          ? sql<number>`0`
          : sql<number>`EXISTS (SELECT 1 FROM security_events e WHERE e.user_id = "users"."id" AND e.kind = 'login' AND e.user_agent = ${userAgent})`,
    })
    .from(users)
    .where("id" in by ? eq(users.id, by.id) : eq(users.email, by.email));

export const insertAuthFailure = (
  db: Db,
  f: {
    kind: string;
    ip: string | null;
    emailHash: string | null;
    userId: string | null;
    email: string | null;
  },
  now: number,
) =>
  db.insert(authFailures).values({
    kind: f.kind,
    ipAddress: f.ip,
    emailHash: f.emailHash,
    userId: f.userId ?? (f.email === null ? null : sql`(SELECT id FROM users WHERE email = ${f.email})`),
    createdAt: now,
    updatedAt: now,
  });

export const insertNotification = (
  db: Db,
  n: {
    id: string;
    userId: string;
    kind: string;
    category: string;
    title: string;
    body: string;
    url: string;
    data?: Record<string, unknown> | null;
  },
  now: number,
) =>
  db
    .insert(notifications)
    .values({
      ...n,
      title: n.title.slice(0, 120),
      body: n.body.slice(0, 400),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });

// ---- email codes ------------------------------------------------------------------------------------------

/** Invalidate the user's unused codes of `purpose`, then add the new one. */
export const issueCode = (
  db: Db,
  c: { id: string; userId: string; purpose: OtpPurpose; codeHmac: string; expiresAt: number },
  now: number,
) => [
  db
    .update(oneTimeTokens)
    .set({ usedAt: now, updatedAt: now })
    .where(
      and(
        eq(oneTimeTokens.userId, c.userId),
        eq(oneTimeTokens.purpose, c.purpose),
        isNull(oneTimeTokens.usedAt),
      ),
    ),
  db.insert(oneTimeTokens).values({ ...c, createdAt: now, updatedAt: now }),
];

/**
 * Active users whose (pending) address is `email`, each with their newest live code for `purpose`, if any.
 * Python `consume_one_time_token` reads the same rows.
 */
export const codeCandidates = (db: Db, email: string, purpose: OtpPurpose, now: number) => {
  const addr = purpose === "email_change" ? users.pendingEmail : users.email;
  return db
    .select({
      userId: users.id,
      email: users.email,
      pendingEmail: users.pendingEmail,
      isVerified: users.isVerified,
      // Aliased: batch rows are keyed by column name, and users.id is also `id`.
      tokenId: sql<string>`${oneTimeTokens.id}`.as("token_id"),
      codeHmac: oneTimeTokens.codeHmac,
      attempts: oneTimeTokens.attempts,
    })
    .from(users)
    .innerJoin(
      oneTimeTokens,
      eq(
        oneTimeTokens.id,
        sql`(SELECT t.id FROM one_time_tokens t WHERE t.user_id = ${users.id} AND t.purpose = ${purpose}
              AND t.used_at IS NULL AND t.expires_at > ${now} ORDER BY t.created_at DESC LIMIT 1)`,
      ),
    )
    .where(and(eq(addr, email), eq(users.isActive, true)));
};

/** Persisted attempt counting (fixes the Python rollback bug, CHANGES-FROM-PYTHON.md). */
export const bumpAttempts = (db: Db, tokenIds: string[], now: number) =>
  db
    .update(oneTimeTokens)
    .set({ attempts: sql`${oneTimeTokens.attempts} + 1`, updatedAt: now })
    .where(inArray(oneTimeTokens.id, tokenIds));

export const codeStillLive = (tokenId: string, maxAttempts: number, now: number) =>
  sql`EXISTS (SELECT 1 FROM one_time_tokens WHERE id = ${tokenId} AND used_at IS NULL
        AND attempts < ${maxAttempts} AND expires_at > ${now})`;

export const markCodeUsed = (db: Db, tokenId: string, now: number) =>
  db.update(oneTimeTokens).set({ usedAt: now, updatedAt: now }).where(eq(oneTimeTokens.id, tokenId));

// ---- TOTP and recovery codes ------------------------------------------------------------------------------

export const unusedRecoveryCodes = (db: Db, userId: string) =>
  db
    .select({ id: recoveryCodes.id, codeHmac: recoveryCodes.codeHmac })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));

export const replaceRecoveryCodes = (db: Db, userId: string, hmacs: string[], now: number) => [
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)),
  db
    .insert(recoveryCodes)
    .values(hmacs.map((codeHmac) => ({ userId, codeHmac, createdAt: now, updatedAt: now }))),
];

export const recoveryCodeUnused = (id: string) =>
  sql`EXISTS (SELECT 1 FROM recovery_codes WHERE id = ${id} AND used_at IS NULL)`;

export const useRecoveryCode = (db: Db, id: string, now: number) =>
  db.update(recoveryCodes).set({ usedAt: now, updatedAt: now }).where(eq(recoveryCodes.id, id));

/** TOTP replay guard: true while `step` is newer than the last accepted one. */
export const totpStepFresh = (userId: string, step: number) =>
  sql`EXISTS (SELECT 1 FROM users WHERE id = ${userId}
        AND (totp_last_used_step IS NULL OR totp_last_used_step < ${step}))`;

export const setTotpStep = (db: Db, userId: string, step: number, now: number) =>
  db.update(users).set({ totpLastUsedStep: step, updatedAt: now }).where(eq(users.id, userId));

// ---- email codes at sign-in ------------------------------------------------------------------------------

export const insertLoginChallenge = (
  db: Db,
  c: { id: string; userId: string; codeHmac: string; expiresAt: number },
  now: number,
) => db.insert(emailLoginChallenges).values({ ...c, lastSentAt: now, sends: 1, createdAt: now });

export const loginChallenge = (db: Db, id: string) =>
  db.select().from(emailLoginChallenges).where(eq(emailLoginChallenges.id, id));

/** A wrong code: the counter is saved in its own write (the Python bug was a counter that never was). */
export const bumpLoginAttempts = (db: Db, id: string) =>
  db
    .update(emailLoginChallenges)
    .set({ attempts: sql`${emailLoginChallenges.attempts} + 1` })
    .where(eq(emailLoginChallenges.id, id));

/** Single use under concurrency: the sign-in batch aborts unless the code is still unused, unexpired and unspent. */
export const loginCodeLive = (id: string, maxAttempts: number, now: number) =>
  sql`EXISTS (SELECT 1 FROM email_login_challenges WHERE id = ${id} AND used_at IS NULL
        AND attempts < ${maxAttempts} AND expires_at > ${now})`;

/** A recovery code may end a challenge whose email code expired or ran out of attempts; only reuse is refused. */
export const loginChallengeOpen = (id: string) =>
  sql`EXISTS (SELECT 1 FROM email_login_challenges WHERE id = ${id} AND used_at IS NULL)`;

export const useLoginChallenge = (db: Db, id: string, now: number) =>
  db.update(emailLoginChallenges).set({ usedAt: now }).where(eq(emailLoginChallenges.id, id));

/** A resend: a fresh code with fresh attempts, guarded on the cooldown and the caller's hourly counter. */
export const resendLoginChallenge = (
  db: Db,
  r: { id: string; codeHmac: string; expiresAt: number; now: number; cooldownMs: number; allowed: SQL },
) =>
  db
    .update(emailLoginChallenges)
    .set({
      codeHmac: r.codeHmac,
      expiresAt: r.expiresAt,
      attempts: 0,
      lastSentAt: r.now,
      sends: sql`${emailLoginChallenges.sends} + 1`,
    })
    .where(
      and(
        eq(emailLoginChallenges.id, r.id),
        isNull(emailLoginChallenges.usedAt),
        lte(emailLoginChallenges.lastSentAt, r.now - r.cooldownMs),
        r.allowed,
      ),
    )
    .returning({ id: emailLoginChallenges.id });

// ---- trusted devices --------------------------------------------------------------------------------------

/** The trusted device the cookie names, if it belongs to `email`'s account and that account's sessions are intact. */
export const trustedForLogin = (db: Db, email: string, tokenHash: string, now: number) =>
  db
    .select({ id: trustedDevices.id })
    .from(trustedDevices)
    .innerJoin(users, eq(users.id, trustedDevices.userId))
    .where(
      and(
        eq(trustedDevices.tokenHash, tokenHash),
        eq(users.email, email),
        eq(trustedDevices.tokenVersion, users.tokenVersion),
        gt(trustedDevices.expiresAt, now),
      ),
    );

export const insertTrustedDevice = (
  db: Db,
  d: {
    id: string;
    userId: string;
    tokenHash: string;
    tokenVersion: number;
    expiresAt: number;
    userAgent: string | null;
    ip: string | null;
  },
  now: number,
) => db.insert(trustedDevices).values({ ...d, lastUsedAt: now, createdAt: now, updatedAt: now });

export const touchTrustedDevice = (db: Db, id: string, now: number) =>
  db.update(trustedDevices).set({ lastUsedAt: now, updatedAt: now }).where(eq(trustedDevices.id, id));

/** Live trusted devices: unexpired, and minted under the account's current token version. */
export const listTrustedDevices = (db: Db, userId: string, now: number) =>
  db
    .select({
      id: trustedDevices.id,
      tokenHash: trustedDevices.tokenHash,
      createdAt: trustedDevices.createdAt,
      lastUsedAt: trustedDevices.lastUsedAt,
      expiresAt: trustedDevices.expiresAt,
      userAgent: trustedDevices.userAgent,
      ip: trustedDevices.ip,
    })
    .from(trustedDevices)
    .innerJoin(users, eq(users.id, trustedDevices.userId))
    .where(
      and(
        eq(trustedDevices.userId, userId),
        eq(trustedDevices.tokenVersion, users.tokenVersion),
        gt(trustedDevices.expiresAt, now),
      ),
    )
    .orderBy(desc(trustedDevices.createdAt));

export const deleteTrustedDevice = (db: Db, userId: string, id: string) =>
  db
    .delete(trustedDevices)
    .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, userId)))
    .returning({ id: trustedDevices.id, tokenHash: trustedDevices.tokenHash });

export const deleteTrustedDevices = (db: Db, userId: string) =>
  db.delete(trustedDevices).where(eq(trustedDevices.userId, userId));

/** Worker sweep: spent or expired sign-in challenges, and expired or revoked trusted devices. */
export const sweepLoginState = (db: Db, now: number) => [
  db.delete(emailLoginChallenges).where(lt(emailLoginChallenges.expiresAt, now - DAY_MS)),
  db
    .delete(trustedDevices)
    .where(
      or(
        lt(trustedDevices.expiresAt, now),
        sql`${trustedDevices.tokenVersion} <> (SELECT token_version FROM users WHERE id = ${trustedDevices.userId})`,
      ),
    ),
];

// ---- passkeys ---------------------------------------------------------------------------------------------

export const listPasskeys = (db: Db, userId: string) =>
  db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));

export const passkeyById = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));

export const passkeyByCredential = (db: Db, credentialId: string) =>
  db
    .select({
      id: passkeys.id,
      userId: passkeys.userId,
      credentialId: passkeys.credentialId,
      publicKey: passkeys.publicKey,
      signCount: passkeys.signCount,
      transports: passkeys.transports,
      isActive: users.isActive,
      isVerified: users.isVerified,
      tokenVersion: users.tokenVersion,
    })
    .from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(eq(passkeys.credentialId, credentialId));

export const insertChallenge = (
  db: Db,
  c: { challenge: string; userId: string | null; purpose: "register" | "sign_in"; expiresAt: number },
  now: number,
) => db.insert(webauthnChallenges).values({ ...c, createdAt: now, updatedAt: now });

export const challengeRow = (db: Db, challenge: string, purpose: string) =>
  db
    .select({ userId: webauthnChallenges.userId, expiresAt: webauthnChallenges.expiresAt })
    .from(webauthnChallenges)
    .where(and(eq(webauthnChallenges.challenge, challenge), eq(webauthnChallenges.purpose, purpose)));

export const deleteChallenge = (db: Db, challenge: string) =>
  db.delete(webauthnChallenges).where(eq(webauthnChallenges.challenge, challenge));

export const challengeLive = (challenge: string, purpose: string, now: number) =>
  sql`EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge = ${challenge} AND purpose = ${purpose}
        AND expires_at >= ${now})`;

/** Worker sweep (Python `sweep_expired_challenges`). */
export const sweepChallenges = (db: Db, now: number) =>
  db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));

export const explain: ExplainCase[] = [
  { name: "auth.userByEmail", build: (db) => userByEmail(db, "a@b.c") },
  { name: "auth.userById", build: (db) => userById(db, "u") },
  { name: "auth.refreshByHash", build: (db) => refreshByHash(db, "h") },
  { name: "auth.liveTipByHash", build: (db) => liveTipByHash(db, "h") },
  { name: "auth.listSessions", build: (db) => listSessions(db, "u", 0) },
  { name: "auth.revokeOwnSession", build: (db) => revokeOwnSession(db, "u", "s", 0) },
  {
    name: "auth.revokeAllSessions",
    build: (db) => revokeAllSessions(db, "u", 0)[0] as ReturnType<typeof revokeSession>,
  },
  { name: "auth.loginHistory", build: (db) => loginHistory(db, { email: "a@b.c" }, "ua") },
  { name: "auth.codeCandidates", build: (db) => codeCandidates(db, "a@b.c", "email_verify", 0) },
  {
    name: "auth.codeCandidates.pending",
    build: (db) => codeCandidates(db, "a@b.c", "email_change", 0),
  },
  {
    name: "auth.issueCode",
    build: (db) =>
      issueCode(
        db,
        { id: "i", userId: "u", purpose: "email_verify", codeHmac: "h", expiresAt: 0 },
        0,
      )[0] as ReturnType<typeof markCodeUsed>,
  },
  { name: "auth.unusedRecoveryCodes", build: (db) => unusedRecoveryCodes(db, "u") },
  { name: "auth.listPasskeys", build: (db) => listPasskeys(db, "u") },
  { name: "auth.passkeyByCredential", build: (db) => passkeyByCredential(db, "c") },
  { name: "auth.challengeRow", build: (db) => challengeRow(db, "c", "sign_in") },
  { name: "auth.sweepChallenges", build: (db) => sweepChallenges(db, 0) },
  { name: "auth.loginChallenge", build: (db) => loginChallenge(db, "c") },
  { name: "auth.trustedForLogin", build: (db) => trustedForLogin(db, "a@b.c", "h", 0) },
  { name: "auth.listTrustedDevices", build: (db) => listTrustedDevices(db, "u", 0) },
];

// ---- small pieces used by the service ---------------------------------------------------------------------

export const tables = { users } as const;

export const byUserId = (id: string) => eq(users.id, id);

/** Keep the first verification time. */
export const coalesceVerifiedAt = (now: number) => sql<number>`COALESCE(${users.verifiedAt}, ${now})`;

export const unusedRecoveryCodesByEmail = (db: Db, email: string) =>
  db
    .select({ id: recoveryCodes.id, codeHmac: recoveryCodes.codeHmac })
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.userId, sql`(SELECT id FROM users WHERE email = ${email})`),
        isNull(recoveryCodes.usedAt),
      ),
    );

export const deleteRecoveryCodes = (db: Db, userId: string) =>
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));

export const sessionOwned = (userId: string, sessionId: string) =>
  sql`EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId})`;

/** Logout: revoke the session the cookie belongs to, in one statement. */
export const revokeSessionByToken = (db: Db, tokenHash: string, now: number) =>
  db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.id, sql`(SELECT session_id FROM refresh_tokens WHERE token_hash = ${tokenHash})`),
        isNull(sessions.revokedAt),
      ),
    );

/** One rotation: guard (tip still live, session live), retire the tip, add its successor, extend the session. */
export const rotate = (
  db: Db,
  r: { sessionId: string; fromId: string; nextId: string; nextHash: string; now: number; days: number },
) => {
  const expiresAt = r.now + r.days * DAY_MS;
  return [
    abortUnless(
      db,
      sql`EXISTS (SELECT 1 FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id
            WHERE t.id = ${r.fromId} AND t.replaced_by IS NULL AND s.revoked_at IS NULL)`,
    ),
    db
      .update(refreshTokens)
      .set({ replacedBy: r.nextId, usedAt: r.now })
      .where(eq(refreshTokens.id, r.fromId)),
    db.insert(refreshTokens).values({
      id: r.nextId,
      sessionId: r.sessionId,
      tokenHash: r.nextHash,
      expiresAt,
      createdAt: r.now,
    }),
    db.update(sessions).set({ lastUsedAt: r.now, expiresAt }).where(eq(sessions.id, r.sessionId)),
  ];
};

/** `AuthedBatch.write`'s session guard, for a batch that has to go through `runBatch` itself. */
export const sessionGuardFor = (authed: AuthedBatch) => authed.guardStatement();

export const mapSessionGuard = guardError;

export const passkeyOwned = (userId: string, id: string) =>
  and(eq(passkeys.id, id), eq(passkeys.userId, userId));
