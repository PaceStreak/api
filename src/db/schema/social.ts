import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, enumCheck, json, maxLength, ms } from "./columns.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const FOLLOW_STATUSES = ["pending", "accepted"] as const;
export const REPORT_TARGETS = ["user", "comment", "event", "group", "challenge"] as const;
export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export const BUDDY_STATUSES = ["pending", "active", "ended"] as const;
export const REACTIONS = ["kudos", "fire", "strong", "star", "heart"] as const;

export const follows = sqliteTable(
  "follows",
  {
    ...base(),
    followerId: userFk(),
    followeeId: userFk(),
    status: text({ enum: FOLLOW_STATUSES }).notNull().default("pending"),
    acceptedAt: ms(),
  },
  (t) => [
    unique("uq_follow_pair").on(t.followerId, t.followeeId),
    index("ix_follows_followee").on(t.followeeId, t.status),
    enumCheck("ck_follow_status", t.status, FOLLOW_STATUSES),
    check("ck_follow_not_self", sql`${t.followerId} <> ${t.followeeId}`),
  ],
);

export const blocks = sqliteTable(
  "blocks",
  {
    ...base(),
    blockerId: userFk(),
    blockedId: userFk(),
  },
  (t) => [
    unique("uq_block_pair").on(t.blockerId, t.blockedId),
    index("ix_blocks_blocked_id").on(t.blockedId),
  ],
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    ...base(),
    userId: userFk(),
    /** workout | pr | streak | achievement | level | challenge. Never a habit. */
    kind: text().notNull(),
    refKey: text().notNull(),
    data: json<Record<string, unknown>>().notNull().default({}),
    occurredOn: text().notNull(),
    /** Not a foreign key. */
    workoutId: text(),
    hiddenAt: ms(),
  },
  (t) => [
    unique("uq_activity_ref").on(t.userId, t.kind, t.refKey),
    index("ix_activity_events_workout_id").on(t.workoutId),
    index("ix_activity_feed").on(t.userId, t.createdAt),
  ],
);

export const kudos = sqliteTable(
  "kudos",
  {
    ...base(),
    eventId: text()
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    userId: userFk(),
    reaction: text({ enum: REACTIONS }).notNull().default("kudos"),
  },
  (t) => [
    unique("uq_kudos_pair").on(t.eventId, t.userId),
    index("ix_kudos_user_id").on(t.userId),
    enumCheck("ck_kudos_reaction", t.reaction, REACTIONS),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    ...base(),
    eventId: text()
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    authorId: userFk(),
    body: text().notNull(),
    hiddenAt: ms(),
  },
  (t) => [
    index("ix_comments_author_id").on(t.authorId),
    index("ix_comments_event").on(t.eventId, t.createdAt),
    maxLength("ck_comments_body_len", t.body, 280),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    ...base(),
    reporterId: userFk(),
    reportedUserId: text().references(() => users.id, { onDelete: "set null" }),
    targetType: text({ enum: REPORT_TARGETS }).notNull(),
    targetId: text().notNull(),
    reason: text().notNull(),
    detail: text(),
    snapshot: json<Record<string, unknown>>(),
    status: text({ enum: REPORT_STATUSES }).notNull().default("open"),
    resolvedBy: text().references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ms(),
    resolution: text(),
  },
  (t) => [
    index("ix_reports_reporter_id").on(t.reporterId),
    index("ix_reports_reported_user_id").on(t.reportedUserId),
    index("ix_reports_resolved_by").on(t.resolvedBy),
    index("ix_reports_status").on(t.status, t.createdAt),
    enumCheck("ck_report_target", t.targetType, REPORT_TARGETS),
    enumCheck("ck_report_status", t.status, REPORT_STATUSES),
  ],
);

/** Ordered pair: `user_a < user_b` as lowercase UUID strings. */
export const buddyPairs = sqliteTable(
  "buddy_pairs",
  {
    ...base(),
    userA: userFk(),
    userB: userFk(),
    /** Not a foreign key. */
    requestedBy: text().notNull(),
    status: text({ enum: BUDDY_STATUSES }).notNull().default("pending"),
    startedAt: ms(),
    endedAt: ms(),
  },
  (t) => [
    unique("uq_buddy_pair").on(t.userA, t.userB),
    index("ix_buddy_pairs_user_b").on(t.userB),
    enumCheck("ck_buddy_status", t.status, BUDDY_STATUSES),
    check("ck_buddy_order", sql`${t.userA} < ${t.userB}`),
  ],
);
