import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { base, bool, enumCheck, json, maxLength, ms } from "./columns.ts";

export const USER_ROLES = ["admin", "moderator", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** `email` is stored folded (trimmed, NFKD, lowercased): it is its own fold column. */
export const users = sqliteTable(
  "users",
  {
    ...base(),
    email: text().notNull(),
    hashedPassword: text().notNull(),
    role: text({ enum: USER_ROLES }).notNull().default("user"),
    isActive: bool().notNull().default(true),
    tokenVersion: integer().notNull().default(0),
    isVerified: bool().notNull().default(false),
    verifiedAt: ms(),
    passwordChangedAt: ms(),
    pendingEmail: text(),
    /** `v1.<iv>.<ciphertext>`, AES-256-GCM under DATA_KEY. */
    totpSecret: text(),
    totpEnabled: bool().notNull().default(false),
    totpConfirmedAt: ms(),
    totpLastUsedStep: integer(),
    /** Email codes at sign-in for accounts without TOTP. On for every account until its owner turns it off. */
    email2faEnabled: integer("email_2fa_enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    uniqueIndex("ix_users_email").on(t.email),
    // confirm-email-change looks users up by the address they are moving to.
    index("ix_users_pending_email").on(t.pendingEmail).where(sql`${t.pendingEmail} IS NOT NULL`),
    // The hourly error alert mails every active admin.
    index("ix_users_role").on(t.role),
    enumCheck("ck_users_role", t.role, USER_ROLES),
    maxLength("ck_users_email_len", t.email, 320),
    maxLength("ck_users_pending_email_len", t.pendingEmail, 320),
  ],
);

/**
 * One row per refresh-token family (DESIGN.md §6). `id` is the JWT `sid`. Revocation is immediate: the auth
 * statement that leads every authed batch joins this table.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ms().notNull(),
    lastUsedAt: ms(),
    expiresAt: ms().notNull(),
    revokedAt: ms(),
    userAgent: text(),
    ip: text(),
  },
  (t) => [index("ix_sessions_user_id").on(t.userId), index("ix_sessions_expires_at").on(t.expiresAt)],
);

/** Refresh tokens: SHA-256 hex of 64 random bytes. Rotation sets `replaced_by`; reuse after grace burns the session. */
export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text().primaryKey(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    replacedBy: text(),
    usedAt: ms(),
    expiresAt: ms().notNull(),
    createdAt: ms().notNull(),
  },
  (t) => [
    uniqueIndex("ix_refresh_tokens_token_hash").on(t.tokenHash),
    index("ix_refresh_tokens_session_id").on(t.sessionId),
  ],
);

export const OTP_PURPOSES = ["email_verify", "password_reset", "email_change"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Six-digit email codes, stored as HMAC(PEPPER, purpose|user|code). `attempts` is persisted (fixes a Python bug). */
export const oneTimeTokens = sqliteTable(
  "one_time_tokens",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text({ enum: OTP_PURPOSES }).notNull(),
    codeHmac: text().notNull(),
    expiresAt: ms().notNull(),
    usedAt: ms(),
    attempts: integer().notNull().default(0),
  },
  (t) => [
    index("ix_one_time_tokens_user_purpose").on(t.userId, t.purpose, t.createdAt),
    enumCheck("ck_one_time_tokens_purpose", t.purpose, OTP_PURPOSES),
  ],
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** HMAC-SHA256(PEPPER, normalised code), hex. */
    codeHmac: text().notNull(),
    usedAt: ms(),
  },
  (t) => [index("ix_recovery_codes_user_code").on(t.userId, t.codeHmac)],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text().notNull(),
    publicKey: blob({ mode: "buffer" }).$type<Uint8Array>().notNull(),
    signCount: integer().notNull().default(0),
    transports: json<string[]>().notNull().default([]),
    backedUp: bool().notNull().default(false),
    name: text().notNull(),
    lastUsedAt: ms(),
  },
  (t) => [
    uniqueIndex("uq_passkeys_credential_id").on(t.credentialId),
    index("ix_passkeys_user_id").on(t.userId),
    check("ck_passkeys_sign_count", sql`${t.signCount} >= 0`),
  ],
);

export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    ...base(),
    challenge: text().notNull(),
    /** NULL for usernameless sign-in. */
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    purpose: text().notNull(),
    expiresAt: ms().notNull(),
  },
  (t) => [
    uniqueIndex("uq_webauthn_challenges_challenge").on(t.challenge),
    index("ix_webauthn_challenges_user_id").on(t.userId),
    index("ix_webauthn_challenges_expires_at").on(t.expiresAt),
  ],
);

/**
 * A pending email-code sign-in: one row per password sign-in that needs a code. `id` is the `jti` of the MFA token
 * returned to the client, so a code only completes the sign-in it was sent for. The code is stored as
 * HMAC(PEPPER, `login_email|user|code`); `attempts` is persisted, and a resend replaces the code in place.
 */
export const emailLoginChallenges = sqliteTable(
  "email_login_challenges",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHmac: text().notNull(),
    expiresAt: ms().notNull(),
    usedAt: ms(),
    attempts: integer().notNull().default(0),
    lastSentAt: ms().notNull(),
    sends: integer().notNull().default(1),
    createdAt: ms().notNull(),
  },
  (t) => [
    index("ix_email_login_challenges_user_id").on(t.userId),
    index("ix_email_login_challenges_expires_at").on(t.expiresAt),
  ],
);

/**
 * "Trust this device for 30 days": the cookie holds a random token, the row holds HMAC(PEPPER, token). A row only
 * counts while `token_version` equals the user's, so everything that signs every session out (sign out everywhere,
 * a password change, reset or recovery) also ends every trusted device; turning a second factor on or off deletes
 * the rows outright.
 */
export const trustedDevices = sqliteTable(
  "trusted_devices",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    tokenVersion: integer().notNull(),
    expiresAt: ms().notNull(),
    lastUsedAt: ms(),
    userAgent: text(),
    ip: text(),
  },
  (t) => [
    uniqueIndex("uq_trusted_devices_token_hash").on(t.tokenHash),
    index("ix_trusted_devices_user_id").on(t.userId),
    index("ix_trusted_devices_expires_at").on(t.expiresAt),
  ],
);
