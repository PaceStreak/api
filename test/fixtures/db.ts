/**
 * Database fixtures for tests: a counted drizzle client over the test D1 and direct row factories.
 * Rows are written with drizzle (never raw SQL strings) so they follow the schema's types and defaults.
 */
import { env } from "cloudflare:test";
import { AuthedBatch, type Principal } from "../../src/db/batch.ts";
import { createDb, type Db, type DbStats, newStats } from "../../src/db/client.ts";
import { profiles, sessions, type UserRole, users } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";

export interface TestDb {
  db: Db;
  stats: DbStats;
  /** Zeroes the round-trip counters, so an assertion covers only what follows. */
  reset(): void;
}

export function testDb(): TestDb {
  const stats = newStats();
  return {
    db: createDb(env.DB, stats),
    stats,
    reset: () => {
      stats.roundTrips = 0;
      stats.statements = 0;
    },
  };
}

export interface SeedUserOptions {
  email?: string;
  role?: UserRole;
  isActive?: boolean;
  isVerified?: boolean;
  tokenVersion?: number;
  handle?: string | null;
  timezone?: string;
  /** Default true: an onboarded profile row is created. */
  withProfile?: boolean;
}

export interface SeededUser extends Principal {
  email: string;
}

let counter = 0;

/** A unique address per call: test files share one D1 per file, so data from earlier tests stays around. */
export function uniqueEmail(prefix = "user"): string {
  counter++;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

/**
 * Inserts a user, an optional profile and a live session in one batch. The password hash is a placeholder: the
 * AUTH unit's `signup()` fixture replaces this for tests that sign in over HTTP.
 */
export async function seedUser(db: Db, opts: SeedUserOptions = {}): Promise<SeededUser> {
  const now = Date.now();
  const userId = uuid7(now);
  const sessionId = uuid7(now);
  const email = opts.email ?? uniqueEmail();
  const tokenVersion = opts.tokenVersion ?? 0;
  const userInsert = db.insert(users).values({
    id: userId,
    createdAt: now,
    updatedAt: now,
    email,
    hashedPassword: "pbkdf2-sha256$v=1$i=1$placeholder$placeholder",
    role: opts.role ?? "user",
    isActive: opts.isActive ?? true,
    isVerified: opts.isVerified ?? true,
    tokenVersion,
  });
  const sessionInsert = db.insert(sessions).values({
    id: sessionId,
    userId,
    createdAt: now,
    expiresAt: now + 7 * 86_400_000,
  });
  if (opts.withProfile === false) {
    await db.batch([userInsert, sessionInsert]);
  } else {
    const handle = opts.handle === undefined ? null : opts.handle;
    await db.batch([
      userInsert,
      sessionInsert,
      db.insert(profiles).values({
        userId,
        createdAt: now,
        updatedAt: now,
        handle,
        handleFold: handle === null ? null : handle.toLowerCase(),
        timezone: opts.timezone ?? "UTC",
        onboardedAt: now,
        acceptedTermsAt: now,
      }),
    ]);
  }
  return { userId, sessionId, tokenVersion, email };
}

/** An `AuthedBatch` for a seeded user: what `auth()` attaches once the AUTH unit lands. */
export function authedBatch(db: Db, user: Principal): AuthedBatch {
  return new AuthedBatch(db, {
    userId: user.userId,
    sessionId: user.sessionId,
    tokenVersion: user.tokenVersion,
  });
}
