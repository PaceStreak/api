/**
 * Query builders for groups, coaching, challenges and announcements (spec/social.md §4). Every function returns an
 * un-awaited statement. Leaderboards read every participant's rows in one statement each (never one query per
 * participant), and challenge scores come from workouts and user_stats, never from a habit table.
 */
import { and, asc, eq, ne, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { withFold, withFoldPatch } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  challengeParticipants,
  challenges,
  groupAnnouncements,
  groupMembers,
  groups,
  profiles,
  routines,
  trainingPlans,
} from "../../db/schema/index.ts";
import { notBlocked, type PersonRow, personCols, socialOk } from "../social/service.ts";

export type GroupRow = typeof groups.$inferSelect;
export type MemberRow = typeof groupMembers.$inferSelect;
export type ChallengeRow = typeof challenges.$inferSelect;
export type ParticipantRow = typeof challengeParticipants.$inferSelect;

// ---- groups ---------------------------------------------------------------------------------------------------

export const groupById = (db: Db, id: string) => db.select().from(groups).where(eq(groups.id, id));

/** A key that is an id, or a subquery resolving one (an invite code's group or challenge). */
type Key = string | SQL;

export const profileOf = (db: Db, userId: string) =>
  db.select().from(profiles).where(eq(profiles.userId, userId));

/** The id of the group or challenge with this invite code, as a subquery. */
export const groupIdByCode = (code: string): SQL => sql`(SELECT id FROM groups WHERE invite_code = ${code})`;
export const challengeIdByCode = (code: string): SQL =>
  sql`(SELECT id FROM challenges WHERE invite_code = ${code})`;

export const membership = (db: Db, groupId: Key, userId: string) =>
  db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

/** My visible groups with my membership and the full member count, by name. */
export const myGroups = (db: Db, me: string) =>
  db.all<{
    id: string;
    name: string;
    description: string | null;
    kind: string;
    avatar_hue: number;
    streak_threshold: number;
    invite_code: string;
    role: string;
    shares_with_coach: number;
    muted: number;
    n: number;
  }>(
    sql`SELECT g.id, g.name, g.description, g.kind, g.avatar_hue, g.streak_threshold, g.invite_code,
        gm.role, gm.shares_with_coach, gm.muted,
        (SELECT count(*) FROM group_members c WHERE c.group_id = g.id) AS n
      FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ${me} AND g.hidden_at IS NULL
      ORDER BY g.name_fold, g.name`,
  );

/** Groups owned, hidden ones included (Python counts them toward the limit). */
export const ownedCount = (db: Db, me: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM groups WHERE owner_id = ${me}`);

export const groupByCode = (db: Db, code: string) =>
  db.select().from(groups).where(eq(groups.inviteCode, code));

export const memberCount = (db: Db, groupId: Key) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM group_members WHERE group_id = ${groupId}`);

export const insertGroup = (db: Db, v: Omit<typeof groups.$inferInsert, "nameFold">) =>
  db.insert(groups).values(withFold(groups, v));

export const insertMember = (db: Db, v: typeof groupMembers.$inferInsert) =>
  db.insert(groupMembers).values(v);

export const patchGroup = (
  db: Db,
  id: string,
  patch: Partial<Omit<typeof groups.$inferInsert, "nameFold">>,
) => db.update(groups).set(withFoldPatch(groups, patch)).where(eq(groups.id, id));

export const deleteGroup = (db: Db, id: string) => db.delete(groups).where(eq(groups.id, id));

export const deleteMember = (db: Db, groupId: string, userId: string) =>
  db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

export const setRole = (db: Db, groupId: string, userId: string, role: MemberRow["role"], now: number) =>
  db
    .update(groupMembers)
    .set({ role, updatedAt: now })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

/** My own settings in a visible group I belong to; `[]` means 404. */
export const patchMe = (
  db: Db,
  groupId: string,
  me: string,
  patch: { sharesWithCoach?: boolean; muted?: boolean },
  now: number,
) =>
  db
    .update(groupMembers)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, me),
        sql`EXISTS (SELECT 1 FROM groups g WHERE g.id = ${groupId} AND g.hidden_at IS NULL)`,
      ),
    )
    .returning({ sharesWithCoach: groupMembers.sharesWithCoach, muted: groupMembers.muted });

