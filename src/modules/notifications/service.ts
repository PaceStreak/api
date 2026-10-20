/**
 * Notifications (spec/misc.md §2, DESIGN.md §9 "Notifications as outbox"). The only file other modules may import.
 *
 * Every notification is an inbox row first. `notify()` builds that insert for the caller's own write batch, and
 * `dispatchNotified()` defers one `deliver{ids}` queue message after the commit. The `deliver` consumer sends push
 * and email (best effort, per the user's channel choices), applies the push outcomes to the subscriptions and sets
 * `delivered_at` in one write batch. `retryUndelivered()` re-enqueues notes whose delivery never finished.
 */
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, runBatch, type Stmt, toWire, writeBatch } from "../../db/batch.ts";
import type { Channels } from "../../db/schema/index.ts";
import type { ConsumerRegistry } from "../../jobs/consumer.ts";
import { chunk, dispatchDeliver } from "../../jobs/dispatch.ts";
import { hex } from "../../lib/b64url.ts";
import { timingSafeEqualStr } from "../../lib/crypto/consttime.ts";
import { hmacSha256 } from "../../lib/crypto/hmac.ts";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors.ts";
import { type Attachment, attachmentBytes, createMailer } from "../../lib/mailer/index.ts";
import { subrequestBudget } from "../../lib/plan.ts";
import { isSafePushEndpoint } from "../../lib/push/guard.ts";
import { type PushOutcome, sendPush } from "../../lib/push/send.ts";
import { createVapidSigner } from "../../lib/push/vapid.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { localDate, localHour, pyWeekday, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";
import type { EmailUnsubscribeInput, PreferencesInput } from "./schemas.ts";

// ---- categories -------------------------------------------------------------------------------------------

interface CategoryMeta {
  label: string;
  push: boolean;
  email: boolean;
  locked?: true;
}

/** Category -> default channels, in the order GET /preferences lists them. The inbox is always on. */
export const CATEGORIES = {
  streak_risk: { label: "Streak at risk", push: true, email: false },
  reminder: { label: "Training reminders", push: false, email: false },
  // Push on by default: a habit only reminds at an hour its owner chose.
  habits: { label: "Habit reminders", push: true, email: false },
  digest: { label: "Weekly summary", push: false, email: true },
  achievements: { label: "Achievements and records", push: false, email: false },
  // A few big moments only (game service MILESTONE_*): the email is the point, so it is on by default.
  milestones: { label: "Milestones", push: false, email: true },
  social: { label: "Follows, kudos and comments", push: true, email: false },
  groups: { label: "Groups and challenges", push: true, email: false },
  // Opt-in everywhere; the export is attached only with the separate backup_attachment opt-in.
  backup: { label: "Monthly backup", push: false, email: false },
  // Security notices always email and cannot be turned off.
  security: { label: "Security", push: true, email: true, locked: true },
} as const satisfies Record<string, CategoryMeta>;

export type Category = keyof typeof CATEGORIES;

function categoryMeta(c: string): CategoryMeta | undefined {
  return Object.hasOwn(CATEGORIES, c) ? (CATEGORIES as Record<string, CategoryMeta>)[c] : undefined;
}

/** Nudges, which quiet days hold back from push and email. */
export const NUDGE_CATEGORIES: ReadonlySet<string> = new Set(["streak_risk", "reminder", "habits"]);

type StoredChannels = Record<string, Partial<Record<string, boolean>>>;

/**
 * Python `channels_for`: stored choice, else the category default; locked categories always email. With email off
 * (`emailEnabled` false) the email channel is off everywhere; stored choices are kept for when it comes back.
 */
export function channelsFor(
  prefs: StoredChannels | null | undefined,
  category: string,
  emailEnabled: boolean,
) {
  const base: CategoryMeta = categoryMeta(category) ?? { label: category, push: false, email: false };
  const chosen = prefs?.[category] ?? {};
  const push = Boolean(chosen.push ?? base.push);
  if (!emailEnabled) return { push, email: false };
  if (base.locked) return { push, email: true };
  return { push, email: Boolean(chosen.email ?? base.email) };
}

