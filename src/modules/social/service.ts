/**
 * People, the follow graph, the feed, kudos, comments, reports, buddies and encouragement (spec/social.md §2-§3).
 * The only file another module may import: groups use `person`, `cleanText`, `requireSocial`, the feed and
 * `emitEvent` from here.
 *
 * Cost: every read route is one D1 round trip (target-by-handle lookups are subqueries of the same batch); every
 * write is a read and a write, or a single write when nothing has to be known first. The person page is two: the
 * profile read, then the snapshot.
 *
 * Privacy: nothing here reads a habit table. Feeds carry activity events (never emitted for a habit), cards carry
 * identity and the whole-life streak, buddies see weekly progress only.
 */
import { eq, type SQL, sql } from "drizzle-orm";
import { RULE_BY_ID } from "../../catalog/achievements.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, type AuthUser, rateLimitGuard, type Stmt } from "../../db/batch.ts";
import { follows as followsT } from "../../db/schema/index.ts";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors.ts";
import { BUCKETS, type Bucket, perUser } from "../../lib/ratelimit.ts";
import { daysBetween, localDate, toWire, weekStart, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { chainPayload, jointStreak, snapshotsFor } from "../game/service.ts";
import { dispatchNotified, type NotifyResult, notify } from "../notifications/service.ts";
import type { FeedCursor } from "./people.ts";
import {
  cleanText,
  displayName,
  feedItem,
  feedPage,
  type PersonRow,
  PRESETS,
  person,
  personRow,
} from "./people.ts";
import * as repo from "./repo.ts";
import type { CommentInput, Reaction, ReportInput } from "./schemas.ts";

export type { FeedCursor, FeedRow, Person, PersonRow } from "./people.ts";
export {
  cleanOrNull,
  cleanText,
  codePoints,
  displayName,
  feedPage,
  inviteCode,
  person,
  personRow,
} from "./people.ts";
export {
  canSee,
  emitEvent,
  groupFeed,
  idByHandle,
  notBlocked,
  personCols,
  SOCIAL_MIN_AGE,
  socialOk,
} from "./repo.ts";

type ProfileRow = repo.ProfileRow;

export const utcYear = (ctx: Ctx) => new Date(ctx.clock.now()).getUTCFullYear();

/** Python `Profile.social_allowed(year)`. */
export function socialAllowed(
  p: Pick<ProfileRow, "birthYear" | "socialSuspendedAt" | "deletionScheduledAt" | "onboardedAt">,
  year: number,
): boolean {
  return (
    p.birthYear !== null &&
    year - p.birthYear >= repo.SOCIAL_MIN_AGE &&
    p.socialSuspendedAt === null &&
    p.deletionScheduledAt === null &&
    p.onboardedAt !== null
  );
}

/**
 * Python `require_social`: onboarded, allowed social features, confirmed email (email on only); in that order. A caller
 * without a profile has not onboarded.
 */
export function requireSocial(ctx: Ctx, user: AuthUser, me: ProfileRow | undefined): ProfileRow {
  if (me === undefined || me.onboardedAt === null) throw forbidden("Finish setting up your profile first");
  if (!socialAllowed(me, utcYear(ctx))) throw forbidden("Social features are not available");
  // Only while email is on: with it off no address can be confirmed, and nothing waits on one.
  if (ctx.cfg.emailEnabled && !user.isVerified) throw forbidden("Confirm your email address first");
  return me;
}

/**
 * A rate-limited write: the bucket's counter, a guard that aborts the batch (429) when it is over the limit, then
 * `stmts`. Returns the results of `stmts`.
 */
export async function limitedWrite(
  ctx: Ctx,
  authed: AuthedBatch,
  bucket: Bucket,
  subject: string,
  stmts: readonly Stmt[],
): Promise<unknown[]> {
  const limit = perUser(ctx.db, bucket, subject, ctx.clock.now());
  const res = (await authed.write(
    limit.counter,
    ctx.db.run(rateLimitGuard(limit.key, bucket.limit)),
    ...stmts,
  )) as unknown[];
  return res.slice(2);
}

const NO_SUCH_PERSON = "No such person";

const sqlId = (id: string): SQL => sql`${id}`;
const inList = (ids: readonly (string | SQL)[]): SQL =>
  sql`(${sql.join(
    ids.map((i) => (typeof i === "string" ? sql`${i}` : i)),
    sql`, `,
  )})`;

/** Emits an activity event when the profile may be seen at all (Python `emit_event`), else nothing. */
export function emitStatement(
  ctx: Ctx,
  p: ProfileRow,
  e: { kind: string; refKey: string; day: string; data: Record<string, unknown> },
): Stmt | null {
  if (p.visibility === "private" || p.sharingPaused || !socialAllowed(p, utcYear(ctx))) return null;
  const now = ctx.clock.now();
  return repo.emitEvent(ctx.db, { id: uuid7(now), userId: p.userId, ...e }, now);
}

interface Relation {
  following: string | null;
  follows_you: string | null;
  blocked: boolean;
}

function relation(me: string, follows: readonly { followerId: string; status: string }[], iBlock: boolean) {
  const out: Relation = { following: null, follows_you: null, blocked: iBlock };
  for (const f of follows) {
    if (f.followerId === me) out.following = f.status;
    else out.follows_you = f.status;
  }
  return out;
}

/** Python `can_see` from rows already read: self, or social and unblocked and public or followed. */
function canSeeRows(me: string, them: ProfileRow, year: number, blocked: boolean, following: string | null) {
  if (them.userId === me) return true;
  if (!socialAllowed(them, year) || blocked) return false;
  return them.visibility === "public" || (them.visibility === "followers" && following === "accepted");
}

/** Reads `them` (by handle) and what decides whether the viewer may see them, plus `extra`, in one round trip. */
async function readPerson<T extends readonly Stmt[]>(
  ctx: Ctx,
  authed: AuthedBatch,
  handle: string,
  ...extra: T
) {
  const me = authed.userId;
  const them = repo.idByHandle(handle);
  const [user, rows, follows, blocks, ...rest] = await authed.read(
    repo.profileByHandle(ctx.db, handle),
    repo.followsBetween(ctx.db, me, them),
    repo.blocksBetween(ctx.db, me, them),
    ...extra,
  );
  const target = rows[0];
  if (target === undefined) throw notFound(NO_SUCH_PERSON);
  const rel = relation(
    me,
    follows,
    blocks.some((b) => b.blockerId === me),
  );
  const visible = canSeeRows(me, target, utcYear(ctx), blocks.length > 0, rel.following);
  return { user, target, rel, blocked: blocks.length > 0, visible, rest };
}

// ---- people ---------------------------------------------------------------------------------------------------

/** GET /people/search: handle or display-name prefix, folded; 60 a minute per user (RL_SEARCH, in the route). */
export async function searchPeople(ctx: Ctx, authed: AuthedBatch, q: string) {
  const term = q.trim().toLowerCase().replace(/^@+/, "");
  const [user, me, rows] = await authed.read(
    repo.profileOf(ctx.db, authed.userId),
    repo.searchPeople(ctx.db, authed.userId, term, utcYear(ctx)),
  );
  requireSocial(ctx, user, me[0]);
  return rows.map((r) => person(r, true));
}

export async function suggested(ctx: Ctx, authed: AuthedBatch) {
  const [user, me, rows] = await authed.read(
    repo.profileOf(ctx.db, authed.userId),
    repo.suggested(ctx.db, authed.userId, utcYear(ctx)),
  );
  requireSocial(ctx, user, me[0]);
  return rows.map((r) => person(r, true));
}

/**
 * GET /people/{handle}: the card, relationship and counts in one read; when the viewer may see more, the person's
 * snapshot (streak, heatmap, totals) and latest badges in a second.
 */
export async function viewPerson(ctx: Ctx, authed: AuthedBatch, handle: string) {
  const uid = authed.userId;
  const them = repo.idByHandle(handle);
  const { target, rel, blocked, visible, rest } = await readPerson(
    ctx,
    authed,
    handle,
    repo.profileOf(ctx.db, uid),
    repo.statsOf(ctx.db, them),
    repo.followCounts(ctx.db, them),
  );
  const [viewerRows, stats, counts] = rest;
  const year = utcYear(ctx);
  const me = target.userId === uid;
  if (!me) {
    const viewer = viewerRows[0];
    if (viewer === undefined || !socialAllowed(viewer, year) || blocked || !socialAllowed(target, year))
      throw notFound(NO_SUCH_PERSON);
  }
  const c = counts[0];
  const data: Record<string, unknown> = {
    ...person(personRow(target, stats[0]), true),
    bio: target.bio,
    me,
    visible,
    relationship: me ? null : rel,
    counts: { followers: c?.followers ?? 0, following: c?.following ?? 0 },
  };
  if (!visible) return data;

  const got = (await snapshotsFor(ctx, [target.userId], (u) => [repo.badges(ctx.db, u)])).get(target.userId);
  if (got === undefined) throw new Error("snapshot missing");
  const snap = got.snapshot;
  const held = (got.extra[0] ?? []) as Awaited<ReturnType<typeof repo.badges>>;
  const streak = chainPayload(snap.chains[0]);
  const gamified = target.gamificationEnabled;
  return Object.assign(data, {
    streak: {
      current: streak.current,
      longest: streak.longest,
      this_week_days: streak.this_week_days,
      this_week_target: streak.this_week_target,
      weeks: streak.weeks,
    },
    heatmap: snap.heatmap.map((h) => ({ date: h.date, level: h.level })),
    totals: { sessions: snap.sessions, active_days: snap.days.length },
    achievements: gamified
      ? held.flatMap((b) => {
          const rule = RULE_BY_ID.get(b.achievement_id);
          return rule === undefined
            ? []
            : [{ id: b.achievement_id, title: rule.title, tier: b.tier, date: b.unlocked_on }];
        })
      : [],
    level: gamified ? snap.level : null,
  });
}

/** GET /people/{handle}/events: 404 unless the viewer may see the person. */
export async function personEvents(ctx: Ctx, authed: AuthedBatch, handle: string, before: FeedCursor | null) {
  const { visible, rest } = await readPerson(
    ctx,
    authed,
    handle,
    repo.feedPage(ctx.db, authed.userId, repo.idByHandle(handle), before, utcYear(ctx)),
  );
  if (!visible) throw notFound(NO_SUCH_PERSON);
  return feedPage(rest[0], authed.userId);
}

export async function followList(ctx: Ctx, authed: AuthedBatch, handle: string, incoming: boolean) {
  const { visible, rest } = await readPerson(
    ctx,
    authed,
    handle,
    repo.followList(ctx.db, authed.userId, repo.idByHandle(handle), incoming, utcYear(ctx)),
  );
  if (!visible) throw notFound(NO_SUCH_PERSON);
  return rest[0].map((r) => person(r, true));
}

/** POST /people/{handle}/follow: public is immediate, followers-only waits for approval, private is a 404. */
export async function follow(ctx: Ctx, authed: AuthedBatch, handle: string) {
  const uid = authed.userId;
  const { user, target, rel, blocked, rest } = await readPerson(
    ctx,
    authed,
    handle,
    repo.profileOf(ctx.db, uid),
  );
  const me = requireSocial(ctx, user, rest[0][0]);
  if (target.userId === uid) throw new HttpError(422, "You cannot follow yourself");
  if (blocked || !socialAllowed(target, utcYear(ctx)) || target.visibility === "private")
    throw notFound(NO_SUCH_PERSON);
  if (rel.following !== null) return { status: rel.following };
  const now = ctx.clock.now();
  const accepted = target.visibility === "public";
  const name = me.displayName || `@${me.handle}`;
  const [, note] = await limitedWrite(ctx, authed, BUCKETS.follow, uid, [
    ctx.db.insert(followsT).values({
      id: uuid7(now),
      followerId: uid,
      followeeId: target.userId,
      status: accepted ? "accepted" : "pending",
      acceptedAt: accepted ? now : null,
      createdAt: now,
      updatedAt: now,
    }),
    // Once per follower, ever: unfollowing and following again never notifies twice.
    notify(ctx, {
      userId: target.userId,
      kind: accepted ? "new_follower" : "follow_request",
      category: "social",
      title: accepted ? `${name} followed you` : `${name} wants to follow you`,
      url: accepted ? `/u/${me.handle}` : "/people?tab=requests",
      actorId: uid,
      dedupeKey: `follow:${uid}`,
    }),
  ]);
  dispatchNotified(ctx, note as NotifyResult);
  return { status: accepted ? "accepted" : "pending" };
}

/** One write: the delete keys on the handle's user id, and the same batch says whether the handle exists. */
async function deleteByHandle(ctx: Ctx, authed: AuthedBatch, handle: string, stmt: Stmt) {
  const [, exists] = await authed.write(stmt, repo.handleExists(ctx.db, handle));
  if ((exists[0]?.id ?? null) === null) throw notFound(NO_SUCH_PERSON);
}

export const unfollow = (ctx: Ctx, authed: AuthedBatch, handle: string) =>
  deleteByHandle(ctx, authed, handle, repo.deleteFollow(ctx.db, authed.userId, repo.idByHandle(handle)));

export const removeFollower = (ctx: Ctx, authed: AuthedBatch, handle: string) =>
  deleteByHandle(ctx, authed, handle, repo.deleteFollow(ctx.db, repo.idByHandle(handle), authed.userId));

export const unblock = (ctx: Ctx, authed: AuthedBatch, handle: string) =>
  deleteByHandle(ctx, authed, handle, repo.deleteBlock(ctx.db, authed.userId, repo.idByHandle(handle)));

export async function followRequests(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.followRequests(ctx.db, authed.userId, utcYear(ctx)));
  return rows.map((r) =>
    person(r, false, { request_id: r.request_id, requested_at: toWire(r.requested_at) }),
  );
}