export type MemberViewRow = PersonRow & {
  role: string;
  shares_with_coach: number;
  this_week_days: number | null;
  this_week_target: number | null;
  consistency: number | null;
  last_active: string | null;
};

/** The members the viewer may see (social, not blocked), with their stats. */
export const membersView = (db: Db, viewer: string, groupId: string, year: number) =>
  db.all<MemberViewRow>(
    sql`SELECT ${personCols()}, gm.role, gm.shares_with_coach, s.this_week_days, s.this_week_target,
        s.consistency, s.last_active
      FROM group_members gm JOIN profiles p ON p.user_id = gm.user_id
      LEFT JOIN user_stats s ON s.user_id = gm.user_id
      WHERE gm.group_id = ${groupId} AND ${socialOk("p", year)} AND ${notBlocked(viewer, sql`gm.user_id`)}`,
  );

/** Every social member with a stats row, for the group streak (the same for every viewer). */
export const streakRows = (db: Db, groupId: string, year: number) =>
  db.all<{ joined: number; timezone: string; week_starts_on: number; recent_weeks: string }>(
    sql`SELECT gm.created_at AS joined, p.timezone, p.week_starts_on, s.recent_weeks
      FROM group_members gm JOIN profiles p ON p.user_id = gm.user_id
      JOIN user_stats s ON s.user_id = gm.user_id
      WHERE gm.group_id = ${groupId} AND ${socialOk("p", year)}`,
  );

/** Everyone else in the group (announcement recipients). */
export const otherMembers = (db: Db, groupId: string, me: string) =>
  db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), ne(groupMembers.userId, me)));

// ---- coaching -------------------------------------------------------------------------------------------------

/** Visible coaching groups where I coach (owner, admin or coach), by name. */
export const coachingGroups = (db: Db, me: string) =>
  db.all<{ id: string; name: string }>(
    sql`SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ${me} AND gm.role IN ('owner', 'admin', 'coach') AND g.kind = 'coaching'
        AND g.hidden_at IS NULL
      ORDER BY g.name_fold, g.name`,
  );

export type SharerRow = PersonRow & { group_id: string; timezone: string };

/**
 * Members who share their training with their coach, in the groups where I coach (or just `groupId`). No social or
 * block filter: consent to the coach is the rule here (Python).
 */
export const sharers = (db: Db, me: string, groupId: string | null) =>
  db.all<SharerRow>(
    sql`SELECT ${personCols("p", null)}, gm.group_id, p.timezone
      FROM group_members gm JOIN profiles p ON p.user_id = gm.user_id
      WHERE gm.shares_with_coach = 1 AND gm.user_id <> ${me} AND ${
        groupId === null
          ? sql`gm.group_id IN (SELECT g.id FROM group_members mine JOIN groups g ON g.id = mine.group_id
              WHERE mine.user_id = ${me} AND mine.role IN ('owner', 'admin', 'coach') AND g.kind = 'coaching'
                AND g.hidden_at IS NULL)`
          : sql`gm.group_id = ${groupId}`
      }
      ORDER BY gm.created_at, gm.id`,
  );

/** Each person's running plans (started, not finished), latest start first per person; the first is the one. */
export const runningPlansOf = (db: Db, userIds: readonly string[]) =>
  db
    .select()
    .from(trainingPlans)
    .where(
      and(
        sql`${trainingPlans.userId} IN (SELECT value FROM json_each(${JSON.stringify(userIds)}))`,
        sql`${trainingPlans.startedOn} IS NOT NULL`,
        sql`${trainingPlans.finishedAt} IS NULL`,
      ),
    )
    .orderBy(asc(trainingPlans.userId), sql`${trainingPlans.startedOn} DESC`, sql`${trainingPlans.id} DESC`);

export interface RecentWorkout {
  user_id: string;
  id: string;
  date: string;
  discipline: string;
  title: string | null;
  duration_sec: number | null;
  distance_m: number | null;
  effort: number | null;
  feel: number | null;
  sets: number;
}

/**
 * Each person's ten latest sessions with their completed working sets counted, for any number of people in one
 * statement: per id, a correlated `LIMIT 10` on ix_workouts_user_started picks the rows.
 */