export interface QuietProfile {
  timezone: string | null;
  quietStart: number | null;
  quietEnd: number | null;
  quietDays: number | null;
}

export function inQuietHours(p: QuietProfile | null, now: number): boolean {
  if (p === null || p.quietStart === null || p.quietEnd === null) return false;
  const h = localHour(now, zone(p.timezone));
  const { quietStart: start, quietEnd: end } = p;
  if (start === end) return false;
  if (start > end) return h >= start || h < end; // wraps midnight, e.g. 22 -> 7
  return start <= h && h < end;
}

/** Python `_quiet_day`: bit `weekday()` (Monday = 0) of `quiet_days`, nudges only. */
export function isQuietDay(p: QuietProfile | null, category: string, now: number): boolean {
  if (p === null || !p.quietDays || !NUDGE_CATEGORIES.has(category)) return false;
  const day = pyWeekday(localDate(now, zone(p.timezone)));
  return ((p.quietDays >> day) & 1) === 1;
}

// ---- unsubscribe links (RFC 8058) -------------------------------------------------------------------------

const secrets = new WeakMap<Uint8Array, Promise<Uint8Array>>();

/** Derived from PEPPER (the Python service derived it from the RS256 key, which no longer exists). */
function unsubscribeSecret(ctx: Ctx): Promise<Uint8Array> {
  let s = secrets.get(ctx.cfg.pepper);
  if (s === undefined) {
    s = hmacSha256(ctx.cfg.pepper, "unsubscribe");
    secrets.set(ctx.cfg.pepper, s);
  }
  return s;
}

/** 32 lowercase hex characters of HMAC-SHA256(secret, `"{uuid}:{category}"`), as in Python. */
export async function signUnsubscribe(ctx: Ctx, userId: string, category: string): Promise<string> {
  const mac = await hmacSha256(await unsubscribeSecret(ctx), `${userId.toLowerCase()}:${category}`);
  return hex(mac).slice(0, 32);
}

async function verifyUnsubscribe(ctx: Ctx, userId: string, category: string, sig: string) {
  return timingSafeEqualStr(await signUnsubscribe(ctx, userId, category), sig);
}

const query = (userId: string, category: string, sig: string) =>
  `u=${userId}&c=${encodeURIComponent(category)}&s=${sig}`;

export async function unsubscribeLink(ctx: Ctx, userId: string, category: string): Promise<string> {
  return `${ctx.cfg.frontendUrl}/unsubscribe?${query(userId, category, await signUnsubscribe(ctx, userId, category))}`;
}

export async function oneClickUrl(ctx: Ctx, userId: string, category: string): Promise<string> {
  const sig = await signUnsubscribe(ctx, userId, category);
  return `${ctx.cfg.publicApiUrl}/v1/notifications/unsubscribe/one-click?${query(userId, category, sig)}`;
}

