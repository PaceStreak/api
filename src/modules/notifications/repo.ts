/** Query builders for the notifications module (spec/misc.md §2). Every function returns an un-awaited query. */
import { and, count, desc, eq, inArray, isNull, lt, not, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import {
  type Channels,
  groupMembers,
  notificationPreferences,
  notifications,
  profiles,
  pushSubscriptions,
  users,
} from "../../db/schema/index.ts";

// ---- inbox ------------------------------------------------------------------------------------------------

export const inbox = (db: Db, userId: string, before: number | null, limit: number) =>
  db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      category: notifications.category,
      title: notifications.title,
      body: notifications.body,
      url: notifications.url,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      handle: profiles.handle,
      displayName: profiles.displayName,
      avatarHue: profiles.avatarHue,
      // Aliased so a missing profile is told apart from a profile with null fields.
      actorProfile: sql<string | null>`${profiles.userId}`.as("actor_profile"),
    })
    .from(notifications)
    .leftJoin(profiles, eq(profiles.userId, notifications.actorId))
    .where(
      and(
        eq(notifications.userId, userId),
        before === null ? undefined : lt(notifications.createdAt, before),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit + 1);

export const unreadCount = (db: Db, userId: string) =>
  db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

export const markRead = (db: Db, userId: string, ids: readonly string[] | null, now: number) =>
  db
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids === null ? undefined : inArray(notifications.id, [...ids]),
      ),
    );

export interface NewNotification {
  id: string;
  userId: string;
  kind: string;
  category: string;
  title: string;
  body: string | null;
  url: string | null;
  actorId: string | null;
  data: Record<string, unknown> | null;
  dedupeKey: string | null;
}

/** `ON CONFLICT DO NOTHING RETURNING id`: empty on a duplicate `(user_id, dedupe_key)` (gate G-3). */
export const insertNotification = (db: Db, n: NewNotification, now: number) =>
  db
    .insert(notifications)
    .values({ ...n, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: notifications.id });

/** Removes notification `id` again when `allowed` (a rate-limit predicate) is false: a rejected call still counts. */
export const dropOverLimit = (db: Db, id: string, allowed: SQL) =>
  db.delete(notifications).where(and(eq(notifications.id, id), not(allowed)));

// ---- preferences ------------------------------------------------------------------------------------------

export const preferences = (db: Db, userId: string) =>
  db
    .select({
      channels: notificationPreferences.channels,
      habitSummaryHour: notificationPreferences.habitSummaryHour,
      backupAttachment: notificationPreferences.backupAttachment,
      backupFrequency: notificationPreferences.backupFrequency,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

export interface PreferenceUpdates {
  channels?: Channels;
  habitSummaryHour?: number | null;
  backupAttachment?: boolean;
  backupFrequency?: "monthly" | "weekly";
}

export const upsertPreferences = (db: Db, userId: string, updates: PreferenceUpdates, now: number) =>
  db
    .insert(notificationPreferences)
    .values({ channels: {}, ...updates, userId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...updates, updatedAt: now } });

/**
 * Sets `channels[category].email = false`, merged in SQL so it needs no read and cannot lose a concurrent change.
 * `category` is one of the fixed CATEGORIES keys (checked by the caller), bound as a parameter all the same.
 */
export const emailOff = (db: Db, userId: string, category: string, now: number) => {
  const path = `$.${category}`;
  const merged = (col: unknown) =>
    sql`json_set(${col}, ${path}, json_patch(coalesce(json_extract(${col}, ${path}), '{}'), '{"email":false}'))`;
  return db
    .insert(notificationPreferences)
    .values({
      userId,
      channels: { [category]: { email: false } } as Channels,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { channels: merged(notificationPreferences.channels), updatedAt: now },
    });
};

// ---- push subscriptions -----------------------------------------------------------------------------------

export const subscriptionCount = (db: Db, userId: string) =>
  db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

export interface SubscriptionValues {
  userId: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}

/** The endpoint is the browser's identity: re-subscribing moves it to this account (a shared device). */
export const upsertSubscription = (
  db: Db,
  endpoint: string,
  v: SubscriptionValues,
  id: string,
  now: number,
) =>
  db
    .insert(pushSubscriptions)
    .values({ ...v, id, endpoint, failures: 0, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { ...v, failures: 0, updatedAt: now },
    });

export const deleteOwnSubscription = (db: Db, userId: string, endpoint: string) =>
  db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));

// ---- delivery ---------------------------------------------------------------------------------------------

