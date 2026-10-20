/**
 * Groups (crews and coaching rosters), challenges and announcements (spec/social.md §4). The only file another
 * module may import (JOBS-12 calls `resolveFinished`).
 *
 * Joining a group is consent to share, with its members only, your handle, your streak and your week's progress.
 * A coach sees sessions only for members who switched on `shares_with_coach` for that group.
 *
 * Cost: reads are one round trip (a challenge board reads every participant's rows in one statement per table);
 * writes are a read and a write. Coach views add one batched snapshot round trip per `SNAPSHOT_CHUNK` members.
 */
import { PLAN_TEMPLATE_BY_ID } from "../../catalog/plan-templates.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, runBatch, type Stmt } from "../../db/batch.ts";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors.ts";
import { BUCKETS } from "../../lib/ratelimit.ts";
import { addDays, daysBetween, localDate, toWire, weekStart, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { jointStreak, type MainChain, mainChainsFor } from "../game/service.ts";
import { dispatchNotified, type NotifyResult, notify } from "../notifications/service.ts";
import {
  cleanText,
  codePoints,
  displayName,
  emitStatement,
  type FeedCursor,
  feedPage,
  groupFeed as groupFeedSql,
  inviteCode,
  limitedWrite,
  type PersonRow,
  person,
  personRow,
  requireSocial,
  utcYear,
} from "../social/service.ts";
import {
  MAX_PLANS,
  materialize,
  planView,
  runOnly,
  SharedPlan,
  type SharedPlanInput,
  shareable,
  templateShared,
  viewRange,
} from "../training/service.ts";
import * as repo from "./repo.ts";
import type { AssignInput, ChallengeInput, GroupInput, GroupPatchInput } from "./schemas.ts";

export const MAX_GROUPS = 20;
export const MAX_MEMBERS = 200;
export const MAX_CHALLENGE_DAYS = 92;
const PLAN_LIMIT = `${MAX_PLANS} plans is the limit. Delete an old one first.`;

type GroupRow = repo.GroupRow;
type MemberRow = repo.MemberRow;
type ChallengeRow = repo.ChallengeRow;

const MANAGERS = new Set(["owner", "admin"]);
const COACHES = new Set(["owner", "admin", "coach"]);

function groupOut(
  g: GroupRow,
  member: Pick<MemberRow, "role" | "sharesWithCoach" | "muted"> | null,
  count: number,
) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    kind: g.kind,
    avatar_hue: g.avatarHue,
    member_count: count,
    my_role: member?.role ?? null,
    shares_with_coach: member?.sharesWithCoach ?? false,
    muted: member?.muted ?? false,
    streak_threshold: g.streakThreshold,
    invite_code: member !== null && MANAGERS.has(member.role) ? g.inviteCode : null,
  };
}

/**
 * Python `_group_for_member`: 404 unless the group exists, is not hidden and I'm in it. Reads `extra` in the same
 * round trip.
 */
async function forMember<T extends readonly Stmt[]>(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  ...extra: T
) {
  const [user, groups, members, ...rest] = await authed.read(
    repo.groupById(ctx.db, groupId),
    repo.membership(ctx.db, groupId, authed.userId),
    ...extra,
  );
  const group = groups[0];
  const me = members[0];
  if (group === undefined || me === undefined || group.hiddenAt !== null) throw notFound("Not found");
  return { user, group, me, rest };
}

const todayIn = (ctx: Ctx, p: { timezone: string } | undefined) =>
  localDate(ctx.clock.now(), zone(p?.timezone));

// ---- groups ---------------------------------------------------------------------------------------------------

export async function myGroups(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.myGroups(ctx.db, authed.userId));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    avatar_hue: r.avatar_hue,
    member_count: r.n,
    my_role: r.role,
    shares_with_coach: r.shares_with_coach === 1,
    muted: r.muted === 1,
    streak_threshold: r.streak_threshold,
    invite_code: MANAGERS.has(r.role) ? r.invite_code : null,
  }));
}

