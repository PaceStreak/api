/**
 * Operator commands (Python app/cli.py), as SQL for `wrangler d1 execute`. scripts/admin.ts is the command line;
 * this file is pure so the rules are tested in the Worker test pool. Nothing here is reachable over HTTP: the
 * first admin has to come from someone who already has database access.
 *
 * Passwords come from PACESTREAK_PASSWORD or a prompt, never argv (shell history, `ps`).
 */
import { USER_ROLES, type UserRole } from "../../db/schema/auth.ts";
import { hashPassword } from "../../lib/crypto/pbkdf2.ts";
import { uuid7 } from "../../lib/uuid7.ts";

export const MIN_PASSWORD = 16;

export class OperatorError extends Error {}

/** Python `_password`: refuses a short password with the same message. */
export function checkPassword(password: string): string {
  if (password.length < MIN_PASSWORD) {
    throw new OperatorError(`Passwords must be at least ${MIN_PASSWORD} characters.`);
  }
  return password;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const normal = (email: string) => email.trim().toLowerCase();

/** A verified admin (there is no inbox to verify from yet; the operator vouches). Fails if the email exists. */
export async function createAdminSql(email: string, password: string, pepper: Uint8Array, now: number) {
  const hash = await hashPassword(checkPassword(password), pepper);
  return (
    "INSERT INTO users (id, created_at, updated_at, email, hashed_password, role, is_active, token_version, " +
    "is_verified, verified_at, password_changed_at, totp_enabled) VALUES " +
    `(${lit(uuid7(now))}, ${now}, ${now}, ${lit(normal(email))}, ${lit(hash)}, 'admin', 1, 0, 1, ${now}, ${now}, 0);`
  );
}

/** New hash, every session revoked and the token version bumped (Python `set_password`). */
export async function setPasswordSql(email: string, password: string, pepper: Uint8Array, now: number) {
  const hash = await hashPassword(checkPassword(password), pepper);
  const e = lit(normal(email));
  return (
    `UPDATE sessions SET revoked_at = ${now} WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = ${e});\n` +
    `UPDATE users SET hashed_password = ${lit(hash)}, password_changed_at = ${now}, ` +
    `token_version = token_version + 1, updated_at = ${now} WHERE email = ${e};`
  );
}

export function setRoleSql(email: string, role: string, now: number): string {
  if (!(USER_ROLES as readonly string[]).includes(role)) {
    throw new OperatorError(`Role must be one of: ${USER_ROLES.join(", ")}.`);
  }
  return `UPDATE users SET role = ${lit(role as UserRole)}, updated_at = ${now} WHERE email = ${lit(normal(email))};`;
}