/** Undelivered notes with everything delivery decides on: preferences, profile (quiet hours), user. */
export const pendingNotes = (db: Db, ids: readonly string[]) =>
  db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      kind: notifications.kind,
      category: notifications.category,
      title: notifications.title,
      body: notifications.body,
      url: notifications.url,
      data: notifications.data,
      channels: notificationPreferences.channels,
      timezone: profiles.timezone,
      quietStart: profiles.quietStart,
      quietEnd: profiles.quietEnd,
      quietDays: profiles.quietDays,
      email: users.email,
      isActive: users.isActive,
      isVerified: users.isVerified,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, notifications.userId))
    .leftJoin(profiles, eq(profiles.userId, notifications.userId))
    .where(and(inArray(notifications.id, [...ids]), isNull(notifications.deliveredAt)));

const ownersOf = (db: Db, ids: readonly string[]) =>
  db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(inArray(notifications.id, [...ids]));

export const subscriptionsFor = (db: Db, ids: readonly string[]) =>
  db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      failures: pushSubscriptions.failures,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, ownersOf(db, ids)));

/** Groups the owners of `ids` muted; `data.group_id` is matched in JS (JSON is never filtered in SQL). */
export const mutedGroupsFor = (db: Db, ids: readonly string[]) =>
  db
    .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(inArray(groupMembers.userId, ownersOf(db, ids)), eq(groupMembers.muted, true)));

export const markDelivered = (db: Db, ids: readonly string[], now: number) =>
  db
    .update(notifications)
    .set({ deliveredAt: now, updatedAt: now })
    .where(and(inArray(notifications.id, [...ids]), isNull(notifications.deliveredAt)));

export const deleteSubscriptions = (db: Db, ids: readonly string[]) =>
  db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...ids]));

export const subscriptionsSucceeded = (db: Db, ids: readonly string[], now: number) =>
  db
    .update(pushSubscriptions)
    .set({ lastSuccessAt: now, failures: 0, updatedAt: now })
    .where(inArray(pushSubscriptions.id, [...ids]));

export const subscriptionFailed = (db: Db, id: string, failures: number, now: number) =>
  db.update(pushSubscriptions).set({ failures, updatedAt: now }).where(eq(pushSubscriptions.id, id));

/** Most notes one retry sweep re-enqueues (DESIGN.md §9 dispatchers: LIMIT 500). */
export const RETRY_BATCH = 500;
export const RETRY_AFTER_MS = 2 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Claims undelivered notes older than two minutes with attempts left, counting the attempt, and returns their ids.
 * The inner select uses the partial index `ix_notifications_undelivered`.
 */
export const claimRetries = (db: Db, now: number) =>
  db
    .update(notifications)
    .set({ deliveryAttempts: sql`${notifications.deliveryAttempts} + 1` })
    .where(
      inArray(
        notifications.id,
        db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              isNull(notifications.deliveredAt),
              lt(notifications.createdAt, now - RETRY_AFTER_MS),
              lt(notifications.deliveryAttempts, MAX_DELIVERY_ATTEMPTS),
            ),
          )
          .orderBy(notifications.createdAt)
          .limit(RETRY_BATCH),
      ),
    )
    .returning({ id: notifications.id });

export const explain: ExplainCase[] = [
  { name: "notifications.inbox", build: (db) => inbox(db, "u", null, 30) },
  { name: "notifications.inboxBefore", build: (db) => inbox(db, "u", 1, 30) },
  { name: "notifications.unreadCount", build: (db) => unreadCount(db, "u") },
  { name: "notifications.markRead", build: (db) => markRead(db, "u", ["a"], 0) },
  { name: "notifications.markAllRead", build: (db) => markRead(db, "u", null, 0) },
  { name: "notifications.preferences", build: (db) => preferences(db, "u") },
  { name: "notifications.subscriptionCount", build: (db) => subscriptionCount(db, "u") },
  { name: "notifications.deleteOwnSubscription", build: (db) => deleteOwnSubscription(db, "u", "e") },
  { name: "notifications.pendingNotes", build: (db) => pendingNotes(db, ["a", "b"]) },
  { name: "notifications.subscriptionsFor", build: (db) => subscriptionsFor(db, ["a"]) },
  { name: "notifications.mutedGroupsFor", build: (db) => mutedGroupsFor(db, ["a"]) },
  { name: "notifications.markDelivered", build: (db) => markDelivered(db, ["a"], 0) },
  { name: "notifications.deleteSubscriptions", build: (db) => deleteSubscriptions(db, ["a"]) },
  { name: "notifications.subscriptionsSucceeded", build: (db) => subscriptionsSucceeded(db, ["a"], 0) },
  { name: "notifications.subscriptionFailed", build: (db) => subscriptionFailed(db, "a", 1, 0) },
  { name: "notifications.claimRetries", build: (db) => claimRetries(db, 0) },
];