export async function answerRequest(ctx: Ctx, authed: AuthedBatch, requestId: string, decision: string) {
  if (decision !== "accept" && decision !== "decline") throw notFound("Not found");
  const uid = authed.userId;
  const [, rows, meRows] = await authed.read(repo.followRow(ctx.db, requestId), repo.profileOf(ctx.db, uid));
  const req = rows[0];
  if (req === undefined || req.followeeId !== uid || req.status !== "pending") throw notFound("Not found");
  const now = ctx.clock.now();
  if (decision === "decline") {
    await authed.write(ctx.db.delete(followsT).where(eq(followsT.id, req.id)));
    return { status: decision };
  }
  const me = meRows[0];
  const [, note] = await authed.write(
    ctx.db
      .update(followsT)
      .set({ status: "accepted", acceptedAt: now, updatedAt: now })
      .where(eq(followsT.id, req.id)),
    notify(ctx, {
      userId: req.followerId,
      kind: "follow_accepted",
      category: "social",
      title: `${me?.displayName || `@${me?.handle ?? ""}`} accepted your follow request`,
      url: `/u/${me?.handle ?? null}`,
      actorId: uid,
      dedupeKey: `follow_accepted:${uid}`,
    }),
  );
  dispatchNotified(ctx, note);
  return { status: decision };
}

