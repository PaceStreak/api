/**
 * Query builders for people, follows, blocks, the feed, kudos, comments, reports and buddies (spec/social.md §2-§3).
 * Every function returns an un-awaited statement. Lookups by handle are subqueries, so a handler can read the
 * target and everything about it in the same round trip.
 *
 * Who can see whom lives in three SQL fragments, twins of the Python clauses: `socialOk` (old enough, onboarded,
 * not suspended or leaving), `notBlocked` (no block either way) and `canSee` (self, or social and unblocked and
 * public, or followers-only with an accepted follow).
 */
import { and, eq, ne, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  activityEvents,
  blocks,
  buddyPairs,
  challenges,
  comments,
  follows,
  groups,
  kudos,
  profiles,
  reports,
} from "../../db/schema/index.ts";
import { fold } from "../../lib/fold.ts";
import { PAGE } from "./people.ts";

export const SOCIAL_MIN_AGE = 16;

const col = (alias: string, name: string) => sql.raw(`${alias}.${name}`);

/** SQL twin of `socialAllowed` for profile alias `a`. */
export const socialOk = (a: string, year: number): SQL =>
  sql`(${col(a, "birth_year")} IS NOT NULL AND ${col(a, "birth_year")} <= ${year - SOCIAL_MIN_AGE}
    AND ${col(a, "social_suspended_at")} IS NULL AND ${col(a, "deletion_scheduled_at")} IS NULL
    AND ${col(a, "onboarded_at")} IS NOT NULL)`;