export const recentWorkoutsOf = (db: Db, userIds: readonly string[]) =>
  db.all<RecentWorkout>(
    sql`SELECT w.user_id, w.id, w.local_date AS date, w.discipline, w.title, w.duration_sec, w.distance_m, w.effort,
        w.feel,
        (SELECT count(*) FROM workout_sets ws WHERE ws.workout_id = w.id AND ws.completed = 1
          AND ws.kind <> 'warmup') AS sets
      FROM json_each(${JSON.stringify(userIds)}) u
      JOIN workouts w ON w.id IN (
        SELECT x.id FROM workouts x WHERE x.user_id = u.value AND x.deleted_at IS NULL
        ORDER BY x.started_at DESC LIMIT 10)
      ORDER BY w.user_id, w.started_at DESC`,
  );

// ---- challenges -----------------------------------------------------------------------------------------------

export const challengeById = (db: Db, id: string) =>
  db.select().from(challenges).where(eq(challenges.id, id));

export const challengeByCode = (db: Db, code: string) =>
  db.select().from(challenges).where(eq(challenges.inviteCode, code));

export const participant = (db: Db, challengeId: Key, userId: string) =>
  db
    .select()
    .from(challengeParticipants)
    .where(and(eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, userId)));

/** Am I a member of the challenge's group? */
export const challengeGroupMember = (db: Db, challengeId: string, userId: string) =>
  db.all<{ ok: number }>(
    sql`SELECT EXISTS (SELECT 1 FROM group_members WHERE user_id = ${userId}
      AND group_id = (SELECT group_id FROM challenges WHERE id = ${challengeId})) AS ok`,
  );

