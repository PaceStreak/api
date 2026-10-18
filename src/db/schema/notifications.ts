import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, bool, json, ms } from "./columns.ts";

const userFk = () =>
  text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

/**
 * In-app inbox and the delivery outbox (DESIGN.md §9): `notify()` inserts rows in the caller's write batch, the
 * queue consumer sends push/email and sets `delivered_at`.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    ...base(),
    userId: userFk(),
    kind: text().notNull(),
    category: text().notNull(),
    title: text().notNull(),
    body: text(),
    url: text(),
    actorId: text().references(() => users.id, { onDelete: "set null" }),
    data: json<Record<string, unknown>>(),
    /** NULL keys never collide. */
    dedupeKey: text(),
    readAt: ms(),
    deliveredAt: ms(),
    deliveryAttempts: integer().notNull().default(0),
  },
  (t) => [
    unique("uq_notification_dedupe").on(t.userId, t.dedupeKey),
    index("ix_notifications_inbox").on(t.userId, t.createdAt),
    index("ix_notifications_actor_id").on(t.actorId),
    // The daily 180-day retention sweep (jobs housekeeping).
    index("ix_notifications_created_at").on(t.createdAt),
    index("ix_notifications_undelivered").on(t.createdAt).where(sql`${t.deliveredAt} IS NULL`),
  ],
);

export type Channels = Record<string, { push: boolean; email: boolean }>;
export const BACKUP_FREQUENCIES = ["monthly", "weekly"] as const;

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    ...base(),
    userId: userFk(),
    channels: json<Channels>().notNull().default({}),
    habitSummaryHour: integer(),
    backupAttachment: bool().notNull().default(false),
    backupFrequency: text({ enum: BACKUP_FREQUENCIES }).notNull().default("monthly"),
  },
  (t) => [uniqueIndex("ix_notification_preferences_user_id").on(t.userId)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    ...base(),
    userId: userFk(),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    lastSuccessAt: ms(),
    failures: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_push_subscriptions_endpoint").on(t.endpoint),
    index("ix_push_subscriptions_user_id").on(t.userId),
  ],
);