export async function createGroup(ctx: Ctx, authed: AuthedBatch, body: GroupInput) {
  const uid = authed.userId;
  const [user, me, owned] = await authed.read(repoProfile(ctx, uid), repo.ownedCount(ctx.db, uid));
  requireSocial(ctx, user, me[0]);
  if ((owned[0]?.n ?? 0) >= MAX_GROUPS) throw conflict("Group limit reached");
  const now = ctx.clock.now();
  const group: GroupRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    name: body.name,
    nameFold: "",
    description: body.description ?? null,
    kind: body.kind as GroupRow["kind"],
    ownerId: uid,
    inviteCode: inviteCode(),
    avatarHue: body.avatar_hue ?? 200,
    hiddenAt: null,
    streakThreshold: 75,
  };
  const { nameFold: _, ...values } = group;
  const member = { role: "owner" as const, sharesWithCoach: false, muted: false };
  await limitedWrite(ctx, authed, BUCKETS.groupCreate, uid, [
    repo.insertGroup(ctx.db, values),
    repo.insertMember(ctx.db, {
      id: uuid7(now),
      groupId: group.id,
      userId: uid,
      ...member,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return groupOut(group, member, 1);
}

export async function joinGroup(ctx: Ctx, authed: AuthedBatch, code: string) {
  const uid = authed.userId;
  const key = code.trim().toLowerCase();
  const byCode = repo.groupIdByCode(key);
  const [user, meRows, found, existing, count] = await authed.read(
    repoProfile(ctx, uid),
    repo.groupByCode(ctx.db, key),
    repo.membership(ctx.db, byCode, uid),
    repo.memberCount(ctx.db, byCode),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const group = found[0];
  if (group === undefined || group.hiddenAt !== null) throw notFound("That code does not match a group");
  if (existing.length > 0) return { id: group.id };
  if ((count[0]?.n ?? 0) >= MAX_MEMBERS) throw conflict("That group is full");
  const now = ctx.clock.now();
  const [, note] = await limitedWrite(ctx, authed, BUCKETS.groupJoin, uid, [
    repo.insertMember(ctx.db, {
      id: uuid7(now),
      groupId: group.id,
      userId: uid,
      createdAt: now,
      updatedAt: now,
    }),
    notify(ctx, {
      userId: group.ownerId,
      kind: "group_join",
      category: "groups",
      title: `${displayName(me)} joined ${group.name}`,
      url: `/groups/${group.id}`,
      actorId: uid,
      data: { group_id: group.id },
      dedupeKey: `group_join:${group.id}:${uid}`,
    }),
  ]);
  dispatchNotified(ctx, note as NotifyResult);
  return { id: group.id };
}

/** The crew's shared streak, judged over every social member with stats, each from the week they joined. */
function groupStreak(ctx: Ctx, g: GroupRow, rows: Awaited<ReturnType<typeof repo.streakRows>>) {
  const now = ctx.clock.now();
  const histories = rows.map((r) => {
    const tz = zone(r.timezone);
    const since = weekStart(localDate(r.joined, tz), r.week_starts_on);
    const current = weekStart(localDate(now, tz), r.week_starts_on);
    const span = Math.floor(daysBetween(since, current) / 7) + 1;
    const weeks = JSON.parse(r.recent_weeks) as string[];
    return span > 0 ? weeks.slice(-span) : [];
  });
  const result = jointStreak(histories, g.streakThreshold / 100);
  const last = result.weeks[result.weeks.length - 1];
  return {
    current: result.current,
    longest: result.longest,
    threshold: g.streakThreshold,
    weeks: result.weeks.slice(-12).map((w) => w.status),
    this_week: last === undefined ? null : { kept: last.kept, counted: last.counted },
  };
}

export async function getGroup(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const year = utcYear(ctx);
  const { group, me, rest } = await forMember(
    ctx,
    authed,
    groupId,
    repo.membersView(ctx.db, authed.userId, groupId, year),
    repo.streakRows(ctx.db, groupId, year),
  );
  const [rows, streak] = rest;
  const coaching = group.kind === "coaching";
  const members = rows.map((m) =>
    person(m, true, {
      role: m.role,
      this_week_days: m.this_week_days ?? 0,
      this_week_target: m.this_week_target,
      consistency: m.consistency ?? 0,
      last_active: m.last_active,
      shares_with_coach: coaching ? m.shares_with_coach === 1 : null,
    }),
  );
  members.sort((a, b) => {
    const d = (b.current_streak ?? 0) - (a.current_streak ?? 0);
    if (d !== 0) return d;
    const ha = a.handle ?? "";
    const hb = b.handle ?? "";
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  return { ...groupOut(group, me, rows.length), members, streak: groupStreak(ctx, group, streak) };
}

export async function updateGroup(ctx: Ctx, authed: AuthedBatch, groupId: string, body: GroupPatchInput) {
  const { group, me } = await forMember(ctx, authed, groupId);
  if (!MANAGERS.has(me.role)) throw forbidden("Only the owner or an admin can edit");
  const patch: Parameters<typeof repo.patchGroup>[2] = {};
  if (body.name != null) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.avatar_hue != null) patch.avatarHue = body.avatar_hue;
  if (body.streak_threshold != null) patch.streakThreshold = body.streak_threshold;
  if (Object.keys(patch).length > 0)
    await authed.write(repo.patchGroup(ctx.db, group.id, { ...patch, updatedAt: ctx.clock.now() }));
  return { id: group.id };
}

export async function deleteGroup(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const { group, me } = await forMember(ctx, authed, groupId);
  if (me.role !== "owner") throw forbidden("Only the owner can delete a group");
  await authed.write(repo.deleteGroup(ctx.db, group.id));
}

export async function leaveGroup(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const { me } = await forMember(ctx, authed, groupId);
  if (me.role === "owner") throw conflict("Hand ownership to someone else, or delete the group");
  await authed.write(repo.deleteMember(ctx.db, groupId, authed.userId));
}

export async function rotateInvite(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const { group, me } = await forMember(ctx, authed, groupId);
  if (!MANAGERS.has(me.role)) throw forbidden("Only the owner or an admin can do that");
  const code = inviteCode();
  await authed.write(repo.patchGroup(ctx.db, group.id, { inviteCode: code, updatedAt: ctx.clock.now() }));
  return { invite_code: code };
}

export async function setRole(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  memberId: string,
  role: string,
) {
  const uid = authed.userId;
  const { group, me, rest } = await forMember(
    ctx,
    authed,
    groupId,
    repo.membership(ctx.db, groupId, memberId),
  );
  const target = rest[0][0];
  if (target === undefined) throw notFound("Not found");
  const now = ctx.clock.now();
  const r = role as MemberRow["role"];
  if (r === "owner") {
    if (me.role !== "owner") throw forbidden("Only the owner can hand over");
    // Handing over to yourself leaves you the owner: the second update wins, as in Python.
    await authed.write(
      repo.setRole(ctx.db, group.id, uid, "admin", now),
      repo.setRole(ctx.db, group.id, memberId, "owner", now),
      repo.patchGroup(ctx.db, group.id, { ownerId: memberId, updatedAt: now }),
    );
    return { role: "owner" };
  }
  const allowed =
    me.role === "owner" ||
    (me.role === "admin" &&
      (target.role === "coach" || target.role === "member") &&
      (r === "coach" || r === "member"));
  if (!allowed) throw forbidden("Not allowed");
  if (target.role === "owner") throw conflict("Hand over ownership instead");
  await authed.write(repo.setRole(ctx.db, group.id, memberId, r, now));
  return { role: r };
}

export async function removeMember(ctx: Ctx, authed: AuthedBatch, groupId: string, memberId: string) {
  const { me, rest } = await forMember(ctx, authed, groupId, repo.membership(ctx.db, groupId, memberId));
  const target = rest[0][0];
  if (target === undefined) throw notFound("Not found");
  if (target.role === "owner" || !MANAGERS.has(me.role) || (me.role === "admin" && target.role === "admin"))
    throw forbidden("Not allowed");
  await authed.write(repo.deleteMember(ctx.db, groupId, memberId));
}

/** PATCH /groups/{id}/me: coach consent and mute, one write. */
export async function patchMe(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  body: { shares_with_coach?: boolean | null | undefined; muted?: boolean | null | undefined },
) {
  const patch: { sharesWithCoach?: boolean; muted?: boolean } = {};
  if (body.shares_with_coach != null) patch.sharesWithCoach = body.shares_with_coach;
  if (body.muted != null) patch.muted = body.muted;
  const [rows] = await authed.write(repo.patchMe(ctx.db, groupId, authed.userId, patch, ctx.clock.now()));
  const row = rows[0];
  if (row === undefined) throw notFound("Not found");
  return { shares_with_coach: row.sharesWithCoach, muted: row.muted };
}

// ---- coaching -------------------------------------------------------------------------------------------------

/** Logged (date, discipline) pairs from the snapshot's day aggregates, for a plan view over every source. */
function loggedFrom(days: MainChain["days"], range: [string, string] | null) {
  if (range === null) return [];
  const out: { d: string; discipline: string }[] = [];
  for (const day of days) {
    const d = day.localDate;
    if (d < range[0] || d > range[1]) continue;
    for (const [discipline, n] of Object.entries(day.disciplines))
      for (let i = 0; i < n; i++) out.push({ d, discipline });
  }
  return out;
}

type Running = Awaited<ReturnType<typeof repo.runningPlansOf>>[number];

/** One coached member (Python `coach_view` row): streak, plan progress, the last 8 weeks and 10 sessions. */
function coachRow(
  coach: string,
  row: PersonRow,
  m: MainChain,
  plan: Running | undefined,
  recent: readonly repo.RecentWorkout[],
) {
  const main = m.main;
  let progress = null;
  if (plan !== undefined) {
    const wso = m.profile.weekStartsOn;
    const view = planView(plan, m.today, wso, loggedFrom(m.days, viewRange(plan, m.today, wso)));
    progress = {
      name: plan.name,
      week: (view.current_week ?? 0) + 1,
      weeks: view.weeks_count,
      done: view.progress?.done ?? 0,
      due: view.progress?.due ?? 0,
      from_this_coach: plan.assignedBy === coach,
    };
  }
  return person(row, false, {
    current_streak: main.current,
    this_week_days: main.thisWeekDays,
    this_week_target: main.thisWeekTarget,
    at_risk: main.atRisk,
    consistency: main.consistency,
    plan: progress,
    weeks: main.weeks
      .slice(-8)
      .map((c) => ({ week_start: c.weekStart, days: c.days, target: c.target, status: c.status })),
    recent: recent.map(({ user_id: _, ...w }) => w),
  });
}

/**
 * Coach rows for everyone who shares with `coach`: one batch of eight set-based statements however large the
 * group (`mainChainsFor`), so a 200-member group stays inside D1's 50 queries per invocation on Free.
 */
async function coachRows(ctx: Ctx, coach: string, sharers: readonly repo.SharerRow[]) {
  const ids = [...new Set(sharers.map((s) => s.p_id))];
  const rows = new Map<string, ReturnType<typeof coachRow>>();
  if (ids.length === 0) return rows;
  const got = await mainChainsFor(ctx, ids, [
    repo.runningPlansOf(ctx.db, ids),
    repo.recentWorkoutsOf(ctx.db, ids),
  ]);
  const plans = new Map<string, Running>();
  for (const p of got.extra[0] as Running[]) if (!plans.has(p.userId)) plans.set(p.userId, p);
  const recent = new Map<string, repo.RecentWorkout[]>();
  for (const w of got.extra[1] as repo.RecentWorkout[]) {
    const list = recent.get(w.user_id);
    if (list === undefined) recent.set(w.user_id, [w]);
    else list.push(w);
  }
  for (const s of sharers) {
    if (rows.has(s.p_id)) continue;
    const m = got.chains.get(s.p_id);
    if (m === undefined) continue;
    rows.set(s.p_id, coachRow(coach, s, m, plans.get(s.p_id), recent.get(s.p_id) ?? []));
  }
  return rows;
}

/** GET /groups/{id}/coach: members who share their training with their coach. Two round trips, ~12 statements. */
export async function coachView(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const { group, me, rest } = await forMember(
    ctx,
    authed,
    groupId,
    repo.sharers(ctx.db, authed.userId, groupId),
  );
  if (group.kind !== "coaching" || !COACHES.has(me.role)) throw forbidden("Coaches only");
  const rows = await coachRows(ctx, authed.userId, rest[0]);
  return { members: rest[0].flatMap((s) => rows.get(s.p_id) ?? []) };
}

/**
 * GET /coaching: everyone who shares with me across my coaching groups, quietest first: two round trips however
 * many groups. Hidden groups are left out (Python 404ed the whole overview when one was hidden).
 */
export async function coaching(ctx: Ctx, authed: AuthedBatch) {
  const uid = authed.userId;
  const [, groups, sharers, me] = await authed.read(
    repo.coachingGroups(ctx.db, uid),
    repo.sharers(ctx.db, uid, null),
    repoProfile(ctx, uid),
  );
  const rows = await coachRows(ctx, uid, sharers);
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const people = new Map<string, Record<string, unknown> & { groups: { id: string; name: string }[] }>();
  for (const g of groups)
    for (const s of sharers) {
      if (s.group_id !== g.id) continue;
      const row = rows.get(s.p_id);
      if (row === undefined) continue;
      const key = s.p_handle || s.p_id;
      let entry = people.get(key);
      if (entry === undefined) {
        entry = { ...row, groups: [] };
        people.set(key, entry);
      }
      entry.groups.push({ id: g.id, name: names.get(g.id) ?? "" });
    }
  const today = todayIn(ctx, me[0]);
  const out = [...people.values()].map((e) => {
    const recent = (e.recent ?? []) as { date: string }[];
    const last = recent.reduce<string | null>((m, r) => (m === null || r.date > m ? r.date : m), null);
    const quiet = last === null ? null : daysBetween(last, today);
    return Object.assign(e, {
      last_session: last,
      attention: Boolean(e.at_risk) || quiet === null || quiet >= 7,
    });
  });
  out.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    const la = a.last_session ?? "";
    const lb = b.last_session ?? "";
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return { groups: groups.map((g) => ({ id: g.id, name: g.name })), people: out };
}

export async function groupFeed(ctx: Ctx, authed: AuthedBatch, groupId: string, before: FeedCursor | null) {
  const { rest } = await forMember(
    ctx,
    authed,
    groupId,
    groupFeedSql(ctx.db, authed.userId, groupId, before, utcYear(ctx)),
  );
  return feedPage(rest[0], authed.userId);
}

// ---- challenges -----------------------------------------------------------------------------------------------

function challengeStatus(c: Pick<ChallengeRow, "resolvedAt" | "startsOn" | "endsOn">, today: string) {
  if (c.resolvedAt !== null || today > c.endsOn) return "finished";
  return today < c.startsOn ? "upcoming" : "live";
}

function challengeOut(
  c: ChallengeRow,
  today: string,
  joined: boolean,
  creator: boolean,
  count: number | null,
) {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    kind: c.kind,
    target: c.target,
    disciplines: c.disciplines,
    starts_on: c.startsOn,
    ends_on: c.endsOn,
    group_id: c.groupId,
    plan_name: c.kind === "plan_sessions" ? ((c.plan?.name as string | undefined) ?? null) : null,
    status: challengeStatus(c, today),
    joined,
    is_creator: creator,
    invite_code: (creator || joined) && c.groupId === null ? c.inviteCode : null,
    participants: count,
  };
}

export async function listChallenges(ctx: Ctx, authed: AuthedBatch) {
  const uid = authed.userId;
  // Local dates are within a day of UTC: read from a day earlier, then trim to the caller's own date.
  const utc = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const [, me, rows] = await authed.read(
    repoProfile(ctx, uid),
    repo.listChallenges(ctx.db, uid, addDays(utc, -61)),
  );
  const today = todayIn(ctx, me[0]);
  const since = addDays(today, -60);
  return rows
    .filter((r) => r.ends_on >= since)
    .map((r) =>
      challengeOut(
        {
          id: r.id,
          title: r.title,
          description: r.description,
          kind: r.kind as ChallengeRow["kind"],
          target: r.target,
          disciplines: JSON.parse(r.disciplines) as string[],
          startsOn: r.starts_on,
          endsOn: r.ends_on,
          groupId: r.group_id,
          plan: r.plan === null ? null : (JSON.parse(r.plan) as Record<string, unknown>),
          creatorId: r.creator_id,
          inviteCode: r.invite_code,
          resolvedAt: r.resolved_at,
          hiddenAt: null,
          createdAt: 0,
          updatedAt: 0,
        },
        today,
        r.joined === 1,
        r.creator_id === uid,
        r.n,
      ),
    );
}

/** The shareable plan a challenge or an assignment uses: a template, or one of my own plans. */
function sharedFrom(
  templateId: string | null | undefined,
  planId: string | null | undefined,
  source: Awaited<ReturnType<typeof repo.planById>>,
  owned: Awaited<ReturnType<typeof repo.ownRoutines>>,
  uid: string,
  none: string,
): SharedPlanInput {
  if (templateId) {
    const t = PLAN_TEMPLATE_BY_ID.get(templateId);
    if (t === undefined) throw notFound("No such template");
    return templateShared(t);
  }
  if (planId) {
    const plan = source[0];
    if (plan === undefined || plan.userId !== uid) throw notFound("No such plan");
    return SharedPlan.parse(shareable(plan, owned));
  }
  throw new HttpError(422, none);
}

type PlanReads = {
  copy: Awaited<ReturnType<typeof repo.myPlanCopy>>;
  plans: Awaited<ReturnType<typeof repo.planCount>>;
  names: Awaited<ReturnType<typeof repo.routineNames>>;
};

/**
 * Python `_join_plan`: the participant's own copy of the challenge plan (reused on a rejoin, else created when
 * they have room), run from the challenge's first week in their own week.
 */
function joinPlanStatements(ctx: Ctx, c: ChallengeRow, userId: string, wso: number, r: PlanReads): Stmt[] {
  if (c.kind !== "plan_sessions" || !c.plan) return [];
  const stmts: Stmt[] = [];
  let plan = r.copy[0];
  if (plan === undefined) {
    if ((r.plans[0]?.n ?? 0) >= MAX_PLANS) throw conflict(PLAN_LIMIT);
    const made = materialize(ctx, userId, SharedPlan.parse(c.plan), r.names, { challengeId: c.id });
    plan = made.plan;
    stmts.push(...made.stmts);
  }
  stmts.push(...runOnly(ctx, plan, weekStart(c.startsOn, wso)));
  return stmts;
}

export async function createChallenge(ctx: Ctx, authed: AuthedBatch, body: ChallengeInput) {
  const uid = authed.userId;
  const [user, meRows, member, source, owned, count, names] = await authed.read(
    repoProfile(ctx, uid),
    repo.membership(ctx.db, body.group_id ?? "", uid),
    repo.planById(ctx.db, body.plan_id ?? ""),
    repo.ownRoutines(ctx.db, body.plan_id ? uid : ""),
    repo.planCount(ctx.db, uid),
    repo.routineNames(ctx.db, uid),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const today = todayIn(ctx, me);
  if (body.ends_on < body.starts_on) throw new HttpError(422, "It ends before it starts");
  if (daysBetween(body.starts_on, body.ends_on) + 1 > MAX_CHALLENGE_DAYS)
    throw new HttpError(422, "Challenges last up to 92 days");
  if (body.starts_on < addDays(today, -1)) throw new HttpError(422, "Challenges cannot start in the past");
  if (body.group_id && member.length === 0) throw notFound("Not found");
  let endsOn = body.ends_on;
  let target = body.target ?? null;
  let plan: Record<string, unknown> | null = null;
  if (body.kind === "plan_sessions") {
    const shared = sharedFrom(
      body.plan_template_id,
      body.plan_id,
      source,
      owned,
      uid,
      "Choose the plan everyone will follow",
    );
    // The window is the plan: whole weeks from the first day.
    endsOn = addDays(body.starts_on, 7 * shared.weeks.length - 1);
    if (daysBetween(body.starts_on, endsOn) + 1 > MAX_CHALLENGE_DAYS)
      throw new HttpError(422, "Plan challenges last up to 13 weeks");
    plan = shared as unknown as Record<string, unknown>;
    target = target || shared.weeks.reduce((n, w) => n + w.length, 0);
  }
  const now = ctx.clock.now();
  const c: ChallengeRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    title: body.title,
    description: body.description ?? null,
    kind: body.kind as ChallengeRow["kind"],
    target,
    disciplines: body.disciplines,
    startsOn: body.starts_on,
    endsOn,
    creatorId: uid,
    groupId: body.group_id ?? null,
    inviteCode: inviteCode(),
    resolvedAt: null,
    hiddenAt: null,
    plan,
  };
  await limitedWrite(ctx, authed, BUCKETS.challengeCreate, uid, [
    repo.insertChallenge(ctx.db, c),
    repo.insertParticipant(ctx.db, {
      id: uuid7(now),
      challengeId: c.id,
      userId: uid,
      createdAt: now,
      updatedAt: now,
    }),
    ...joinPlanStatements(ctx, c, uid, me.weekStartsOn, { copy: [], plans: count, names }),
  ]);
  return challengeOut(c, today, true, true, 1);
}

/** GET /challenges/code/{code}: lowercased, not stripped (Python); works for resolved and group challenges. */
export async function previewChallenge(ctx: Ctx, authed: AuthedBatch, code: string) {
  const [user, meRows, rows] = await authed.read(
    repoProfile(ctx, authed.userId),
    repo.challengeByCode(ctx.db, code.toLowerCase()),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const c = rows[0];
  if (c === undefined || c.hiddenAt !== null) throw notFound("That code does not match a challenge");
  return challengeOut(c, todayIn(ctx, me), false, c.creatorId === authed.userId, null);
}

interface ScoreInputs {
  board: Awaited<ReturnType<typeof repo.board>>;
  active: Awaited<ReturnType<typeof repo.activeDays>>;
  copies: Awaited<ReturnType<typeof repo.planCopies>>;
  logged: Awaited<ReturnType<typeof repo.planLogged>>;
}

const scoreReads = (ctx: Ctx, challengeId: string) =>
  [
    repo.board(ctx.db, challengeId),
    repo.activeDays(ctx.db, challengeId),
    repo.planCopies(ctx.db, challengeId),
    repo.planLogged(ctx.db, challengeId),
  ] as const;

/**
 * weekly_target: kept weeks of the main chain from the challenge's first week to its last, read from the stored
 * projection (`user_stats.recent_weeks`, the last 26 week verdicts ending at `computed_for`'s week). Stats are
 * recomputed on every write, so a week after `computed_for` had nothing logged and cannot be kept.
 */
function keptWeeks(r: repo.BoardRow, c: ChallengeRow): number {
  if (r.recent_weeks === null || r.computed_for === null) return 0;
  const weeks = JSON.parse(r.recent_weeks) as string[];
  const last = weekStart(r.computed_for, r.week_starts_on);
  const first = weekStart(c.startsOn, r.week_starts_on);
  let n = 0;
  weeks.forEach((status, i) => {
    const ws = addDays(last, -7 * (weeks.length - 1 - i));
    if (status === "kept" && ws >= first && ws <= c.endsOn) n++;
  });
  return n;
}

/** Python `_scores`: live scores (frozen ones once resolved), competition ranking 1, 1, 3. */
function scores(ctx: Ctx, c: ChallengeRow, today: string, inp: ScoreInputs) {
  const end = c.endsOn < today ? c.endsOn : today;
  const days = new Map<string, number>();
  for (const a of inp.active) if (a.d <= end) days.set(a.user_id, (days.get(a.user_id) ?? 0) + 1);
  const copies = new Map<string, (typeof inp.copies)[number]>();
  for (const p of inp.copies) if (!copies.has(p.userId)) copies.set(p.userId, p);
  const logged = new Map<string, { d: string; discipline: string }[]>();
  for (const l of inp.logged) {
    const list = logged.get(l.user_id) ?? [];
    list.push({ d: l.d, discipline: l.discipline });
    logged.set(l.user_id, list);
  }
  const rows = inp.board.map((r) => {
    let score: number;
    if (c.resolvedAt !== null && r.final_score !== null) score = r.final_score;
    else if (today < c.startsOn) score = 0;
    else if (c.kind === "active_days") score = days.get(r.user_id) ?? 0;
    else if (c.kind === "plan_sessions") {
      const plan = copies.get(r.user_id);
      if (plan === undefined || plan.startedOn === null) score = 0;
      else {
        const own = localDate(ctx.clock.now(), zone(r.timezone));
        score = planView(plan, own, r.week_starts_on, logged.get(r.user_id) ?? []).progress?.done ?? 0;
      }
    } else score = keptWeeks(r, c);
    return { r, score };
  });
  rows.sort((a, b) => b.score - a.score);
  let rank = 0;
  let last: number | null = null;
  return rows.map(({ r, score }, i) => {
    if (score !== last) {
      rank = i + 1;
      last = score;
    }
    return {
      ...person(r, true),
      score,
      rank: r.final_rank || rank,
      completed: r.completed === 1 || Boolean(c.target && score >= c.target),
    };
  });
}

/** Python `_visible_challenge` from rows already read: not hidden, and I joined (even if I left) or I'm in its group. */
function visibleChallenge(
  rows: readonly ChallengeRow[],
  part: readonly unknown[],
  member: readonly { ok: number }[],
) {
  const c = rows[0];
  if (c === undefined || c.hiddenAt !== null) throw notFound("Not found");
  if (part.length === 0 && !(c.groupId !== null && member[0]?.ok)) throw notFound("Not found");
  return c;
}

/** GET /challenges/{id}: the challenge and its leaderboard, one round trip. */
export async function getChallenge(ctx: Ctx, authed: AuthedBatch, challengeId: string) {
  const uid = authed.userId;
  const [, rows, part, member, meRows, board, active, copies, logged] = await authed.read(
    repo.challengeById(ctx.db, challengeId),
    repo.participant(ctx.db, challengeId, uid),
    repo.challengeGroupMember(ctx.db, challengeId, uid),
    repoProfile(ctx, uid),
    ...scoreReads(ctx, challengeId),
  );
  const c = visibleChallenge(rows, part, member);
  const today = todayIn(ctx, meRows[0]);
  const ranked = scores(ctx, c, today, { board, active, copies, logged });
  const total = daysBetween(c.startsOn, c.endsOn) + 1;
  return {
    ...challengeOut(
      c,
      today,
      ranked.some((r) => r.id === uid),
      c.creatorId === uid,
      ranked.length,
    ),
    leaderboard: ranked,
    days_total: total,
    days_elapsed: Math.max(0, Math.min(daysBetween(c.startsOn, today) + 1, total)),
  };
}

/** What joining needs, read with the challenge (by id or by code subquery). */
const joinReads = (ctx: Ctx, uid: string, key: string | ReturnType<typeof repo.challengeIdByCode>) =>
  [
    repo.participant(ctx.db, key, uid),
    repo.participantCount(ctx.db, key),
    repo.myPlanCopy(ctx.db, uid, key),
    repo.planCount(ctx.db, uid),
    repo.routineNames(ctx.db, uid),
  ] as const;

type JoinRows = {
  part: Awaited<ReturnType<typeof repo.participant>>;
  count: Awaited<ReturnType<typeof repo.participantCount>>;
} & PlanReads;

/** Python `_join`: a new participant (200 at most, leavers counted) or a rejoin, then the plan copy. One write. */
async function join(
  ctx: Ctx,
  authed: AuthedBatch,
  c: ChallengeRow,
  me: { weekStartsOn: number },
  r: JoinRows,
) {
  const uid = authed.userId;
  const now = ctx.clock.now();
  const stmts: Stmt[] = [];
  const existing = r.part[0];
  if (existing === undefined) {
    if ((r.count[0]?.n ?? 0) >= MAX_MEMBERS) throw conflict("That challenge is full");
    stmts.push(
      repo.insertParticipant(ctx.db, {
        id: uuid7(now),
        challengeId: c.id,
        userId: uid,
        createdAt: now,
        updatedAt: now,
      }),
    );
  } else stmts.push(repo.rejoin(ctx.db, existing.id, now));
  stmts.push(...joinPlanStatements(ctx, c, uid, me.weekStartsOn, r));
  await authed.write(...(stmts as [Stmt, ...Stmt[]]));
  return { id: c.id };
}

export async function joinByCode(ctx: Ctx, authed: AuthedBatch, code: string) {
  const uid = authed.userId;
  const key = code.trim().toLowerCase();
  const [user, meRows, rows, part, count, copy, plans, names] = await authed.read(
    repoProfile(ctx, uid),
    repo.challengeByCode(ctx.db, key),
    ...joinReads(ctx, uid, repo.challengeIdByCode(key)),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const c = rows[0];
  if (c === undefined || c.hiddenAt !== null || c.resolvedAt !== null)
    throw notFound("That code does not match an open challenge");
  return join(ctx, authed, c, me, { part, count, copy, plans, names });
}

export async function joinChallenge(ctx: Ctx, authed: AuthedBatch, challengeId: string) {
  const uid = authed.userId;
  const [user, meRows, rows, member, part, count, copy, plans, names] = await authed.read(
    repoProfile(ctx, uid),
    repo.challengeById(ctx.db, challengeId),
    repo.challengeGroupMember(ctx.db, challengeId, uid),
    ...joinReads(ctx, uid, challengeId),
  );
  const me = requireSocial(ctx, user, meRows[0]);
  const c = visibleChallenge(rows, part, member);
  if (c.resolvedAt !== null) throw conflict("That challenge has finished");
  return join(ctx, authed, c, me, { part, count, copy, plans, names });
}

/** Leaving stops (but keeps) the plan copy. One write; a no-op when I never joined. */
export async function leaveChallenge(ctx: Ctx, authed: AuthedBatch, challengeId: string) {
  await authed.write(...repo.leaveStatements(ctx.db, challengeId, authed.userId, ctx.clock.now()));
}

export async function deleteChallenge(ctx: Ctx, authed: AuthedBatch, challengeId: string) {
  const [gone] = await authed.write(repo.deleteChallenge(ctx.db, challengeId, authed.userId));
  if (gone.length === 0) throw notFound("Not found");
}

const UNITS: Record<string, string> = {
  active_days: "active days",
  weekly_target: "weeks kept",
  plan_sessions: "plan sessions done",
};

/**
 * Freezes results for challenges that ended before yesterday (UTC), for the worker (JOBS-12). Per challenge: one
 * read (board and scores), one write (final scores, notices, feed events, resolved). Returns the notification ids
 * it queued for delivery. Idempotent: resolved challenges are skipped, and the notices are deduplicated.
 */
export async function resolveFinished(ctx: Ctx, todayUtc: string): Promise<string[]> {
  const [due] = await runBatch(ctx.db, [repo.dueChallenges(ctx.db, addDays(todayUtc, -1))] as const);
  const ids: string[] = [];
  for (const c of due) {
    const [board, active, copies, logged, profiles] = await runBatch(ctx.db, [
      ...scoreReads(ctx, c.id),
      repo.participantProfiles(ctx.db, c.id),
    ] as const);
    const byUser = new Map(profiles.map((p) => [p.userId, p]));
    const now = ctx.clock.now();
    const stmts: Stmt[] = [];
    const notes: number[] = [];
    for (const row of scores(ctx, c, c.endsOn, { board, active, copies, logged })) {
      const completed = c.target ? row.score >= c.target : row.score > 0;
      stmts.push(
        repo.freezeParticipant(
          ctx.db,
          c.id,
          row.id,
          { finalScore: row.score, finalRank: row.rank, completed },
          now,
        ),
      );
      notes.push(stmts.length);
      stmts.push(
        notify(ctx, {
          userId: row.id,
          kind: "challenge_finished",
          category: "groups",
          title: `${c.title} is over - you placed #${row.rank}`,
          body: `${row.score} ${UNITS[c.kind] ?? ""}.`,
          url: `/challenges/${c.id}`,
          data: c.groupId === null ? null : { group_id: c.groupId },
          dedupeKey: `challenge_done:${c.id}`,
        }),
      );
      const p = byUser.get(row.id);
      const event =
        completed && p !== undefined
          ? emitStatement(ctx, p, {
              kind: "challenge",
              refKey: `challenge:${c.id}`,
              day: c.endsOn,
              data: { title: c.title, rank: row.rank, score: row.score, kind: c.kind },
            })
          : null;
      if (event !== null) stmts.push(event);
    }
    stmts.push(repo.markResolved(ctx.db, c.id, now));
    const res = (await runBatch(ctx.db, stmts)) as unknown[];
    ids.push(...dispatchNotified(ctx, ...notes.map((i) => (res[i] ?? []) as NotifyResult)));
  }
  return ids;
}

// ---- coaching: suggest a plan ---------------------------------------------------------------------------------

/**
 * POST /groups/{id}/members/{member}/plan: a coach suggests a plan to a member who shares with them. It lands in
 * the member's plans, not started.
 */
export async function assignPlan(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  memberId: string,
  body: AssignInput,
) {
  const uid = authed.userId;
  const { group, me, rest } = await forMember(
    ctx,
    authed,
    groupId,
    repo.membership(ctx.db, groupId, memberId),
    repoProfile(ctx, uid),
    repo.planById(ctx.db, body.plan_id ?? ""),
    repo.ownRoutines(ctx.db, body.plan_id ? uid : ""),
    repo.planCount(ctx.db, memberId),
    repo.routineNames(ctx.db, memberId),
  );
  if (group.kind !== "coaching" || !COACHES.has(me.role)) throw forbidden("Coaches only");
  const [target, coachRows, source, owned, count, names] = rest;
  const member = target[0];
  if (member === undefined || !member.sharesWithCoach || memberId === uid)
    throw forbidden("Only members who share their training with you");
  const shared = sharedFrom(
    body.plan_template_id,
    body.plan_id,
    source,
    owned,
    uid,
    "Choose a plan to suggest",
  );
  if ((count[0]?.n ?? 0) >= MAX_PLANS) throw conflict(PLAN_LIMIT);
  const { plan, stmts } = materialize(ctx, memberId, shared, names, { assignedBy: uid });
  // Python crashed (500) on a missing note: clean_text(None). No note means the default text.
  const note = body.note ? cleanText(body.note) : "";
  const res = await limitedWrite(ctx, authed, BUCKETS.assignPlan, uid, [
    ...stmts,
    notify(ctx, {
      userId: memberId,
      kind: "plan_assigned",
      category: "groups",
      title: `@${coachRows[0]?.handle ?? null} suggested a plan: ${plan.name}`,
      body: note || "It's in your plans. Start it when you're ready, or not at all.",
      url: `/plans/${plan.id}`,
      actorId: uid,
      data: { group_id: group.id },
    }),
  ]);
  dispatchNotified(ctx, res[res.length - 1] as NotifyResult);
  return { id: plan.id };
}

// ---- announcements --------------------------------------------------------------------------------------------

export async function listAnnouncements(ctx: Ctx, authed: AuthedBatch, groupId: string) {
  const { rest } = await forMember(ctx, authed, groupId, repo.listAnnouncements(ctx.db, groupId));
  return rest[0].map((a) => ({
    id: a.id,
    body: a.body,
    pinned: a.pinned === 1,
    created_at: toWire(a.created_at),
    author: a.p_id === null ? null : person(a),
  }));
}

/** Owners and admins only, so members never message each other through the group. 5 a day per group. */
export async function postAnnouncement(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  body: { body: string; pinned: boolean },
) {
  const uid = authed.userId;
  const { group, me, rest } = await forMember(
    ctx,
    authed,
    groupId,
    repo.otherMembers(ctx.db, groupId, uid),
    repoProfile(ctx, uid),
  );
  if (!MANAGERS.has(me.role)) throw forbidden("Only the owner or an admin can post");
  const text = cleanText(body.body);
  if (!text) throw new HttpError(422, "Say something");
  const [others, authorRows] = rest;
  const now = ctx.clock.now();
  const id = uuid7(now);
  const stmts: Stmt[] = [];
  if (body.pinned) stmts.push(repo.unpinAll(ctx.db, group.id, now));
  stmts.push(
    repo.insertAnnouncement(ctx.db, {
      id,
      groupId: group.id,
      authorId: uid,
      body: text,
      pinned: body.pinned,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const first = stmts.length;
  for (const m of others)
    stmts.push(
      notify(ctx, {
        userId: m.userId,
        kind: "group_announcement",
        category: "groups",
        title: `${group.name}: ${codePoints(text, 80)}`,
        body: Array.from(text).length > 80 ? text : null,
        url: `/groups/${group.id}`,
        actorId: uid,
        data: { group_id: group.id },
        dedupeKey: `announce:${id}`,
      }),
    );
  const res = await limitedWrite(ctx, authed, BUCKETS.announce, group.id, stmts);
  dispatchNotified(ctx, ...(res.slice(first) as NotifyResult[]));
  const author = authorRows[0];
  return {
    id,
    body: text,
    pinned: body.pinned,
    created_at: toWire(now),
    author: author === undefined ? null : person(personRow(author)),
  };
}

export async function deleteAnnouncement(
  ctx: Ctx,
  authed: AuthedBatch,
  groupId: string,
  announcementId: string,
) {
  const { group, me } = await forMember(ctx, authed, groupId);
  if (!MANAGERS.has(me.role)) throw forbidden("Only the owner or an admin can remove it");
  const [gone] = await authed.write(repo.deleteAnnouncement(ctx.db, group.id, announcementId));
  if (gone.length === 0) throw notFound("Not found");
}

// ---- helpers --------------------------------------------------------------------------------------------------

const repoProfile = (ctx: Ctx, userId: string) => repo.profileOf(ctx.db, userId);
