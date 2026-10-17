import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, bool, enumCheck, json, maxLength, ms } from "./columns.ts";

export const GROUP_KINDS = ["crew", "coaching"] as const;
export const GROUP_ROLES = ["owner", "admin", "coach", "member"] as const;
export const CHALLENGE_KINDS = ["active_days", "weekly_target", "plan_sessions"] as const;

export const groups = sqliteTable(
  "groups",
  {
    ...base(),
    name: text().notNull(),
    nameFold: text().notNull(),
    description: text(),
    kind: text({ enum: GROUP_KINDS }).notNull().default("crew"),
    ownerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 8 chars from `abcdefghjkmnpqrstuvwxyz23456789`; looked up lowercase. */
    inviteCode: text().notNull(),
    avatarHue: integer().notNull().default(200),
    hiddenAt: ms(),
    /** Percent of members who must keep their week. */
    streakThreshold: integer().notNull().default(75),
  },
  (t) => [
    uniqueIndex("ix_groups_invite_code").on(t.inviteCode),
    index("ix_groups_owner_id").on(t.ownerId),
    index("ix_groups_name_fold").on(t.nameFold),
    enumCheck("ck_group_kind", t.kind, GROUP_KINDS),
  ],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    ...base(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: GROUP_ROLES }).notNull().default("member"),
    sharesWithCoach: bool().notNull().default(false),
    muted: bool().notNull().default(false),
  },
  (t) => [
    unique("uq_group_member").on(t.groupId, t.userId),
    index("ix_group_members_user_id").on(t.userId),
    enumCheck("ck_group_member_role", t.role, GROUP_ROLES),
  ],
);

export const challenges = sqliteTable(
  "challenges",
  {
    ...base(),
    title: text().notNull(),
    description: text(),
    kind: text({ enum: CHALLENGE_KINDS }).notNull().default("active_days"),
    target: integer(),
    disciplines: json<string[]>().notNull().default([]),
    startsOn: text().notNull(),
    endsOn: text().notNull(),
    creatorId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text().references(() => groups.id, { onDelete: "cascade" }),
    inviteCode: text().notNull(),
    resolvedAt: ms(),
    hiddenAt: ms(),
    /** Shareable plan (routines embedded) for `plan_sessions`. */
    plan: json<Record<string, unknown>>(),
  },
  (t) => [
    index("ix_challenges_creator_id").on(t.creatorId),
    index("ix_challenges_group_id").on(t.groupId),
    uniqueIndex("ix_challenges_invite_code").on(t.inviteCode),
    index("ix_challenges_unresolved").on(t.endsOn).where(sql`${t.resolvedAt} IS NULL`),
    enumCheck("ck_challenge_kind", t.kind, CHALLENGE_KINDS),
    check("ck_challenge_range", sql`${t.endsOn} >= ${t.startsOn}`),
    maxLength("ck_challenges_title_len", t.title, 60),
  ],
);

export const challengeParticipants = sqliteTable(
  "challenge_participants",
  {
    ...base(),
    challengeId: text()
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    finalScore: integer(),
    finalRank: integer(),
    completed: bool().notNull().default(false),
    leftAt: ms(),
  },
  (t) => [
    unique("uq_challenge_participant").on(t.challengeId, t.userId),
    index("ix_challenge_participants_user_id").on(t.userId),
  ],
);

export const groupAnnouncements = sqliteTable(
  "group_announcements",
  {
    ...base(),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    authorId: text().references(() => users.id, { onDelete: "set null" }),
    body: text().notNull(),
    pinned: bool().notNull().default(false),
  },
  (t) => [
    index("ix_group_announcements_group").on(t.groupId, t.createdAt),
    index("ix_group_announcements_author_id").on(t.authorId),
    maxLength("ck_group_announcements_body_len", t.body, 500),
  ],
);
