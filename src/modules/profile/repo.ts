/** Profile queries (spec/account.md §3). Builders are returned un-awaited; the service batches them. */
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import { follows, notifications, profiles, streakChains, users } from "../../db/schema/index.ts";

/** Who is calling, as `AuthedBatch.principal` carries it. */
export interface Live {
  userId: string;
  sessionId: string;
  tokenVersion: number;
}

/** True while the caller's session is live: lets a read batch create the profile without a write round trip. */
const live = (p: Live) => sql`EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ${p.sessionId} AND s.user_id = ${p.userId} AND s.revoked_at IS NULL AND u.is_active = 1
    AND u.token_version = ${p.tokenVersion})`;

/**
 * Python `get_profile`'s lazy insert, safe inside a read batch: it inserts only for a live session (so a revoked
 * session or a deleted account writes nothing and the batch's auth check answers 401), and never twice.
 */
export const ensureProfileSql = (p: Live, id: string, hue: number, now: number) =>
  sql`INSERT INTO profiles (id, created_at, updated_at, user_id, avatar_hue)
    SELECT ${id}, ${now}, ${now}, ${p.userId}, ${hue} WHERE ${live(p)}
    ON CONFLICT (user_id) DO NOTHING`;
export const ensureProfile = (db: Db, p: Live, id: string, hue: number, now: number) =>
  db.run(ensureProfileSql(p, id, hue, now));

/** Python `get_chains`: the default all-disciplines chain while the user has none (same guard as above). */
export const ensureChainSql = (p: Live, id: string, now: number) =>
  sql`INSERT INTO streak_chains (id, created_at, updated_at, user_id, name, disciplines, target_history,
      requirements_history, position, archived)
    SELECT ${id}, ${now}, ${now}, ${p.userId}, 'Everything', '[]', ${JSON.stringify([{ from: "2000-01-03", target: 3 }])},
      '[]', 0, 0
    WHERE ${live(p)} AND NOT EXISTS (SELECT 1 FROM streak_chains WHERE user_id = ${p.userId} AND archived = 0)`;
export const ensureChain = (db: Db, p: Live, id: string, now: number) => db.run(ensureChainSql(p, id, now));

export const profile = (db: Db, userId: string) =>
  db.select().from(profiles).where(eq(profiles.userId, userId));

export const isOfficial = (db: Db, userId: string) =>
  db.select({ isOfficial: profiles.isOfficial }).from(profiles).where(eq(profiles.userId, userId));

export const userExtras = (db: Db, userId: string) =>
  db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId));

export const unreadCount = (db: Db, userId: string) =>
  db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

export const followRequests = (db: Db, userId: string) =>
  db
    .select({ n: count() })
    .from(follows)
    .where(and(eq(follows.followeeId, userId), eq(follows.status, "pending")));

export const handleTaken = (db: Db, handle: string, userId: string) =>
  db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(eq(profiles.handle, handle), ne(profiles.userId, userId)))
    .limit(1);

export const mainChain = (db: Db, userId: string) =>
  db
    .select({ id: streakChains.id, targetHistory: streakChains.targetHistory })
    .from(streakChains)
    .where(and(eq(streakChains.userId, userId), eq(streakChains.archived, false)))
    .orderBy(streakChains.position, streakChains.createdAt)
    .limit(1);

export type ProfileValues = Partial<typeof profiles.$inferInsert>;

export const updateProfile = (db: Db, userId: string, values: ProfileValues, now: number) =>
  db
    .update(profiles)
    .set({ ...values, updatedAt: now })
    .where(eq(profiles.userId, userId))
    .returning();

export const setChainHistory = (
  db: Db,
  id: string,
  history: (typeof streakChains.$inferSelect)["targetHistory"],
  now: number,
) => db.update(streakChains).set({ targetHistory: history, updatedAt: now }).where(eq(streakChains.id, id));

const P: Live = { userId: "u", sessionId: "s", tokenVersion: 0 };

export const explain: ExplainCase[] = [
  { name: "profile.ensureProfile", build: () => ensureProfileSql(P, "id", 1, 0) },
  { name: "profile.ensureChain", build: () => ensureChainSql(P, "id", 0) },
  { name: "profile.profile", build: (db) => profile(db, "u") },
  { name: "profile.isOfficial", build: (db) => isOfficial(db, "u") },
  { name: "profile.userExtras", build: (db) => userExtras(db, "u") },
  { name: "profile.unreadCount", build: (db) => unreadCount(db, "u") },
  { name: "profile.followRequests", build: (db) => followRequests(db, "u") },
  { name: "profile.handleTaken", build: (db) => handleTaken(db, "h", "u") },
  { name: "profile.mainChain", build: (db) => mainChain(db, "u") },
  { name: "profile.updateProfile", build: (db) => updateProfile(db, "u", { bio: "x" }, 0) },
  { name: "profile.setChainHistory", build: (db) => setChainHistory(db, "c", [], 0) },
];