/** Everyone who ever joined, including those who left (the 200 cap counts them, as in Python). */
export const participantCount = (db: Db, challengeId: Key) =>
  db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM challenge_participants WHERE challenge_id = ${challengeId}`,
  );

/** Challenges I'm in (not left) or that belong to my groups, not hidden, ending on or after `since`. */
export const listChallenges = (db: Db, me: string, since: string) =>
  db.all<{
    id: string;
    title: string;
    description: string | null;
    kind: string;
    target: number | null;
    disciplines: string;
    starts_on: string;
    ends_on: string;
    group_id: string | null;
    plan: string | null;
    creator_id: string;
    invite_code: string;
    resolved_at: number | null;
    joined: number;
    n: number;
  }>(
    sql`SELECT c.id, c.title, c.description, c.kind, c.target, c.disciplines, c.starts_on, c.ends_on, c.group_id,
        c.plan, c.creator_id, c.invite_code, c.resolved_at,
        EXISTS (SELECT 1 FROM challenge_participants j WHERE j.challenge_id = c.id AND j.user_id = ${me}
          AND j.left_at IS NULL) AS joined,
        (SELECT count(*) FROM challenge_participants n WHERE n.challenge_id = c.id AND n.left_at IS NULL) AS n
      FROM challenges c
      WHERE c.id IN (SELECT challenge_id FROM challenge_participants WHERE user_id = ${me} AND left_at IS NULL
                     UNION SELECT ch.id FROM challenges ch WHERE ch.group_id IN
                       (SELECT group_id FROM group_members WHERE user_id = ${me}))
        AND c.hidden_at IS NULL AND c.ends_on >= ${since}
      ORDER BY c.ends_on DESC, c.id`,
  );

export type BoardRow = PersonRow & {
  user_id: string;
  final_score: number | null;
  final_rank: number | null;
  completed: number;
  timezone: string;
  week_starts_on: number;
  recent_weeks: string | null;
  computed_for: string | null;
};

/** Participants who have not left, with their card, stats and what weekly_target scoring needs. */
export const board = (db: Db, challengeId: string) =>
  db.all<BoardRow>(
    sql`SELECT cp.user_id, cp.final_score, cp.final_rank, cp.completed, ${personCols()},
        p.timezone, p.week_starts_on, s.recent_weeks, s.computed_for
      FROM challenge_participants cp JOIN profiles p ON p.user_id = cp.user_id
      LEFT JOIN user_stats s ON s.user_id = cp.user_id
      WHERE cp.challenge_id = ${challengeId} AND cp.left_at IS NULL
      ORDER BY cp.created_at, cp.id`,
  );

/**
 * active_days: distinct app-logged dates per participant inside the challenge's window, logged within 3 days of
 * when they happened (backfilling a fortnight on the last day is what a challenge must not reward). The window
 * and disciplines come from the challenge row itself, so this rides in the same batch as reading it; the service
 * trims to "today".
 */
export const activeDays = (db: Db, challengeId: string) =>
  db.all<{ user_id: string; d: string }>(
    sql`SELECT DISTINCT w.user_id, w.local_date AS d
      FROM challenges c
      JOIN challenge_participants cp ON cp.challenge_id = c.id AND cp.left_at IS NULL
      JOIN workouts w ON w.user_id = cp.user_id AND w.local_date >= c.starts_on AND w.local_date <= c.ends_on
      WHERE c.id = ${challengeId} AND c.kind = 'active_days'
        AND w.deleted_at IS NULL AND w.source = 'app' AND w.created_at <= w.started_at + 259200000
        AND (json_array_length(c.disciplines) = 0
             OR w.discipline IN (SELECT value FROM json_each(c.disciplines)))`,
  );

/** Every copy of the challenge plan (the earliest per participant is theirs). */
export const planCopies = (db: Db, challengeId: string) =>
  db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.challengeId, challengeId))
    .orderBy(asc(trainingPlans.createdAt), asc(trainingPlans.id));

/**
 * App-logged (date, discipline) of participants of a plan challenge, in a window that covers every copy's run
 * (each starts on the week containing the first day, in its owner's week).
 */
export const planLogged = (db: Db, challengeId: string) =>
  db.all<{ user_id: string; d: string; discipline: string }>(
    sql`SELECT w.user_id, w.local_date AS d, w.discipline
      FROM challenges c
      JOIN challenge_participants cp ON cp.challenge_id = c.id AND cp.left_at IS NULL
      JOIN workouts w ON w.user_id = cp.user_id AND w.local_date >= date(c.starts_on, '-6 days')
        AND w.local_date <= date(c.ends_on, '+6 days')
      WHERE c.id = ${challengeId} AND c.kind = 'plan_sessions' AND w.deleted_at IS NULL AND w.source = 'app'`,
  );

/** Participants' profiles (resolution emits a feed event for those who completed). */
export const participantProfiles = (db: Db, challengeId: string) =>
  db
    .select()
    .from(profiles)
    .where(
      sql`${profiles.userId} IN (SELECT user_id FROM challenge_participants WHERE challenge_id = ${challengeId})`,
    );

export const myPlanCopy = (db: Db, userId: string, challengeId: Key) =>
  db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.challengeId, challengeId)))
    .orderBy(asc(trainingPlans.createdAt), asc(trainingPlans.id))
    .limit(1);

export const planById = (db: Db, id: string) =>
  db.select().from(trainingPlans).where(eq(trainingPlans.id, id));

export const planCount = (db: Db, userId: string) =>
  db.all<{ n: number }>(sql`SELECT count(*) AS n FROM training_plans WHERE user_id = ${userId}`);

export const routineNames = (db: Db, userId: string) =>
  db.all<{ id: string; name: string }>(
    sql`SELECT id, name FROM routines WHERE user_id = ${userId} ORDER BY created_at, id`,
  );

export const ownRoutines = (db: Db, userId: string) =>
  db.select().from(routines).where(eq(routines.userId, userId));

export const insertChallenge = (db: Db, v: typeof challenges.$inferInsert) => db.insert(challenges).values(v);

export const insertParticipant = (db: Db, v: typeof challengeParticipants.$inferInsert) =>
  db.insert(challengeParticipants).values(v);

export const rejoin = (db: Db, id: string, now: number) =>
  db
    .update(challengeParticipants)
    .set({ leftAt: null, updatedAt: now })
    .where(eq(challengeParticipants.id, id));

/** Leaving keeps the participant row and stops (but keeps) the plan copy. */
export const leaveStatements = (db: Db, challengeId: string, me: string, now: number) =>
  [
    db
      .update(challengeParticipants)
      .set({ leftAt: now, updatedAt: now })
      .where(and(eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, me))),
    db
      .update(trainingPlans)
      .set({ startedOn: null, updatedAt: now })
      .where(and(eq(trainingPlans.userId, me), eq(trainingPlans.challengeId, challengeId))),
  ] as const;

export const deleteChallenge = (db: Db, id: string, me: string) =>
  db
    .delete(challenges)
    .where(and(eq(challenges.id, id), eq(challenges.creatorId, me)))
    .returning({ id: challenges.id });

/** Challenges to freeze: unresolved and ended before `before` (hidden ones included, as in Python). */
export const dueChallenges = (db: Db, before: string) =>
  db
    .select()
    .from(challenges)
    .where(and(sql`${challenges.resolvedAt} IS NULL`, sql`${challenges.endsOn} < ${before}`))
    .orderBy(asc(challenges.endsOn), asc(challenges.id));

export const freezeParticipant = (
  db: Db,
  challengeId: string,
  userId: string,
  v: { finalScore: number; finalRank: number; completed: boolean },
  now: number,
) =>
  db
    .update(challengeParticipants)
    .set({ ...v, updatedAt: now })
    .where(and(eq(challengeParticipants.challengeId, challengeId), eq(challengeParticipants.userId, userId)));

export const markResolved = (db: Db, id: string, now: number) =>
  db.update(challenges).set({ resolvedAt: now, updatedAt: now }).where(eq(challenges.id, id));

// ---- announcements --------------------------------------------------------------------------------------------

export const listAnnouncements = (db: Db, groupId: string) =>
  db.all<
    PersonRow & { id: string; body: string; pinned: number; created_at: number; author_id: string | null }
  >(
    sql`SELECT a.id, a.body, a.pinned, a.created_at, a.author_id, ${personCols("p", null)}
      FROM group_announcements a LEFT JOIN profiles p ON p.user_id = a.author_id
      WHERE a.group_id = ${groupId}
      ORDER BY a.pinned DESC, a.created_at DESC, a.id DESC LIMIT 30`,
  );

export const unpinAll = (db: Db, groupId: string, now: number) =>
  db
    .update(groupAnnouncements)
    .set({ pinned: false, updatedAt: now })
    .where(and(eq(groupAnnouncements.groupId, groupId), eq(groupAnnouncements.pinned, true)));

export const insertAnnouncement = (db: Db, v: typeof groupAnnouncements.$inferInsert) =>
  db.insert(groupAnnouncements).values(v);

export const deleteAnnouncement = (db: Db, groupId: string, id: string) =>
  db
    .delete(groupAnnouncements)
    .where(and(eq(groupAnnouncements.id, id), eq(groupAnnouncements.groupId, groupId)))
    .returning({ id: groupAnnouncements.id });

// ---- EXPLAIN registry -----------------------------------------------------------------------------------------

const U = "00000000-0000-7000-8000-000000000001";
const G = "00000000-0000-7000-8000-000000000002";
const Y = 2026;
const D = "2026-01-01";
const JSON_IDS = "walks the JSON id list; each id probes the table's user index";

type Case = {
  name: string;
  build: (db: Db) => SQLWrapper | { toSQL(): { sql: string; params: unknown[] } };
  scanOk?: string;
};

const cases: Case[] = [
  { name: "groups.groupById", build: (db) => groupById(db, G) },
  { name: "groups.membership", build: (db) => membership(db, G, U) },
  { name: "groups.membershipByCode", build: (db) => membership(db, groupIdByCode("abcdefgh"), U) },
  { name: "groups.memberCountByCode", build: (db) => memberCount(db, groupIdByCode("abcdefgh")) },
  { name: "groups.participantByCode", build: (db) => participant(db, challengeIdByCode("abcdefgh"), U) },
  {
    name: "groups.participantCountByCode",
    build: (db) => participantCount(db, challengeIdByCode("abcdefgh")),
  },
  { name: "groups.myPlanCopyByCode", build: (db) => myPlanCopy(db, U, challengeIdByCode("abcdefgh")) },
  { name: "groups.profileOf", build: (db) => profileOf(db, U) },
  { name: "groups.myGroups", build: (db) => myGroups(db, U) },
  { name: "groups.ownedCount", build: (db) => ownedCount(db, U) },
  { name: "groups.groupByCode", build: (db) => groupByCode(db, "abcdefgh") },
  { name: "groups.memberCount", build: (db) => memberCount(db, G) },
  { name: "groups.patchGroup", build: (db) => patchGroup(db, G, { name: "x" }) },
  { name: "groups.deleteGroup", build: (db) => deleteGroup(db, G) },
  { name: "groups.deleteMember", build: (db) => deleteMember(db, G, U) },
  { name: "groups.setRole", build: (db) => setRole(db, G, U, "coach", 0) },
  { name: "groups.patchMe", build: (db) => patchMe(db, G, U, { muted: true }, 0) },
  { name: "groups.membersView", build: (db) => membersView(db, U, G, Y) },
  { name: "groups.streakRows", build: (db) => streakRows(db, G, Y) },
  { name: "groups.otherMembers", build: (db) => otherMembers(db, G, U) },
  { name: "groups.coachingGroups", build: (db) => coachingGroups(db, U) },
  { name: "groups.sharers", build: (db) => sharers(db, U, G) },
  { name: "groups.sharersAll", build: (db) => sharers(db, U, null) },
  { name: "groups.runningPlansOf", build: (db) => runningPlansOf(db, [U, G]), scanOk: JSON_IDS },
  { name: "groups.recentWorkoutsOf", build: (db) => recentWorkoutsOf(db, [U, G]), scanOk: JSON_IDS },
  { name: "groups.challengeById", build: (db) => challengeById(db, G) },
  { name: "groups.challengeByCode", build: (db) => challengeByCode(db, "abcdefgh") },
  { name: "groups.participant", build: (db) => participant(db, G, U) },
  { name: "groups.challengeGroupMember", build: (db) => challengeGroupMember(db, G, U) },
  { name: "groups.participantCount", build: (db) => participantCount(db, G) },
  { name: "groups.listChallenges", build: (db) => listChallenges(db, U, D) },
  { name: "groups.board", build: (db) => board(db, G) },
  {
    name: "groups.activeDays",
    build: (db) => activeDays(db, G),
    scanOk: "json_each over the challenge's own discipline list (at most 11)",
  },
  { name: "groups.planCopies", build: (db) => planCopies(db, G) },
  { name: "groups.planLogged", build: (db) => planLogged(db, G) },
  { name: "groups.participantProfiles", build: (db) => participantProfiles(db, G) },
  { name: "groups.myPlanCopy", build: (db) => myPlanCopy(db, U, G) },
  { name: "groups.planById", build: (db) => planById(db, G) },
  { name: "groups.planCount", build: (db) => planCount(db, U) },
  { name: "groups.routineNames", build: (db) => routineNames(db, U) },
  { name: "groups.ownRoutines", build: (db) => ownRoutines(db, U) },
  { name: "groups.rejoin", build: (db) => rejoin(db, G, 0) },
  { name: "groups.leave.0", build: (db) => leaveStatements(db, G, U, 0)[0] },
  { name: "groups.leave.1", build: (db) => leaveStatements(db, G, U, 0)[1] },
  { name: "groups.deleteChallenge", build: (db) => deleteChallenge(db, G, U) },
  { name: "groups.dueChallenges", build: (db) => dueChallenges(db, D) },
  {
    name: "groups.freezeParticipant",
    build: (db) => freezeParticipant(db, G, U, { finalScore: 1, finalRank: 1, completed: true }, 0),
  },
  { name: "groups.markResolved", build: (db) => markResolved(db, G, 0) },
  { name: "groups.listAnnouncements", build: (db) => listAnnouncements(db, G) },
  { name: "groups.unpinAll", build: (db) => unpinAll(db, G, 0) },
  { name: "groups.deleteAnnouncement", build: (db) => deleteAnnouncement(db, G, U) },
];

/** Raw statements (`db.all`, `db.run`) are planned through their SQL. */
export const explain: ExplainCase[] = cases.map((c) => ({
  ...c,
  build: (db: Db) => {
    const b = c.build(db);
    return "toSQL" in b ? b : b.getSQL();
  },
}));