/** POST /people/{handle}/block: severs follows both ways and ends a buddy pair. No social gate, no notice. */
export async function block(ctx: Ctx, authed: AuthedBatch, handle: string) {
  const uid = authed.userId;
  const [, rows] = await authed.read(repo.profileByHandle(ctx.db, handle));
  const target = rows[0];
  if (target === undefined) throw notFound(NO_SUCH_PERSON);
  if (target.userId === uid) throw new HttpError(422, "You cannot block yourself");
  const now = ctx.clock.now();
  await authed.write(...repo.blockStatements(ctx.db, uuid7(now), uid, target.userId, now));
}

export async function myBlocks(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.myBlocks(ctx.db, authed.userId));
  return rows.map((r) => person(r));
}

// ---- feed, events, kudos, comments ----------------------------------------------------------------------------

export async function feed(ctx: Ctx, authed: AuthedBatch, before: FeedCursor | null) {
  const [, rows] = await authed.read(repo.feedPage(ctx.db, authed.userId, null, before, utcYear(ctx)));
  return feedPage(rows, authed.userId);
}

/**
 * GET /events/{id}: the event as a feed item plus who reacted, one read. Python looked for it in the viewer's
 * first feed page and otherwise built a fallback with `comments: 0`; the item is the same either way, with the
 * real comment count.
 */