/** List-Unsubscribe headers for one category's email (Gmail and Yahoo require them for bulk senders). */
export async function listHeaders(
  ctx: Ctx,
  userId: string,
  category: string,
): Promise<Record<string, string>> {
  return {
    "List-Unsubscribe": `<${await oneClickUrl(ctx, userId, category)}>, <${await unsubscribeLink(ctx, userId, category)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ---- notify(): the outbox insert --------------------------------------------------------------------------

export interface NotifyInput {
  /** Defaults to a fresh UUIDv7. */
  id?: string;
  userId: string;
  kind: string;
  category: Category;
  /** The email subject and the push title: never a habit's name, note or amount (they show on lock screens). */
  title: string;
  /** The push body, also shown on lock screens: the same rule as `title`. */
  body?: string | null;
  /**
   * Private text for the places only the owner reads: the email body and the in-app inbox, never push. Habit
   * details go here.
   */
  detail?: string | null;
  url?: string | null;
  actorId?: string | null;
  /** `group_id` (mute check), `actions` (push buttons, first two), `export_attachment` (backup email). */
  data?: Record<string, unknown> | null;
  /** Unique per user; a second notify with the same key inserts nothing. NULL never collides. */
  dedupeKey?: string | null;
}

/** Python slices count code points; JS `.slice` counts UTF-16 units and could split an emoji. */
const codePoints = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/**
 * The inbox insert, for the caller's write batch. Its result is `[{ id }]`, or `[]` when the dedupe key already
 * exists. After the batch commits, pass the results to `dispatchNotified`.
 */
export function notify(ctx: Ctx, n: NotifyInput) {
  const now = ctx.clock.now();
  return repo.insertNotification(ctx.db, inboxRow(n, now), now);
}

/**
 * Several inbox inserts as ONE statement (a multi-row `INSERT ... ON CONFLICT DO NOTHING RETURNING id`): the Free
 * plan counts every statement of a batch against 50 D1 queries per invocation. Its result is the ids actually
 * inserted, like `notify()`'s.
 */
export function notifyMany(ctx: Ctx, ns: readonly NotifyInput[]) {
  const now = ctx.clock.now();
  return repo.insertNotifications(
    ctx.db,
    ns.map((n) => inboxRow(n, now)),
    now,
  );
}

function inboxRow(n: NotifyInput, now: number) {
  return {
    id: n.id ?? uuid7(now),
    userId: n.userId,
    kind: n.kind,
    category: n.category,
    title: codePoints(n.title, 120),
    body: n.body ? codePoints(n.body, 400) : null,
    url: n.url ?? null,
    actorId: n.actorId ?? null,
    data: n.detail ? { ...n.data, detail: codePoints(n.detail, 400) } : (n.data ?? null),
    dedupeKey: n.dedupeKey ?? null,
  };
}

export type NotifyResult = readonly { id: string }[];

/** Ids that `notify()` statements actually inserted. */
export const notifiedIds = (...results: NotifyResult[]): string[] => results.flat().map((r) => r.id);

/** Defers one `deliver` message per 50 inserted ids (nothing when all were deduplicated). Returns the ids. */
export function dispatchNotified(ctx: Ctx, ...results: NotifyResult[]): string[] {
  const ids = notifiedIds(...results);
  if (ids.length > 0) ctx.defer(dispatchDeliver(ctx.env.JOBS, ids));
  return ids;
}

// ---- inbox ------------------------------------------------------------------------------------------------

/** The private text a note carries for its owner (`NotifyInput.detail`), if any. */
function detailOf(data: Record<string, unknown> | null | undefined): string | null {
  const d = data?.detail;
  return typeof d === "string" && d !== "" ? d : null;
}

export async function list(ctx: Ctx, authed: AuthedBatch, q: { before?: number | undefined; limit: number }) {
  const [, rows] = await authed.read(repo.inbox(ctx.db, authed.userId, q.before ?? null, q.limit));
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((n) => ({
      id: n.id,
      kind: n.kind,
      category: n.category,
      title: n.title,
      body: detailOf(n.data) ?? n.body,
      url: n.url,
      read: n.readAt !== null,
      created_at: toWire(n.createdAt),
      actor:
        n.actorProfile === null
          ? null
          : { handle: n.handle, display_name: n.displayName, avatar_hue: n.avatarHue },
    })),
    next: more ? toWire(page[page.length - 1]?.createdAt ?? null) : null,
  };
}

export async function unreadCount(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.unreadCount(ctx.db, authed.userId));
  return { unread: rows[0]?.n ?? 0 };
}

export async function markRead(ctx: Ctx, authed: AuthedBatch, ids: readonly string[] | null | undefined) {
  const only = ids && ids.length > 0 ? ids.map((i) => i.toLowerCase()) : null;
  await authed.write(repo.markRead(ctx.db, authed.userId, only, ctx.clock.now()));
  return { ok: true };
}

// ---- preferences ------------------------------------------------------------------------------------------

type PrefRow = Awaited<ReturnType<typeof repo.preferences>>[number];

function preferencesOut(ctx: Ctx, row: PrefRow | undefined) {
  return {
    habit_summary_hour: row?.habitSummaryHour ?? null,
    backup_attachment: row?.backupAttachment ?? false,
    backup_frequency: row?.backupFrequency ?? "monthly",
    categories: Object.entries(CATEGORIES).map(([id, meta]) => ({
      id,
      label: meta.label,
      locked: "locked" in meta && meta.locked,
      ...channelsFor(row?.channels, id, ctx.cfg.emailEnabled),
    })),
    push_available: ctx.cfg.vapid !== null,
    email_available: ctx.cfg.emailEnabled,
  };
}

export async function getPreferences(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.preferences(ctx.db, authed.userId));
  return preferencesOut(ctx, rows[0]);
}

/** Either half may be sent alone; what is left out is kept. Channels merge per category and channel. */
export async function putPreferences(ctx: Ctx, authed: AuthedBatch, body: PreferencesInput) {
  const [, rows] = await authed.read(repo.preferences(ctx.db, authed.userId));
  const current = rows[0];
  const updates: repo.PreferenceUpdates = {};
  if (body.channels !== null && body.channels !== undefined) {
    const merged: Record<string, Record<string, boolean>> = {};
    for (const [cat, chans] of Object.entries(current?.channels ?? {})) merged[cat] = { ...chans };
    for (const [cat, chans] of Object.entries(body.channels)) {
      const meta = categoryMeta(cat);
      if (meta === undefined || meta.locked) continue;
      const target = merged[cat] ?? {};
      // Email off: email choices are ignored, so what was stored before stays for when it comes back.
      for (const k of ctx.cfg.emailEnabled ? (["push", "email"] as const) : (["push"] as const)) {
        const v = chans[k];
        if (v !== undefined) target[k] = v;
      }
      merged[cat] = target;
    }
    updates.channels = merged as Channels;
  }
  if ("habit_summary_hour" in body) updates.habitSummaryHour = body.habit_summary_hour ?? null;
  if (body.backup_attachment !== null && body.backup_attachment !== undefined) {
    updates.backupAttachment = body.backup_attachment;
  }
  if (body.backup_frequency !== null && body.backup_frequency !== undefined) {
    updates.backupFrequency = body.backup_frequency;
  }
  if (Object.keys(updates).length === 0) return preferencesOut(ctx, current);
  await authed.write(repo.upsertPreferences(ctx.db, authed.userId, updates, ctx.clock.now()));
  return preferencesOut(ctx, {
    channels: updates.channels ?? current?.channels ?? {},
    habitSummaryHour:
      updates.habitSummaryHour !== undefined ? updates.habitSummaryHour : (current?.habitSummaryHour ?? null),
    backupAttachment: updates.backupAttachment ?? current?.backupAttachment ?? false,
    backupFrequency: updates.backupFrequency ?? current?.backupFrequency ?? "monthly",
  });
}

// ---- push -------------------------------------------------------------------------------------------------

const PUSH_OFF = "Push is not configured on this server";
export const MAX_SUBSCRIPTIONS = 20;

export function publicKey(ctx: Ctx) {
  if (ctx.cfg.vapid === null) throw notFound(PUSH_OFF);
  return { public_key: ctx.cfg.vapid.publicKey };
}

export async function subscribe(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { endpoint: string; keys: Record<string, string> },
  userAgent: string | undefined,
) {
  if (ctx.cfg.vapid === null) throw notFound(PUSH_OFF);
  const { p256dh, auth } = body.keys;
  const malformed = !p256dh || !auth || p256dh.length > 200 || auth.length > 100; // gitleaks:allow
  if (malformed) {
    throw new HttpError(422, "Malformed subscription");
  }
  // The consumer POSTs to this endpoint later; keep it off our own network (re-checked at send time).
  if (!isSafePushEndpoint(body.endpoint, ctx.cfg.pushHostAllowlist)) {
    throw new HttpError(422, "Unusable push endpoint");
  }
  const [, counted] = await authed.read(repo.subscriptionCount(ctx.db, authed.userId));
  // Counted before the upsert, so re-subscribing a known endpoint at the cap is still refused (Python parity).
  if ((counted[0]?.n ?? 0) >= MAX_SUBSCRIPTIONS) throw conflict("Too many devices subscribed");
  const now = ctx.clock.now();
  await authed.write(
    repo.upsertSubscription(
      ctx.db,
      body.endpoint,
      { userId: authed.userId, p256dh, auth, userAgent: (userAgent ?? "").slice(0, 400) },
      uuid7(now),
      now,
    ),
  );
  return { ok: true };
}

export async function unsubscribePush(ctx: Ctx, authed: AuthedBatch, endpoint: string) {
  await authed.write(repo.deleteOwnSubscription(ctx.db, authed.userId, endpoint));
  return { ok: true };
}

/** Sends a test notification to every device; 5 per 10 minutes. One write round trip. */
export async function pushTest(ctx: Ctx, authed: AuthedBatch) {
  const now = ctx.clock.now();
  const limit = perUser(ctx.db, BUCKETS.pushTest, authed.userId, now);
  const id = uuid7(now);
  const insert = notify(ctx, {
    id,
    userId: authed.userId,
    kind: "test",
    category: "security",
    title: "Notifications are working",
    body: "This is what a PaceStreak nudge looks like.",
    url: "/settings/notifications",
  });
  const [counter, inserted] = await authed.write(
    limit.counter,
    insert,
    repo.dropOverLimit(ctx.db, id, limit.allowed),
  );
  // A rejected call still counts (Python parity); its notification was removed in the same batch.
  limit.check(counter);
  dispatchNotified(ctx, inserted);
  return { ok: true };
}

// ---- email unsubscribe ------------------------------------------------------------------------------------

/** Kept with email off: it only turns email off, and links in mail sent while it was on must keep working. */
export async function emailUnsubscribe(ctx: Ctx, body: EmailUnsubscribeInput) {
  const meta = categoryMeta(body.c);
  if (meta === undefined || meta.locked) throw badRequest("Invalid link");
  const userId = body.u.toLowerCase();
  if (!(await verifyUnsubscribe(ctx, userId, body.c, body.s))) throw badRequest("Invalid link");
  await writeBatch(ctx, [repo.emailOff(ctx.db, userId, body.c, ctx.clock.now())]);
  return { detail: `Done - no more '${meta.label}' emails.` };
}

// ---- delivery ---------------------------------------------------------------------------------------------

/** Builds the monthly backup zip for `data.export_attachment` notes; PROFILE-ACCOUNT registers it. */
export type ExportAttachmentProvider = (ctx: Ctx, userId: string) => Promise<Attachment | null>;
let exportAttachment: ExportAttachmentProvider | null = null;

export function setExportAttachmentProvider(p: ExportAttachmentProvider | null): void {
  exportAttachment = p;
}

const BACKUP_PREFIX =
  "Your PaceStreak data for this month is attached as a zip: everything you've logged, in the same format as " +
  "the export in the app. Keep it somewhere safe. It holds your habits, body, food and journal.\n\n";

type Note = Awaited<ReturnType<typeof repo.pendingNotes>>[number];
type Sub = Awaited<ReturnType<typeof repo.subscriptionsFor>>[number];

async function emailBody(ctx: Ctx, note: Note): Promise<string> {
  const lines = [detailOf(note.data) ?? (note.body || note.title), ""];
  if (note.url) lines.push(`Open PaceStreak: ${ctx.cfg.frontendUrl}${note.url}`, "");
  if (note.category !== "security") {
    const label = categoryMeta(note.category)?.label ?? note.category;
    lines.push(
      "---",
      `You get these because '${label}' email is on.`,
      `Turn it off: ${await unsubscribeLink(ctx, note.userId, note.category)}`,
    );
  }
  return lines.join("\n");
}

function pushPayload(note: Note): string {
  const actions = note.data?.actions;
  return JSON.stringify({
    title: note.title,
    body: note.body ?? "",
    url: note.url || "/",
    tag: note.kind,
    id: note.id,
    // Notification buttons, each with a signed URL the service worker POSTs to.
    actions: Array.isArray(actions) ? actions.slice(0, 2) : [],
  });
}

/** Per-subscription state across the notes of one delivery, so two notes to one device count failures once each. */
interface SubState extends Sub {
  outcome: PushOutcome | null;
}

/**
 * The `deliver` consumer: push and email for undelivered notes among `ids`, then one write batch that applies the
 * push outcomes and sets `delivered_at`. Already delivered ids are skipped, so redelivery is safe. Sending is at
 * least once: a crash between sending and the write sends again on retry.
 */
export async function deliver(ctx: Ctx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  for (let i = 0; i < unique.length; i += 50) {
    const left = await deliverPart(ctx, unique.slice(i, i + 50));
    if (left.length > 0) {
      // Over this invocation's budget: the rest goes to a fresh invocation (its own queries and subrequests).
      await dispatchDeliver(ctx.env.JOBS, [...left, ...unique.slice(i + 50)]);
      return;
    }
  }
}

/** D1 statements a backup note's attachment costs: the packed export read (`exportPacked`). */
export const ATTACHMENT_STATEMENTS = 16;
/** Statements a delivery reserves for its own reads and the closing write batch. */
const DELIVER_OWN_STATEMENTS = 8;

/**
 * Delivers what fits this invocation's budgets, in order, and returns the ids left over (not marked delivered):
 * the Workers Free plan allows 50 subrequests (a push is one, an email one) and 50 D1 queries (a backup note
 * builds the export) per invocation (src/lib/plan.ts). The first note always goes: one note never exceeds either.
 */
async function deliverPart(ctx: Ctx, ids: string[]): Promise<string[]> {
  const [notes, subs, muted] = await runBatch(ctx.db, [
    repo.pendingNotes(ctx.db, ids),
    repo.subscriptionsFor(ctx.db, ids),
    repo.mutedGroupsFor(ctx.db, ids),
  ] as const);
  if (notes.length === 0) return [];
  const now = ctx.clock.now();
  let subrequestsLeft = subrequestBudget(ctx.cfg.plan);
  let statementsLeft = ctx.cfg.d1Budget - ctx.stats.statements - DELIVER_OWN_STATEMENTS;
  const sent: typeof notes = [];
  const left: string[] = [];
  const mutedKeys = new Set(muted.map((m) => `${m.userId}:${m.groupId}`));
  const byUser = new Map<string, SubState[]>();
  for (const s of subs) {
    const list = byUser.get(s.userId) ?? [];
    list.push({ ...s, outcome: null });
    byUser.set(s.userId, list);
  }
  const vapid = ctx.cfg.vapid;
  const signer = vapid === null ? null : createVapidSigner(vapid, () => ctx.clock.now());
  const mailer = createMailer(ctx.cfg, ctx.env, ctx.log);

  for (const note of notes) {
    if (left.length > 0) {
      left.push(note.id);
      continue;
    }
    const channels0 = channelsFor(note.channels, note.category, ctx.cfg.emailEnabled);
    const pushes = channels0.push ? (byUser.get(note.userId) ?? []).length : 0;
    const cost = pushes + (channels0.email ? 1 : 0);
    const reads = note.data?.export_attachment ? ATTACHMENT_STATEMENTS : 0;
    if (sent.length > 0 && (cost > subrequestsLeft || reads > statementsLeft)) {
      left.push(note.id);
      continue;
    }
    subrequestsLeft -= cost;
    statementsLeft -= reads;
    sent.push(note);
    try {
      const groupId = note.data?.group_id;
      if (typeof groupId === "string" && mutedKeys.has(`${note.userId}:${groupId}`)) continue;
      const channels = channelsFor(note.channels, note.category, ctx.cfg.emailEnabled);
      const profile: QuietProfile | null = note.timezone === null ? null : note;
      const quietDay = isQuietDay(profile, note.category, now);
      if (
        channels.push &&
        signer !== null &&
        (note.category === "security" || !inQuietHours(profile, now)) &&
        !quietDay
      ) {
        const payload = pushPayload(note);
        const live = (byUser.get(note.userId) ?? []).filter((s) => s.outcome?.kind !== "delete");
        await Promise.all(
          live.map(async (s) => {
            const failures = s.outcome?.kind === "failed" ? s.outcome.failures : s.failures;
            const outcome = await sendPush(
              { signer, allowlist: ctx.cfg.pushHostAllowlist },
              { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, failures },
              payload,
            );
            s.outcome = outcome;
          }),
        );
      }
      // Quiet hours never hold email back; quiet days do (nudges only).
      // `no_email`: a notice whose news already reached this inbox (a sign-in that was just finished with a mailed code).
      if (
        channels.email &&
        !quietDay &&
        note.isActive &&
        (note.isVerified || note.category === "security") &&
        note.data?.no_email !== true
      ) {
        let text = await emailBody(ctx, note);
        let attachments: Attachment[] | undefined;
        if (note.data?.export_attachment && exportAttachment !== null) {
          const zip = await exportAttachment(ctx, note.userId);
          if (zip !== null && attachmentBytes({ attachments: [zip] }) > 0) {
            attachments = [zip];
            text = BACKUP_PREFIX + text;
          }
        }
        await mailer.send({
          to: note.email,
          subject: note.title,
          text,
          ...(note.category === "security"
            ? {}
            : { headers: await listHeaders(ctx, note.userId, note.category) }),
          ...(attachments === undefined ? {} : { attachments }),
        });
      }
    } catch (err) {
      // One bad note never blocks the rest (Python logged and swallowed per note); it is marked delivered.
      ctx.log.error("delivering notification failed", err, { notificationId: note.id });
    }
  }

  const done = ctx.clock.now();
  const stmts: Stmt[] = [];
  const all = [...byUser.values()].flat();
  const gone = all.filter((s) => s.outcome?.kind === "delete").map((s) => s.id);
  const ok = all.filter((s) => s.outcome?.kind === "delivered").map((s) => s.id);
  for (const part of chunk(gone, 90)) stmts.push(repo.deleteSubscriptions(ctx.db, part));
  for (const part of chunk(ok, 90)) stmts.push(repo.subscriptionsSucceeded(ctx.db, part, done));
  const failed = all.flatMap((s) =>
    s.outcome?.kind === "failed" ? [{ id: s.id, failures: s.outcome.failures }] : [],
  );
  if (failed.length > 0) stmts.push(repo.subscriptionsFailed(ctx.db, failed, done));
  stmts.push(
    repo.markDelivered(
      ctx.db,
      sent.map((n) => n.id),
      done,
    ),
  );
  await runBatch(ctx.db, stmts);
  return left;
}

/**
 * Delivery retry sweep (DESIGN.md §9, the five-minute trigger; JOBS-12 registers it): re-enqueues notes still undelivered
 * after two minutes, at most five times each, up to 500 per run. Returns how many it re-enqueued.
 */
export async function retryUndelivered(ctx: Ctx): Promise<number> {
  const [claimed] = await writeBatch(ctx, [repo.claimRetries(ctx.db, ctx.clock.now())]);
  const ids = claimed.map((r) => r.id);
  if (ids.length > 0) await dispatchDeliver(ctx.env.JOBS, ids);
  return ids.length;
}

/** Registers the `deliver` consumer. Called once from the Worker entry. */
export function registerConsumers(registry: ConsumerRegistry): void {
  registry.register("deliver", (ctx, msg) => deliver(ctx, msg.ids));
}