/** No block between `viewer` and the user in `userCol`, either way. */
export const notBlocked = (viewer: string, userCol: SQL): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${viewer} AND b.blocked_id = ${userCol})
    OR (b.blocker_id = ${userCol} AND b.blocked_id = ${viewer}))`;

/** Python `can_see_clause`: the viewer may see this author's activity. */
export const canSee = (viewer: string, a: string, year: number): SQL => {
  const uid = col(a, "user_id");
  return sql`(${uid} = ${viewer} OR (${socialOk(a, year)} AND ${notBlocked(viewer, uid)} AND (
    ${col(a, "visibility")} = 'public' OR (${col(a, "visibility")} = 'followers' AND EXISTS (
      SELECT 1 FROM follows fv WHERE fv.follower_id = ${viewer} AND fv.followee_id = ${uid}
        AND fv.status = 'accepted')))))`;
};

/** The `PersonRow` columns for profile alias `p` and (optionally) user_stats alias `s`. */
export const personCols = (p = "p", s: string | null = "s"): SQL =>
  sql.raw(
    `${p}.user_id AS p_id, ${p}.handle AS p_handle, ${p}.display_name AS p_display_name,
     ${p}.avatar_hue AS p_avatar_hue, ${p}.visibility AS p_visibility, ${p}.is_official AS p_official,
     ${p}.gamification_enabled AS p_gamified, ` +
      (s === null
        ? "NULL AS s_user, NULL AS s_level, NULL AS s_streak"
        : `${s}.user_id AS s_user, ${s}.level AS s_level, ${s}.current_streak AS s_streak`),
  );

/** `_profile_by_handle`: the handle lowercased with every leading `@` stripped. */
export const normHandle = (h: string) => h.toLowerCase().replace(/^@+/, "");

/** user_id of an onboarded profile by handle (NULL when missing): the subquery other statements key on. */
export const idByHandle = (handle: string): SQL =>
  sql`(SELECT user_id FROM profiles WHERE handle = ${normHandle(handle)} AND onboarded_at IS NOT NULL)`;

export type ProfileRow = typeof profiles.$inferSelect;

export const profileOf = (db: Db, userId: string) =>
  db.select().from(profiles).where(eq(profiles.userId, userId));

/** The onboarded profile with this handle (Python 404s on a profile that never onboarded). */
export const profileByHandle = (db: Db, handle: string) =>
  db
    .select()
    .from(profiles)
    .where(and(eq(profiles.handle, normHandle(handle)), sql`${profiles.onboardedAt} IS NOT NULL`));

/** Both follow rows between `me` and the user in `them` (an id or a subquery). */
export const followsBetween = (db: Db, me: string, them: SQL) =>
  db
    .select({ followerId: follows.followerId, status: follows.status })
    .from(follows)
    .where(
      or(
        and(eq(follows.followerId, me), sql`${follows.followeeId} = ${them}`),
        and(sql`${follows.followerId} = ${them}`, eq(follows.followeeId, me)),
      ),
    );

/** Block rows between `me` and `them`, either way. */
export const blocksBetween = (db: Db, me: string, them: SQL) =>
  db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, me), sql`${blocks.blockedId} = ${them}`),
        and(sql`${blocks.blockerId} = ${them}`, eq(blocks.blockedId, me)),
      ),
    );

export const statsOf = (db: Db, them: SQL) =>
  db.all<{ level: number; current_streak: number }>(
    sql`SELECT level, current_streak FROM user_stats WHERE user_id = ${them}`,
  );

export const followCounts = (db: Db, them: SQL) =>
  db.all<{ followers: number; following: number }>(
    sql`SELECT (SELECT count(*) FROM follows WHERE followee_id = ${them} AND status = 'accepted') AS followers,
      (SELECT count(*) FROM follows WHERE follower_id = ${them} AND status = 'accepted') AS following`,
  );

export const badges = (db: Db, userId: string) =>
  db.all<{ achievement_id: string; tier: string | null; unlocked_on: string }>(
    sql`SELECT achievement_id, tier, unlocked_on FROM user_achievements WHERE user_id = ${userId}
      ORDER BY unlocked_on DESC LIMIT 12`,
  );

// ---- people search and suggestions ----------------------------------------------------------------------------

/**
 * `[term, term + U+10FFFF)`: every folded value starting with `term`, as a range the BINARY fold index serves.
 * (`LIKE 'x%'` cannot use an index under SQLite's default case-insensitive LIKE.)
 */
const prefixRange = (column: SQL, term: string): SQL =>
  sql`(${column} >= ${term} AND ${column} < ${`${term}\u{10FFFF}`})`;

/**
 * People search: handles and display names that start with the term (folded: case- and accent-insensitive), each
 * served by its own index. Not self, not private, social, not blocked; shortest handle first, at most 20.
 */
export const searchPeople = (db: Db, viewer: string, term: string, year: number) => {
  const t = fold(term);
  return db.all<import("./people.ts").PersonRow>(
    sql`SELECT ${personCols()} FROM profiles p LEFT JOIN user_stats s ON s.user_id = p.user_id
      WHERE p.user_id IN (SELECT user_id FROM profiles WHERE ${prefixRange(sql`handle_fold`, t)}
                          UNION SELECT user_id FROM profiles WHERE ${prefixRange(sql`display_name_fold`, t)})
        AND p.user_id <> ${viewer} AND p.visibility <> 'private' AND ${socialOk("p", year)}
        AND ${notBlocked(viewer, sql`p.user_id`)}
      ORDER BY length(p.handle), p.handle LIMIT 20`,
  );
};

/** Group-mates and followees of my followees that I don't follow yet (accepted), at most 12. */
export const suggested = (db: Db, viewer: string, year: number) =>
  db.all<import("./people.ts").PersonRow>(
    sql`SELECT ${personCols()} FROM profiles p LEFT JOIN user_stats s ON s.user_id = p.user_id
      WHERE p.user_id IN (
          SELECT gm2.user_id FROM group_members gm1 JOIN group_members gm2 ON gm2.group_id = gm1.group_id
           WHERE gm1.user_id = ${viewer}
          UNION
          SELECT f2.followee_id FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.followee_id
           WHERE f1.follower_id = ${viewer} AND f1.status = 'accepted' AND f2.status = 'accepted')
        AND p.user_id <> ${viewer}
        AND p.user_id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ${viewer} AND status = 'accepted')
        AND p.visibility <> 'private' AND ${socialOk("p", year)} AND ${notBlocked(viewer, sql`p.user_id`)}
      LIMIT 12`,
  );

/** Accepted followers (`incoming`) or followees of `them`, social and unblocked for the viewer, at most 200. */
export const followList = (db: Db, viewer: string, them: SQL, incoming: boolean, year: number) => {
  const join = incoming ? sql`f.follower_id` : sql`f.followee_id`;
  const anchor = incoming ? sql`f.followee_id` : sql`f.follower_id`;
  return db.all<import("./people.ts").PersonRow>(
    sql`SELECT ${personCols()} FROM follows f JOIN profiles p ON p.user_id = ${join}
      LEFT JOIN user_stats s ON s.user_id = p.user_id
      WHERE ${anchor} = ${them} AND f.status = 'accepted' AND ${socialOk("p", year)}
        AND ${notBlocked(viewer, sql`p.user_id`)}
      ORDER BY f.accepted_at DESC LIMIT 200`,
  );
};

export const followRequests = (db: Db, me: string, year: number) =>
  db.all<import("./people.ts").PersonRow & { request_id: string; requested_at: number }>(
    sql`SELECT ${personCols("p", null)}, f.id AS request_id, f.created_at AS requested_at
      FROM follows f JOIN profiles p ON p.user_id = f.follower_id
      WHERE f.followee_id = ${me} AND f.status = 'pending' AND ${socialOk("p", year)}
      ORDER BY f.created_at DESC`,
  );

export const myBlocks = (db: Db, me: string) =>
  db.all<import("./people.ts").PersonRow>(
    sql`SELECT ${personCols("p", null)} FROM blocks b JOIN profiles p ON p.user_id = b.blocked_id
      WHERE b.blocker_id = ${me} ORDER BY b.created_at`,
  );

// ---- follows and blocks ---------------------------------------------------------------------------------------

export const followRow = (db: Db, id: string) => db.select().from(follows).where(eq(follows.id, id));

export const deleteFollow = (db: Db, follower: SQL | string, followee: SQL | string) =>
  db.run(sql`DELETE FROM follows WHERE follower_id = ${follower} AND followee_id = ${followee}`);

export const deleteBlock = (db: Db, me: string, them: SQL) =>
  db.run(sql`DELETE FROM blocks WHERE blocker_id = ${me} AND blocked_id = ${them}`);

/** Is there an onboarded profile with this handle (for writes that key on `idByHandle`)? */
export const handleExists = (db: Db, handle: string) =>
  db.all<{ id: string | null }>(sql`SELECT ${idByHandle(handle)} AS id`);

/** A block severs the follow graph both ways and ends a buddy pair (`a < b`). */
export function blockStatements(db: Db, id: string, me: string, them: string, now: number) {
  const [a, b] = me < them ? [me, them] : [them, me];
  return [
    db
      .insert(blocks)
      .values({ id, blockerId: me, blockedId: them, createdAt: now, updatedAt: now })
      .onConflictDoNothing(),
    db
      .delete(follows)
      .where(
        or(
          and(eq(follows.followerId, me), eq(follows.followeeId, them)),
          and(eq(follows.followerId, them), eq(follows.followeeId, me)),
        ),
      ),
    db
      .update(buddyPairs)
      .set({ status: "ended", endedAt: now, updatedAt: now })
      .where(and(eq(buddyPairs.userA, a), eq(buddyPairs.userB, b), ne(buddyPairs.status, "ended"))),
  ] as const;
}

// ---- feed -----------------------------------------------------------------------------------------------------

/**
 * Feed items: the event, its author, total kudos, live comments, the viewer's reaction and the reaction counts as a
 * JSON object, all in one statement (Python ran two more queries for the reactions).
 */
const feedSelect = (viewer: string) =>
  sql`SELECT e.id AS e_id, e.kind AS e_kind, e.data AS e_data, e.occurred_on AS e_on, e.created_at AS e_created,
      e.user_id AS e_user, ${personCols("p", null)},
      (SELECT count(*) FROM kudos k WHERE k.event_id = e.id) AS kudos,
      (SELECT count(*) FROM comments c WHERE c.event_id = e.id AND c.hidden_at IS NULL) AS comments,
      (SELECT k.reaction FROM kudos k WHERE k.event_id = e.id AND k.user_id = ${viewer}) AS my_reaction,
      (SELECT json_group_object(reaction, n) FROM (SELECT reaction, count(*) AS n FROM kudos k
        WHERE k.event_id = e.id GROUP BY reaction)) AS reactions
    FROM activity_events e JOIN profiles p ON p.user_id = e.user_id`;

type FeedRow = import("./people.ts").FeedRow;
type FeedCursor = import("./people.ts").FeedCursor;

/** Keyset paging on `(created_at, id)`, the feed's sort key; the old timestamp-only cursor pages by time. */
const keyset = (before: FeedCursor | null) =>
  before === null
    ? sql``
    : before.id === null
      ? sql`AND e.created_at < ${before.at}`
      : sql`AND (e.created_at, e.id) < (${before.at}, ${before.id})`;

/**
 * One feed page (Python `_feed_page`): `authors` null means the viewer's own feed (self plus accepted followees);
 * otherwise the user in that subquery. Newest first, 26 rows so the caller knows whether there is more.
 */
export const feedPage = (
  db: Db,
  viewer: string,
  authors: SQL | null,
  before: FeedCursor | null,
  year: number,
) =>
  db.all<FeedRow>(
    sql`${feedSelect(viewer)}
      WHERE e.hidden_at IS NULL AND ${canSee(viewer, "p", year)}
        AND ${
          authors === null
            ? sql`(e.user_id = ${viewer} OR e.user_id IN (SELECT followee_id FROM follows
                  WHERE follower_id = ${viewer} AND status = 'accepted'))`
            : sql`e.user_id = ${authors}`
        }
        ${keyset(before)}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${PAGE + 1}`,
  );

/**
 * A group's feed: members' events, co-membership counting as a follow except for private accounts. Python left
 * out comments (always 0) and reactions; this is the same item as every other feed.
 */
export const groupFeed = (db: Db, viewer: string, groupId: string, before: FeedCursor | null, year: number) =>
  db.all<FeedRow>(
    sql`${feedSelect(viewer)}
      WHERE e.user_id IN (SELECT user_id FROM group_members WHERE group_id = ${groupId})
        AND e.hidden_at IS NULL AND p.visibility <> 'private' AND ${socialOk("p", year)}
        AND ${notBlocked(viewer, sql`e.user_id`)}
        ${keyset(before)}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${PAGE + 1}`,
  );

/** One event as a feed item, only when the viewer may see it (Python `_visible_event` plus the item). */
export const visibleEvent = (db: Db, viewer: string, eventId: string, year: number) =>
  db.all<FeedRow>(
    sql`${feedSelect(viewer)} WHERE e.id = ${eventId} AND e.hidden_at IS NULL AND ${canSee(viewer, "p", year)}`,
  );

/** People who reacted, newest first, filtered by what the viewer may see; at most 50. */
export const kudosBy = (db: Db, viewer: string, eventId: string, year: number) =>
  db.all<import("./people.ts").PersonRow>(
    sql`SELECT ${personCols("p", null)} FROM kudos k JOIN profiles p ON p.user_id = k.user_id
      WHERE k.event_id = ${eventId} AND ${canSee(viewer, "p", year)}
      ORDER BY k.created_at DESC LIMIT 50`,
  );

/** Kudos totals after a write in the same batch: count, the reaction counts and the viewer's own. */
export const kudosState = (db: Db, viewer: string, eventId: string) =>
  db.all<{ kudos: number; reactions: string | null; my_reaction: string | null }>(
    sql`SELECT (SELECT count(*) FROM kudos WHERE event_id = ${eventId}) AS kudos,
      (SELECT json_group_object(reaction, n) FROM (SELECT reaction, count(*) AS n FROM kudos
        WHERE event_id = ${eventId} GROUP BY reaction)) AS reactions,
      (SELECT reaction FROM kudos WHERE event_id = ${eventId} AND user_id = ${viewer}) AS my_reaction`,
  );

export const myKudos = (db: Db, viewer: string, eventId: string) =>
  db
    .select({ id: kudos.id })
    .from(kudos)
    .where(and(eq(kudos.eventId, eventId), eq(kudos.userId, viewer)));

export const upsertKudos = (
  db: Db,
  v: { id: string; eventId: string; userId: string; reaction: (typeof kudos.$inferInsert)["reaction"] },
  now: number,
) =>
  db
    .insert(kudos)
    .values({ ...v, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [kudos.eventId, kudos.userId],
      set: { reaction: v.reaction, updatedAt: now },
    });

export const deleteKudos = (db: Db, viewer: string, eventId: string) =>
  db.delete(kudos).where(and(eq(kudos.eventId, eventId), eq(kudos.userId, viewer)));

export const deleteOwnEvent = (db: Db, viewer: string, eventId: string) =>
  db
    .delete(activityEvents)
    .where(and(eq(activityEvents.id, eventId), eq(activityEvents.userId, viewer)))
    .returning({ id: activityEvents.id });

/** Python `emit_event`: upsert on (user, kind, ref_key), refreshing `data`. */
export const emitEvent = (
  db: Db,
  e: { id: string; userId: string; kind: string; refKey: string; day: string; data: Record<string, unknown> },
  now: number,
) =>
  db
    .insert(activityEvents)
    .values({
      id: e.id,
      userId: e.userId,
      kind: e.kind,
      refKey: e.refKey.slice(0, 120),
      data: e.data,
      occurredOn: e.day,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [activityEvents.userId, activityEvents.kind, activityEvents.refKey],
      set: { data: e.data, updatedAt: now },
    });

// ---- comments -------------------------------------------------------------------------------------------------

/** Live comments by social, unblocked authors, oldest first, at most 200. */
export const listComments = (db: Db, viewer: string, eventId: string, year: number) =>
  db.all<
    import("./people.ts").PersonRow & { c_id: string; c_body: string; c_created: number; c_author: string }
  >(
    sql`SELECT c.id AS c_id, c.body AS c_body, c.created_at AS c_created, c.author_id AS c_author,
        ${personCols("p", null)}
      FROM comments c JOIN profiles p ON p.user_id = c.author_id
      WHERE c.event_id = ${eventId} AND c.hidden_at IS NULL AND ${socialOk("p", year)}
        AND ${notBlocked(viewer, sql`c.author_id`)}
      ORDER BY c.created_at, c.id LIMIT 200`,
  );

export const insertComment = (
  db: Db,
  v: { id: string; eventId: string; authorId: string; body: string },
  now: number,
) => db.insert(comments).values({ ...v, createdAt: now, updatedAt: now });

/** Deletes a comment its author or the event's owner removes; `[]` means 404. */
export const deleteComment = (db: Db, viewer: string, commentId: string) =>
  db
    .delete(comments)
    .where(
      and(
        eq(comments.id, commentId),
        or(
          eq(comments.authorId, viewer),
          sql`${comments.eventId} IN (SELECT id FROM activity_events WHERE user_id = ${viewer})`,
        ),
      ),
    )
    .returning({ id: comments.id });

// ---- reports --------------------------------------------------------------------------------------------------

export const commentById = (db: Db, id: string) =>
  db.select({ userId: comments.authorId, body: comments.body }).from(comments).where(eq(comments.id, id));
export const eventById = (db: Db, id: string) =>
  db
    .select({ userId: activityEvents.userId, kind: activityEvents.kind, data: activityEvents.data })
    .from(activityEvents)
    .where(eq(activityEvents.id, id));
export const groupById = (db: Db, id: string) =>
  db
    .select({ userId: groups.ownerId, name: groups.name, description: groups.description })
    .from(groups)
    .where(eq(groups.id, id));
export const challengeById = (db: Db, id: string) =>
  db
    .select({ userId: challenges.creatorId, title: challenges.title, description: challenges.description })
    .from(challenges)
    .where(eq(challenges.id, id));

export const insertReport = (db: Db, v: typeof reports.$inferInsert) => db.insert(reports).values(v);

// ---- buddies --------------------------------------------------------------------------------------------------

export type PairRow = typeof buddyPairs.$inferSelect;

/** My pending and active pairs with the other person's card and both stats rows, oldest first. */
export const myPairs = (db: Db, me: string) =>
  db.all<
    import("./people.ts").PersonRow & {
      id: string;
      status: string;
      requested_by: string;
      started_at: number | null;
      s_weeks: string | null;
      s_days: number | null;
      s_target: number | null;
    }
  >(
    sql`SELECT bp.id, bp.status, bp.requested_by, bp.started_at, ${personCols()},
        s.recent_weeks AS s_weeks, s.this_week_days AS s_days, s.this_week_target AS s_target
      FROM buddy_pairs bp
      JOIN profiles p ON p.user_id = CASE WHEN bp.user_a = ${me} THEN bp.user_b ELSE bp.user_a END
      LEFT JOIN user_stats s ON s.user_id = p.user_id
      WHERE (bp.user_a = ${me} OR bp.user_b = ${me}) AND bp.status IN ('pending', 'active')
      ORDER BY bp.created_at, bp.id`,
  );

export const statsRows = (db: Db, ids: SQL) =>
  db.all<{ user_id: string; recent_weeks: string; this_week_days: number; this_week_target: number }>(
    sql`SELECT user_id, recent_weeks, this_week_days, this_week_target FROM user_stats WHERE user_id IN ${ids}`,
  );

/** The other member of a pair I'm in, as a subquery (NULL when the pair is missing or not mine). */
export const otherInPair = (pairId: string, me: string): SQL =>
  sql`(SELECT CASE WHEN user_a = ${me} THEN user_b ELSE user_a END FROM buddy_pairs
    WHERE id = ${pairId} AND (user_a = ${me} OR user_b = ${me}))`;

/** A profile by a user-id subquery. */
export const profileWhere = (db: Db, userId: SQL) =>
  db.select().from(profiles).where(sql`${profiles.userId} = ${userId}`);

export const pairById = (db: Db, id: string) => db.select().from(buddyPairs).where(eq(buddyPairs.id, id));

export const pairOf = (db: Db, a: SQL, b: SQL) =>
  db.all<{ id: string; status: string }>(
    sql`SELECT id, status FROM buddy_pairs WHERE user_a = min(${a}, ${b}) AND user_b = max(${a}, ${b})`,
  );

export const livePairCount = (db: Db, me: string) =>
  db.all<{ n: number }>(
    sql`SELECT (SELECT count(*) FROM buddy_pairs WHERE user_a = ${me} AND status IN ('pending', 'active'))
      + (SELECT count(*) FROM buddy_pairs WHERE user_b = ${me} AND status IN ('pending', 'active')) AS n`,
  );

/** A new pair, or an ended one reset to a fresh invite from `me`. */
export const upsertPair = (db: Db, v: { id: string; a: string; b: string; me: string }, now: number) =>
  db
    .insert(buddyPairs)
    .values({
      id: v.id,
      userA: v.a,
      userB: v.b,
      requestedBy: v.me,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [buddyPairs.userA, buddyPairs.userB],
      set: { requestedBy: v.me, status: "pending", startedAt: null, endedAt: null, updatedAt: now },
      where: sql`${buddyPairs.status} = 'ended'`,
    })
    .returning();

export const activatePair = (db: Db, id: string, now: number) =>
  db
    .update(buddyPairs)
    .set({ status: "active", startedAt: now, updatedAt: now })
    .where(and(eq(buddyPairs.id, id), eq(buddyPairs.status, "pending")));

/** Ends a pair I'm in; `[]` when the pair is missing or not mine. */
export const endPair = (db: Db, me: string, id: string, now: number) => [
  db
    .update(buddyPairs)
    .set({ status: "ended", endedAt: now, updatedAt: now })
    .where(
      and(
        eq(buddyPairs.id, id),
        or(eq(buddyPairs.userA, me), eq(buddyPairs.userB, me)),
        ne(buddyPairs.status, "ended"),
      ),
    ),
  db
    .select({ id: buddyPairs.id })
    .from(buddyPairs)
    .where(and(eq(buddyPairs.id, id), or(eq(buddyPairs.userA, me), eq(buddyPairs.userB, me)))),
];

/** An accepted follow in either direction. */
export const followEitherWay = (db: Db, me: string, them: SQL) =>
  db.all<{ ok: number }>(
    sql`SELECT EXISTS (SELECT 1 FROM follows WHERE status = 'accepted' AND (
        (follower_id = ${me} AND followee_id = ${them}) OR (follower_id = ${them} AND followee_id = ${me}))) AS ok`,
  );

/** Python `_may_encourage`: the recipient follows the sender, is an active buddy, or shares a group. */
export const mayEncourage = (db: Db, sender: string, recipient: SQL) =>
  db.all<{ ok: number }>(
    sql`SELECT (EXISTS (SELECT 1 FROM follows WHERE follower_id = ${recipient} AND followee_id = ${sender}
          AND status = 'accepted')
      OR EXISTS (SELECT 1 FROM buddy_pairs WHERE user_a = min(${sender}, ${recipient})
          AND user_b = max(${sender}, ${recipient}) AND status = 'active')
      OR EXISTS (SELECT 1 FROM group_members g1 JOIN group_members g2 ON g2.group_id = g1.group_id
          WHERE g1.user_id = ${sender} AND g2.user_id = ${recipient})) AS ok`,
  );

// ---- EXPLAIN registry -----------------------------------------------------------------------------------------

const U = "00000000-0000-7000-8000-000000000001";
const V = "00000000-0000-7000-8000-000000000002";
const Y = 2026;
const H = sql`(SELECT user_id FROM profiles WHERE handle = 'h' AND onboarded_at IS NOT NULL)`;

type Case = {
  name: string;
  build: (db: Db) => SQLWrapper | { toSQL(): { sql: string; params: unknown[] } };
  scanOk?: string;
};

const cases: Case[] = [
  { name: "social.profileOf", build: (db) => profileOf(db, U) },
  { name: "social.profileByHandle", build: (db) => profileByHandle(db, "h") },
  { name: "social.followsBetween", build: (db) => followsBetween(db, U, H) },
  { name: "social.blocksBetween", build: (db) => blocksBetween(db, U, H) },
  { name: "social.statsOf", build: (db) => statsOf(db, H) },
  { name: "social.followCounts", build: (db) => followCounts(db, H) },
  { name: "social.badges", build: (db) => badges(db, U) },
  { name: "social.searchPeople", build: (db) => searchPeople(db, U, "ann", Y) },
  { name: "social.suggested", build: (db) => suggested(db, U, Y) },
  { name: "social.followers", build: (db) => followList(db, U, H, true, Y) },
  { name: "social.following", build: (db) => followList(db, U, H, false, Y) },
  { name: "social.followRequests", build: (db) => followRequests(db, U, Y) },
  { name: "social.myBlocks", build: (db) => myBlocks(db, U) },
  { name: "social.followRow", build: (db) => followRow(db, U) },
  { name: "social.deleteFollow", build: (db) => deleteFollow(db, U, H) },
  { name: "social.deleteFollower", build: (db) => deleteFollow(db, H, U) },
  { name: "social.deleteBlock", build: (db) => deleteBlock(db, U, H) },
  { name: "social.handleExists", build: (db) => handleExists(db, "h") },
  ...[0, 1, 2].map((i) => ({
    name: `social.block.${i}`,
    build: (db: Db) => blockStatements(db, U, U, V, 0)[i as 0 | 1 | 2],
  })),
  { name: "social.feed", build: (db) => feedPage(db, U, null, null, Y) },
  { name: "social.feedBefore", build: (db) => feedPage(db, U, null, { at: 1, id: V }, Y) },
  { name: "social.feedBeforeOld", build: (db) => feedPage(db, U, null, { at: 1, id: null }, Y) },
  { name: "social.personFeed", build: (db) => feedPage(db, U, H, { at: 1, id: V }, Y) },
  { name: "social.groupFeed", build: (db) => groupFeed(db, U, V, { at: 1, id: V }, Y) },
  { name: "social.visibleEvent", build: (db) => visibleEvent(db, U, V, Y) },
  { name: "social.kudosBy", build: (db) => kudosBy(db, U, V, Y) },
  { name: "social.kudosState", build: (db) => kudosState(db, U, V) },
  { name: "social.myKudos", build: (db) => myKudos(db, U, V) },
  {
    name: "social.upsertKudos",
    build: (db) => upsertKudos(db, { id: U, eventId: V, userId: U, reaction: "fire" }, 0),
  },
  { name: "social.deleteKudos", build: (db) => deleteKudos(db, U, V) },
  { name: "social.deleteOwnEvent", build: (db) => deleteOwnEvent(db, U, V) },
  {
    name: "social.emitEvent",
    build: (db) =>
      emitEvent(db, { id: U, userId: U, kind: "challenge", refKey: "r", day: "2026-01-01", data: {} }, 0),
  },
  { name: "social.listComments", build: (db) => listComments(db, U, V, Y) },
  { name: "social.deleteComment", build: (db) => deleteComment(db, U, V) },
  { name: "social.commentById", build: (db) => commentById(db, U) },
  { name: "social.eventById", build: (db) => eventById(db, U) },
  { name: "social.groupById", build: (db) => groupById(db, U) },
  { name: "social.challengeById", build: (db) => challengeById(db, U) },
  { name: "social.myPairs", build: (db) => myPairs(db, U) },
  { name: "social.statsRows", build: (db) => statsRows(db, sql`(${U}, ${V})`) },
  { name: "social.pairById", build: (db) => pairById(db, U) },
  { name: "social.profileWhere", build: (db) => profileWhere(db, otherInPair(U, V)) },
  { name: "social.pairOf", build: (db) => pairOf(db, sql`${U}`, H) },
  { name: "social.livePairCount", build: (db) => livePairCount(db, U) },
  { name: "social.upsertPair", build: (db) => upsertPair(db, { id: U, a: U, b: V, me: U }, 0) },
  { name: "social.activatePair", build: (db) => activatePair(db, U, 0) },
  { name: "social.endPair", build: (db) => endPair(db, U, V, 0)[0] ?? sql`` },
  { name: "social.endPairCheck", build: (db) => endPair(db, U, V, 0)[1] ?? sql`` },
  { name: "social.followEitherWay", build: (db) => followEitherWay(db, U, H) },
  { name: "social.mayEncourage", build: (db) => mayEncourage(db, U, H) },
];

/** Raw statements (`db.all`, `db.run`) are planned through their SQL. */
export const explain: ExplainCase[] = cases.map((c) => ({
  ...c,
  build: (db: Db) => {
    const b = c.build(db);
    return "toSQL" in b ? b : b.getSQL();
  },
}));