export async function getEvent(ctx: Ctx, authed: AuthedBatch, eventId: string) {
  const year = utcYear(ctx);
  const [, rows, by] = await authed.read(
    repo.visibleEvent(ctx.db, authed.userId, eventId, year),
    repo.kudosBy(ctx.db, authed.userId, eventId, year),
  );
  const row = rows[0];
  if (row === undefined) throw notFound("Not found");
  return { ...feedItem(row, authed.userId), kudos_by: by.map((r) => person(r)) };
}

export async function deleteEvent(ctx: Ctx, authed: AuthedBatch, eventId: string) {
  const [gone] = await authed.write(repo.deleteOwnEvent(ctx.db, authed.userId, eventId));
  if (gone.length === 0) throw notFound("Not found");
}

const kudosOut = (
  row: { kudos: number; reactions: string | null; my_reaction: string | null } | undefined,
) => ({
  kudos: row?.kudos ?? 0,
  reactions: (row?.reactions ? JSON.parse(row.reactions) : {}) as Record<string, number>,
  my_reaction: row?.my_reaction ?? null,
});

/** POST /events/{id}/kudos: one preset reaction per person, switchable; the author hears about the first only. */
export async function giveKudos(ctx: Ctx, authed: AuthedBatch, eventId: string, reaction: Reaction) {
  const uid = authed.userId;
  const [user, meRows, events, mine] = await authed.read(
    repo.profileOf(ctx.db, uid),
    repo.visibleEvent(ctx.db, uid, eventId, utcYear(ctx)),
    repo.myKudos(ctx.db, uid, eventId),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const event = events[0];
  if (event === undefined) throw notFound("Not found");
  const now = ctx.clock.now();
  const stmts: Stmt[] = [repo.upsertKudos(ctx.db, { id: uuid7(now), eventId, userId: uid, reaction }, now)];
  const told = mine.length === 0 && event.e_user !== uid;
  if (told)
    stmts.push(
      notify(ctx, {
        userId: event.e_user,
        kind: "kudos",
        category: "social",
        title: `${displayName(me)} gave you kudos`,
        url: `/feed/${eventId}`,
        actorId: uid,
        dedupeKey: `kudos:${eventId}:${uid}`,
      }),
    );
  stmts.push(repo.kudosState(ctx.db, uid, eventId));
  const res = await limitedWrite(ctx, authed, BUCKETS.kudos, uid, stmts);
  if (told) dispatchNotified(ctx, res[1] as NotifyResult);
  const state = kudosOut((res[res.length - 1] as Awaited<ReturnType<typeof repo.kudosState>>)[0]);
  return { kudos: state.kudos, kudoed: true, reactions: state.reactions, my_reaction: state.my_reaction };
}

/** DELETE /events/{id}/kudos: no visibility check (Python), one write. */
export async function takeKudos(ctx: Ctx, authed: AuthedBatch, eventId: string) {
  const [, state] = await authed.write(
    repo.deleteKudos(ctx.db, authed.userId, eventId),
    repo.kudosState(ctx.db, authed.userId, eventId),
  );
  const s = kudosOut(state[0]);
  return { kudos: s.kudos, kudoed: false, reactions: s.reactions, my_reaction: s.my_reaction };
}

export async function listComments(ctx: Ctx, authed: AuthedBatch, eventId: string) {
  const uid = authed.userId;
  const year = utcYear(ctx);
  const [, events, rows] = await authed.read(
    repo.visibleEvent(ctx.db, uid, eventId, year),
    repo.listComments(ctx.db, uid, eventId, year),
  );
  const event = events[0];
  if (event === undefined) throw notFound("Not found");
  return rows.map((c) => ({
    id: c.c_id,
    body: c.c_body,
    created_at: toWire(c.c_created),
    author: person(c),
    can_delete: c.c_author === uid || event.e_user === uid,
    mine: c.c_author === uid,
  }));
}

export async function addComment(ctx: Ctx, authed: AuthedBatch, eventId: string, body: CommentInput) {
  const uid = authed.userId;
  const [user, meRows, events] = await authed.read(
    repo.profileOf(ctx.db, uid),
    repo.visibleEvent(ctx.db, uid, eventId, utcYear(ctx)),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const event = events[0];
  if (event === undefined) throw notFound("Not found");
  const now = ctx.clock.now();
  const id = uuid7(now);
  const stmts: Stmt[] = [repo.insertComment(ctx.db, { id, eventId, authorId: uid, body: body.body }, now)];
  if (event.e_user !== uid)
    stmts.push(
      notify(ctx, {
        userId: event.e_user,
        kind: "comment",
        category: "social",
        title: `${displayName(me)} commented`,
        body: Array.from(body.body).slice(0, 140).join(""),
        url: `/feed/${eventId}`,
        actorId: uid,
      }),
    );
  const res = await limitedWrite(ctx, authed, BUCKETS.comment, uid, stmts);
  if (stmts.length > 1) dispatchNotified(ctx, res[1] as NotifyResult);
  return {
    id,
    body: body.body,
    created_at: toWire(now),
    author: person(personRow(me)),
    can_delete: true,
    mine: true,
  };
}

export async function deleteComment(ctx: Ctx, authed: AuthedBatch, commentId: string) {
  const [gone] = await authed.write(repo.deleteComment(ctx.db, authed.userId, commentId));
  if (gone.length === 0) throw notFound("Not found");
}

// ---- reports --------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Python `UUID(target_id)` accepts hyphenless and braced forms; ids are stored lowercase and hyphenated. */
function parseUuid(s: string): string | null {
  const t = s
    .trim()
    .replace(/^\{(.*)\}$/, "$1")
    .replace(/^urn:uuid:/i, "");
  if (!UUID_RE.test(t)) return null;
  const h = t.replaceAll("-", "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** POST /reports: anyone can report any existing target; the snapshot keeps what was reported. */
export async function report(ctx: Ctx, authed: AuthedBatch, body: ReportInput) {
  const db = ctx.db;
  let snapshot: Record<string, unknown> | null = null;
  let reported: string | null = null;
  if (body.target_type === "user") {
    const [, rows] = await authed.read(repo.profileByHandle(db, body.target_id));
    const t = rows[0];
    if (t !== undefined) {
      reported = t.userId;
      snapshot = { handle: t.handle, display_name: t.displayName, bio: t.bio };
    }
  } else {
    const id = parseUuid(body.target_id);
    if (id === null) throw notFound("Not found");
    if (body.target_type === "comment") {
      const [, rows] = await authed.read(repo.commentById(db, id));
      if (rows[0]) [reported, snapshot] = [rows[0].userId, { body: rows[0].body }];
    } else if (body.target_type === "event") {
      const [, rows] = await authed.read(repo.eventById(db, id));
      if (rows[0]) [reported, snapshot] = [rows[0].userId, { kind: rows[0].kind, data: rows[0].data }];
    } else if (body.target_type === "group") {
      const [, rows] = await authed.read(repo.groupById(db, id));
      if (rows[0])
        [reported, snapshot] = [rows[0].userId, { name: rows[0].name, description: rows[0].description }];
    } else {
      const [, rows] = await authed.read(repo.challengeById(db, id));
      if (rows[0])
        [reported, snapshot] = [rows[0].userId, { title: rows[0].title, description: rows[0].description }];
    }
  }
  if (snapshot === null) throw notFound("Not found");
  const now = ctx.clock.now();
  await limitedWrite(ctx, authed, BUCKETS.report, authed.userId, [
    repo.insertReport(db, {
      id: uuid7(now),
      reporterId: authed.userId,
      reportedUserId: reported,
      targetType: body.target_type as "user",
      targetId: body.target_id,
      reason: body.reason,
      // Python: `clean_text(detail) if detail else None`, so whitespace-only detail is stored as "".
      detail: body.detail ? cleanText(body.detail) : null,
      snapshot,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return { detail: "Thanks - a moderator will look at it." };
}

// ---- buddies --------------------------------------------------------------------------------------------------

export const MAX_BUDDIES = 5;

type StatsRow = { recent_weeks: string; this_week_days: number; this_week_target: number };

/** How many of my weeks, including this one, have passed since the pair started (Python `_weeks_since`). */
function weeksSince(ctx: Ctx, me: ProfileRow, started: number | null): number {
  const tz = zone(me.timezone);
  const today = localDate(ctx.clock.now(), tz);
  const start = weekStart(started === null ? today : localDate(started, tz), me.weekStartsOn);
  return Math.floor(daysBetween(start, weekStart(today, me.weekStartsOn)) / 7) + 1;
}

/** Python `pair_view`: progress only. Nothing about sessions, notes or pause reasons crosses over. */
function pairView(
  ctx: Ctx,
  pair: { id: string; status: string; requested_by: string; started_at: number | null },
  me: ProfileRow,
  them: PersonRow,
  mine: StatsRow | undefined,
  theirs: StatsRow | undefined,
) {
  const out: Record<string, unknown> = {
    id: pair.id,
    status: pair.status,
    incoming: pair.status === "pending" && pair.requested_by !== me.userId,
    buddy: person(them, true),
    started_at: toWire(pair.started_at),
  };
  if (pair.status !== "active" || mine === undefined || theirs === undefined) return out;
  const a = JSON.parse(mine.recent_weeks) as string[];
  const b = JSON.parse(theirs.recent_weeks) as string[];
  const r = jointStreak([a, b], 1.0, weeksSince(ctx, me, pair.started_at));
  return Object.assign(out, {
    current: r.current,
    longest: r.longest,
    weeks: r.weeks.slice(-12).map((w) => w.status),
    me: { days: mine.this_week_days, target: mine.this_week_target },
    them: {
      days: theirs.this_week_days,
      target: theirs.this_week_target,
      paused: b[b.length - 1] === "paused",
    },
  });
}

const statsFor = (
  pairs: readonly {
    s_user: string | null;
    s_weeks: string | null;
    s_days: number | null;
    s_target: number | null;
  }[],
) =>
  pairs[0]?.s_user == null
    ? undefined
    : {
        recent_weeks: pairs[0].s_weeks ?? "[]",
        this_week_days: pairs[0].s_days ?? 0,
        this_week_target: pairs[0].s_target ?? 3,
      };

export async function listBuddies(ctx: Ctx, authed: AuthedBatch) {
  const uid = authed.userId;
  const [user, meRows, pairs, mine] = await authed.read(
    repo.profileOf(ctx.db, uid),
    repo.myPairs(ctx.db, uid),
    repo.statsRows(ctx.db, inList([uid])),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  return pairs.map((p) => pairView(ctx, p, me, p, mine[0], statsFor([p])));
}

/** POST /buddies: invite someone with an accepted follow either way; one message for every "can't". */
export async function invite(ctx: Ctx, authed: AuthedBatch, handle: string) {
  const uid = authed.userId;
  const them = repo.idByHandle(handle);
  const { user, target, blocked, rest } = await readPerson(
    ctx,
    authed,
    handle,
    repo.profileOf(ctx.db, uid),
    repo.followEitherWay(ctx.db, uid, them),
    repo.livePairCount(ctx.db, uid),
    repo.pairOf(ctx.db, sqlId(uid), them),
    repo.statsRows(ctx.db, inList([uid, them])),
    repo.statsOf(ctx.db, them),
  );
  const [meRows, linked, count, existing, stats, theirStats] = rest;
  const me = requireSocial(ctx, user, meRows[0]);
  if (target.userId === uid) throw new HttpError(422, "You can't buddy up with yourself");
  if (!socialAllowed(target, utcYear(ctx)) || blocked || !linked[0]?.ok)
    throw forbidden("You can buddy up with people you follow or who follow you.");
  if ((count[0]?.n ?? 0) >= MAX_BUDDIES) throw conflict(`${MAX_BUDDIES} buddies at a time is the limit`);
  const pair = existing[0];
  if (pair !== undefined && pair.status !== "ended")
    throw conflict("You're already buddies, or an invite is waiting");
  const now = ctx.clock.now();
  const id = pair?.id ?? uuid7(now);
  const [a, b] = uid < target.userId ? [uid, target.userId] : [target.userId, uid];
  const [rows, note] = (await limitedWrite(ctx, authed, BUCKETS.buddyInvite, uid, [
    repo.upsertPair(ctx.db, { id, a, b, me: uid }, now),
    notify(ctx, {
      userId: target.userId,
      kind: "buddy_invite",
      category: "social",
      title: `@${me.handle} wants to be streak buddies`,
      body: "A week counts when you both keep yours. You'd see each other's weekly progress.",
      url: "/buddies",
      actorId: uid,
      dedupeKey: `buddy-invite:${id}:${new Date(now).toISOString().slice(0, 10)}`,
    }),
  ])) as [repo.PairRow[], NotifyResult];
  // A concurrent invite that won: the upsert's WHERE left the live pair alone.
  if (rows.length === 0) throw conflict("You're already buddies, or an invite is waiting");
  dispatchNotified(ctx, note);
  return pairView(
    ctx,
    { id, status: "pending", requested_by: uid, started_at: null },
    me,
    personRow(target, theirStats[0]),
    stats.find((r) => r.user_id === uid),
    stats.find((r) => r.user_id === target.userId),
  );
}

export async function acceptBuddy(ctx: Ctx, authed: AuthedBatch, pairId: string) {
  const uid = authed.userId;
  // The other person is a subquery on the pair, so everything is read in one round trip.
  const other = repo.otherInPair(pairId, uid);
  const [user, meRows, pairs, themRows, blocks, stats, theirStats] = await authed.read(
    repo.profileOf(ctx.db, uid),
    repo.pairById(ctx.db, pairId),
    repo.profileWhere(ctx.db, other),
    repo.blocksBetween(ctx.db, uid, other),
    repo.statsRows(ctx.db, inList([uid, other])),
    repo.statsOf(ctx.db, other),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const pair = pairs[0];
  if (pair === undefined || (pair.userA !== uid && pair.userB !== uid)) throw notFound("Not found");
  if (pair.status !== "pending" || pair.requestedBy === uid) throw conflict("There's nothing to accept");
  const otherId = pair.userA === uid ? pair.userB : pair.userA;
  const them = themRows[0];
  if (them === undefined || !socialAllowed(them, utcYear(ctx)) || blocks.length > 0)
    throw conflict("This invite is no longer available");
  const now = ctx.clock.now();
  const [, note] = await authed.write(
    repo.activatePair(ctx.db, pair.id, now),
    notify(ctx, {
      userId: otherId,
      kind: "buddy_accepted",
      category: "social",
      title: `@${me.handle} is your streak buddy now`,
      body: "This week is your first together.",
      url: "/buddies",
      actorId: uid,
    }),
  );
  dispatchNotified(ctx, note);
  const byUser = new Map(stats.map((s) => [s.user_id, s]));
  return pairView(
    ctx,
    { id: pair.id, status: "active", requested_by: pair.requestedBy, started_at: now },
    me,
    personRow(them, theirStats[0]),
    byUser.get(uid),
    byUser.get(otherId),
  );
}

/** Decline, withdraw or end: one write, no notification. */
export async function endBuddy(ctx: Ctx, authed: AuthedBatch, pairId: string) {
  const [first, ...more] = repo.endPair(ctx.db, authed.userId, pairId, ctx.clock.now());
  if (first === undefined) return;
  const res = await authed.write(first, ...more);
  if (((res[1] ?? []) as unknown[]).length === 0) throw notFound("Not found");
}

export const presets = () => [...PRESETS].map(([id, text]) => ({ id, text }));

/** POST /people/{handle}/encourage: a preset, at most once a day per sender and recipient. */
export async function encourage(ctx: Ctx, authed: AuthedBatch, handle: string, preset: string) {
  const uid = authed.userId;
  const them = repo.idByHandle(handle);
  const [user, meRows, targetRows, blocks, may] = await authed.read(
    repo.profileOf(ctx.db, uid),
    repo.profileByHandle(ctx.db, handle),
    repo.blocksBetween(ctx.db, uid, them),
    repo.mayEncourage(ctx.db, uid, them),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const text = PRESETS.get(preset);
  if (text === undefined) throw new HttpError(422, "Pick one of the messages");
  const target = targetRows[0];
  if (target === undefined) throw notFound(NO_SUCH_PERSON);
  if (target.userId === uid || !socialAllowed(target, utcYear(ctx)) || blocks.length > 0 || !may[0]?.ok)
    throw forbidden("You can encourage people who follow you, your buddies and your groups.");
  const now = ctx.clock.now();
  const [note] = (await limitedWrite(ctx, authed, BUCKETS.encourage, uid, [
    notify(ctx, {
      userId: target.userId,
      kind: "encouragement",
      category: "social",
      title: `@${me.handle}: ${text}`,
      body: null,
      url: `/u/${me.handle}`,
      actorId: uid,
      dedupeKey: `encourage:${uid}:${new Date(now).toISOString().slice(0, 10)}`,
    }),
  ])) as [NotifyResult];
  return { sent: dispatchNotified(ctx, note).length > 0 };
}

/** The feed cursor schema, public for the group feed. */
export { feedCursor } from "./schemas.ts";
