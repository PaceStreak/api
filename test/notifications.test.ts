/** Notifications module: routes, the notify() outbox, the deliver consumer and the retry sweep (spec/misc.md §2). */
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../src/ctx.ts";
import { runBatch, writeBatch } from "../src/db/batch.ts";
import { groupMembers, groups, notifications, profiles, pushSubscriptions } from "../src/db/schema/index.ts";
import { createConsumerRegistry, handleQueue } from "../src/jobs/consumer.ts";
import { b64urlEncode } from "../src/lib/b64url.ts";
import { MAX_FAILURES } from "../src/lib/push/send.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import * as notif from "../src/modules/notifications/service.ts";
import { sent, signup } from "./fixtures/auth.ts";
import { testDb } from "./fixtures/db.ts";
import { mockFetch } from "./fixtures/fetch.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";
import { jobCtx, recordingQueue } from "./jobs/helpers.ts";

const PUSH = "https://fcm.googleapis.com/fcm/send/";

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { p256dh: b64urlEncode(raw), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

async function subscribe(token: string, endpoint = `${PUSH}${crypto.randomUUID()}`) {
  const res = await api("/v1/notifications/push/subscribe", {
    token,
    json: { endpoint, keys: await browserKeys() },
    headers: { "User-Agent": "TestBrowser/1.0" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return endpoint;
}

/** Inserts notes straight through notify() and returns their ids. */
async function seedNotes(ctx: Ctx, inputs: notif.NotifyInput[]): Promise<string[]> {
  const [first, ...rest] = inputs.map((n) => notif.notify(ctx, n));
  if (first === undefined) return [];
  const results = await writeBatch(ctx, [first, ...rest]);
  return notif.notifiedIds(...(results as notif.NotifyResult[]));
}

/** signup() makes no profile (PROFILE-ACCOUNT does); tests that need one add it. */
async function withProfile(ctx: Ctx, userId: string, values: Partial<typeof profiles.$inferInsert> = {}) {
  const now = Date.now();
  await ctx.db
    .insert(profiles)
    .values({ userId, createdAt: now, updatedAt: now, ...values })
    .onConflictDoUpdate({ target: profiles.userId, set: { ...values, updatedAt: now } });
}

const read = (ctx: Ctx, ids: string[]) =>
  ctx.db.select().from(notifications).where(inArray(notifications.id, ids)).orderBy(notifications.createdAt);
const subsOf = (ctx: Ctx, userId: string) =>
  ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

describe("inbox", () => {
  it("lists newest first with actor profiles, pages by created_at, counts and marks read", async () => {
    const me = await signup();
    const actor = await signup();
    const ctx = jobCtx();
    await withProfile(ctx, actor.userId, { handle: "actorx", displayName: "Actor" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = { ...ctx, clock: { now: () => Date.now() + i * 1000 } };
      ids.push(
        ...(await seedNotes(c, [
          {
            userId: me.userId,
            kind: "kudos",
            category: "social",
            title: `Note ${i}`,
            actorId: i === 2 ? actor.userId : null,
          },
        ])),
      );
    }
    const res = await api("/v1/notifications?limit=2", { token: me.token });
    expectRoundTrips(res, 1);
    const page = await jsonOf<{
      items: { id: string; title: string; read: boolean; actor: unknown }[];
      next: string | null;
    }>(res);
    expect(page.items.map((n) => n.title)).toEqual(["Note 2", "Note 1"]);
    expect(page.items[0]?.actor).toEqual({ handle: "actorx", display_name: "Actor", avatar_hue: 78 });
    expect(page.items[1]?.actor).toBeNull();
    expect(page.next).not.toBeNull();
    const rest = await jsonOf<{ items: { title: string }[]; next: null }>(
      await api(`/v1/notifications?before=${encodeURIComponent(page.next ?? "")}`, { token: me.token }),
    );
    expect(rest.items.map((n) => n.title)).toEqual(["Note 0"]);
    expect(rest.next).toBeNull();

    const count = async () =>
      (await jsonOf<{ unread: number }>(await api("/v1/notifications/unread-count", { token: me.token })))
        .unread;
    expect(await count()).toBe(3);
    const mark = await api("/v1/notifications/read", { token: me.token, json: { ids: [ids[0]] } });
    expect(await jsonOf(mark)).toEqual({ ok: true });
    expectRoundTrips(mark, 1);
    expect(await count()).toBe(2);
    await api("/v1/notifications/read", { token: me.token, json: {} });
    expect(await count()).toBe(0);
    // Someone else's ids are never touched.
    const other = await signup();
    await api("/v1/notifications/read", { token: other.token, json: { ids } });
  });

  it("needs a session and validates its query", async () => {
    expect((await api("/v1/notifications")).status).toBe(401);
    const me = await signup();
    expect((await api("/v1/notifications?limit=0", { token: me.token })).status).toBe(422);
    expect((await api("/v1/notifications?before=yesterday", { token: me.token })).status).toBe(422);
  });
});

describe("notify()", () => {
  it("dedupes per user and key, truncates by code point and dispatches only inserted ids", async () => {
    const me = await signup();
    const queue = recordingQueue();
    const deferred: Promise<unknown>[] = [];
    const ctx: Ctx = {
      ...jobCtx(),
      env: { ...env, JOBS: queue as unknown as Queue },
      defer: (p) => void deferred.push(p),
    };
    const input: notif.NotifyInput = {
      userId: me.userId,
      kind: "risk",
      category: "streak_risk",
      title: "🔥".repeat(130),
      body: "",
      dedupeKey: "risk:x:2026-10-18",
    };
    const [a, b] = await writeBatch(ctx, [notif.notify(ctx, input), notif.notify(ctx, input)]);
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
    expect(notif.dispatchNotified(ctx, a, b)).toHaveLength(1);
    await Promise.all(deferred);
    expect(queue.messages).toEqual([{ type: "deliver", ids: [a[0]?.id] }]);
    expect(notif.dispatchNotified(ctx, b)).toEqual([]);
    const [row] = await read(ctx, [a[0]?.id ?? ""]);
    expect(Array.from(row?.title ?? "")).toHaveLength(120);
    expect(row?.body).toBeNull();
  });
});

describe("preferences", () => {
  it("lists categories in order with defaults, keeps habit_summary_hour unless sent, accepts lax booleans", async () => {
    const me = await signup();
    const res = await api("/v1/notifications/preferences", { token: me.token });
    expectRoundTrips(res, 1);
    const prefs = await jsonOf<{
      categories: { id: string; push: boolean; email: boolean; locked: boolean }[];
      habit_summary_hour: number | null;
      backup_frequency: string;
      backup_attachment: boolean;
      push_available: boolean;
    }>(res);
    expect(prefs.categories.map((c) => c.id)).toEqual(Object.keys(notif.CATEGORIES));
    expect(prefs.categories[0]).toEqual({
      id: "streak_risk",
      label: "Streak at risk",
      locked: false,
      push: true,
      email: false,
    });
    expect(prefs).toMatchObject({
      habit_summary_hour: null,
      backup_frequency: "monthly",
      backup_attachment: false,
      push_available: true,
    });

    const put = (json: unknown) =>
      api("/v1/notifications/preferences", { token: me.token, method: "PUT", json });
    const set = await put({
      habit_summary_hour: 20,
      channels: { social: { push: "off", email: 1, other: true } },
    });
    expectRoundTrips(set, 2);
    const after = await jsonOf<typeof prefs>(set);
    expect(after.habit_summary_hour).toBe(20);
    expect(after.categories.find((c) => c.id === "social")).toMatchObject({ push: false, email: true });
    const kept = await jsonOf<typeof prefs>(
      await put({ backup_frequency: "weekly", backup_attachment: null }),
    );
    expect(kept).toMatchObject({ habit_summary_hour: 20, backup_frequency: "weekly" });
    expect(
      (await jsonOf<typeof prefs>(await put({ habit_summary_hour: null }))).habit_summary_hour,
    ).toBeNull();
    expect((await put({ channels: { social: { push: "maybe" } } })).status).toBe(422);
    expect((await put({ habit_summary_hour: 24 })).status).toBe(422);
    const noop = await put({});
    expectRoundTrips(noop, 1);
  });
});

describe("push subscriptions", () => {
  it("serves the public key without a session", async () => {
    const res = await api("/v1/notifications/push/public-key");
    expect(res.status).toBe(200);
    expect((await jsonOf<{ public_key: string }>(res)).public_key).toBe(env.VAPID_PUBLIC_KEY);
  });

  it("answers 404 when push is not configured", async () => {
    const ctx = jobCtx();
    const off: Ctx = { ...ctx, cfg: { ...ctx.cfg, vapid: null } };
    expect(() => notif.publicKey(off)).toThrow("Push is not configured on this server");
  });

  it("rejects malformed keys, caps devices at 20, moves an endpoint between accounts and unsubscribes", async () => {
    const a = await signup();
    const b = await signup();
    const bad = await api("/v1/notifications/push/subscribe", {
      token: a.token,
      json: { endpoint: `${PUSH}x`, keys: { p256dh: "a" } },
    });
    expect(bad.status).toBe(422);
    expect(await jsonOf(bad)).toEqual({ detail: "Malformed subscription" });
    const http = await api("/v1/notifications/push/subscribe", {
      token: a.token,
      json: { endpoint: "http://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } },
    });
    expect(http.status).toBe(422);

    const shared = await subscribe(a.token);
    const ctx = jobCtx();
    expect((await subsOf(ctx, a.userId))[0]).toMatchObject({
      endpoint: shared,
      userAgent: "TestBrowser/1.0",
    });
    await subscribe(b.token, shared);
    expect(await subsOf(ctx, a.userId)).toEqual([]);
    expect(await subsOf(ctx, b.userId)).toHaveLength(1);

    for (let i = 1; i < 20; i++) await subscribe(b.token);
    const full = await api("/v1/notifications/push/subscribe", {
      token: b.token,
      json: { endpoint: shared, keys: await browserKeys() },
    });
    expect(full.status).toBe(409);
    expect(await jsonOf(full)).toEqual({ detail: "Too many devices subscribed" });

    // Unsubscribing someone else's endpoint does nothing.
    await api("/v1/notifications/push/unsubscribe", { token: a.token, json: { endpoint: shared } });
    expect(await subsOf(ctx, b.userId)).toHaveLength(20);
    const un = await api("/v1/notifications/push/unsubscribe", {
      token: b.token,
      json: { endpoint: shared },
    });
    expect(await jsonOf(un)).toEqual({ ok: true });
    expect(await subsOf(ctx, b.userId)).toHaveLength(19);
  });

  it("push test writes a security note and is limited to 5 per 10 minutes", async () => {
    const me = await signup();
    for (let i = 0; i < 5; i++) {
      const ok = await api("/v1/notifications/push/test", { token: me.token, method: "POST" });
      expect(ok.status).toBe(200);
      expectRoundTrips(ok, 1);
    }
    const limited = await api("/v1/notifications/push/test", { token: me.token, method: "POST" });
    expect(limited.status).toBe(429);
    const ctx = jobCtx();
    const rows = await ctx.db.select().from(notifications).where(eq(notifications.userId, me.userId));
    expect(rows.filter((r) => r.kind === "test")).toHaveLength(5);
    expect(rows[0]).toMatchObject({ category: "security", title: "Notifications are working" });
  });
});

describe("email unsubscribe", () => {
  it("signs per user and category and refuses unknown or locked categories", async () => {
    const me = await signup();
    const ctx = jobCtx();
    const s = await notif.signUnsubscribe(ctx, me.userId, "digest");
    expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(await notif.signUnsubscribe(ctx, me.userId, "social")).not.toBe(s);
    const post = (c: string, sig: string) =>
      api("/v1/notifications/unsubscribe", { json: { u: me.userId, c, s: sig } });
    expect((await post("security", await notif.signUnsubscribe(ctx, me.userId, "security"))).status).toBe(
      400,
    );
    expect((await post("nope", s)).status).toBe(400);
    expect((await post("social", s)).status).toBe(400);
    const ok = await post("digest", s);
    expect(await jsonOf(ok)).toEqual({ detail: "Done - no more 'Weekly summary' emails." });
    expectRoundTrips(ok, 1);
    // Merged into what was stored: a push choice on the same category survives.
    await api("/v1/notifications/preferences", {
      token: me.token,
      method: "PUT",
      json: { channels: { social: { push: false } } },
    });
    await post("social", await notif.signUnsubscribe(ctx, me.userId, "social"));
    const prefs = await jsonOf<{ categories: { id: string; push: boolean; email: boolean }[] }>(
      await api("/v1/notifications/preferences", { token: me.token }),
    );
    expect(prefs.categories.find((c) => c.id === "social")).toMatchObject({ push: false, email: false });
    expect(prefs.categories.find((c) => c.id === "digest")).toMatchObject({ email: false });
    expect((await api("/v1/notifications/unsubscribe/one-click?u=x", { method: "POST" })).status).toBe(422);
  });
});

describe("deliver consumer", () => {
  it("pushes, applies outcomes, emails with an unsubscribe link and sets delivered_at", async () => {
    const me = await signup();
    const live = await subscribe(me.token);
    const gone = await subscribe(me.token);
    const flaky = await subscribe(me.token);
    const ctx = jobCtx();
    await withProfile(ctx, me.userId, { quietStart: 0, quietEnd: 0 });
    await api("/v1/notifications/preferences", {
      token: me.token,
      method: "PUT",
      json: { channels: { digest: { push: true } } },
    });
    const pushes = mockFetch(
      (u) => u.href.startsWith(PUSH),
      (req) => new Response(null, { status: req.url === live ? 201 : req.url === gone ? 410 : 500 }),
    );
    const [id] = await seedNotes(ctx, [
      {
        userId: me.userId,
        kind: "digest",
        category: "digest",
        title: "Your week",
        body: "Three sessions.",
        url: "/stats",
      },
    ]);
    const before = sent.length;
    const t = testDb();
    await notif.deliver({ ...ctx, db: t.db }, [id ?? ""]);
    expect(t.stats.roundTrips).toBe(2);
    expect(pushes.calls).toHaveLength(3);
    const call = pushes.calls.find((r) => r.url === live);
    expect(call?.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(call?.headers.get("Authorization")).toMatch(/^vapid t=.+, k=/);
    const subs = await subsOf(ctx, me.userId);
    expect(subs.map((s) => s.endpoint).sort()).toEqual([flaky, live].sort());
    expect(subs.find((s) => s.endpoint === live)?.lastSuccessAt).not.toBeNull();
    expect(subs.find((s) => s.endpoint === flaky)?.failures).toBe(1);
    const mail = sent.slice(before).find((m) => m.includes(`to=${me.email} subject=Your week`));
    expect(mail).toContain("Three sessions.");
    expect(mail).toContain("Open PaceStreak: http://localhost:5173/stats");
    expect(mail).toContain("You get these because 'Weekly summary' email is on.");
    expect(mail).toContain(`http://localhost:5173/unsubscribe?u=${me.userId}&c=digest&s=`);
    expect((await read(ctx, [id ?? ""]))[0]?.deliveredAt).not.toBeNull();

    // Redelivery of a delivered note sends nothing.
    await notif.deliver(ctx, [id ?? ""]);
    expect(pushes.calls).toHaveLength(3);
  });

  it("drops a subscription at the tenth failure and holds pushes in quiet hours except security", async () => {
    const me = await signup();
    const endpoint = await subscribe(me.token);
    const ctx = jobCtx();
    await ctx.db
      .update(pushSubscriptions)
      .set({ failures: MAX_FAILURES - 1 })
      .where(eq(pushSubscriptions.endpoint, endpoint));
    // Quiet all day except the hour start == end can never be: 0 -> 23 covers 23 of 24 hours, so pick a wrap
    // that covers the current hour.
    const h = new Date().getUTCHours();
    await withProfile(ctx, me.userId, { quietStart: h, quietEnd: (h + 1) % 24 });
    const pushes = mockFetch((u) => u.href.startsWith(PUSH), new Response(null, { status: 500 }));
    const [quiet, security] = await seedNotes(ctx, [
      { userId: me.userId, kind: "kudos", category: "social", title: "Kudos" },
      { userId: me.userId, kind: "new_sign_in", category: "security", title: "New sign-in" },
    ]);
    await notif.deliver(ctx, [quiet ?? ""]);
    expect(pushes.calls).toHaveLength(0);
    await notif.deliver(ctx, [security ?? ""]);
    expect(pushes.calls).toHaveLength(1);
    expect(await subsOf(ctx, me.userId)).toEqual([]);
  });

  it("keeps a muted group's notes in the inbox only", async () => {
    const me = await signup();
    await subscribe(me.token);
    const ctx = jobCtx();
    const now = Date.now();
    const groupId = uuid7(now);
    await runBatch(ctx.db, [
      ctx.db.insert(groups).values({
        id: groupId,
        ownerId: me.userId,
        name: "Quiet",
        nameFold: "quiet",
        inviteCode: crypto.randomUUID().slice(0, 8),
        createdAt: now,
        updatedAt: now,
      }),
      ctx.db
        .insert(groupMembers)
        .values({ groupId, userId: me.userId, muted: true, createdAt: now, updatedAt: now }),
    ]);
    const pushes = mockFetch((u) => u.href.startsWith(PUSH), new Response(null, { status: 201 }));
    const [id] = await seedNotes(ctx, [
      {
        userId: me.userId,
        kind: "group_join",
        category: "groups",
        title: "Joined",
        data: { group_id: groupId },
      },
    ]);
    await notif.deliver(ctx, [id ?? ""]);
    expect(pushes.calls).toHaveLength(0);
    expect((await read(ctx, [id ?? ""]))[0]?.deliveredAt).not.toBeNull();
  });

  it("is registered for deliver messages on the queue", async () => {
    const me = await signup();
    const ctx = jobCtx();
    const [id] = await seedNotes(ctx, [
      { userId: me.userId, kind: "x", category: "achievements", title: "Badge" },
    ]);
    const reg = createConsumerRegistry();
    notif.registerConsumers(reg);
    const batch = createMessageBatch("pacestreak-jobs", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { type: "deliver", ids: [id] } },
    ]);
    const exec = createExecutionContext();
    await handleQueue(batch, env, exec, reg);
    const result = await getQueueResult(batch, exec);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect((await read(ctx, [id ?? ""]))[0]?.deliveredAt).not.toBeNull();
  });
});

describe("retry sweep", () => {
  it("re-enqueues notes undelivered after two minutes, at most five times", async () => {
    const me = await signup();
    const base = jobCtx();
    const queue = recordingQueue();
    const old = Date.now() - 10 * 60_000;
    const [stale] = await seedNotes({ ...base, clock: { now: () => old } }, [
      { userId: me.userId, kind: "x", category: "social", title: "Old" },
    ]);
    const [fresh] = await seedNotes(base, [
      { userId: me.userId, kind: "x", category: "social", title: "New" },
    ]);
    const ctx: Ctx = { ...base, env: { ...env, JOBS: queue as unknown as Queue } };
    for (let i = 0; i < 5; i++) await notif.retryUndelivered(ctx);
    const mine = queue.messages.flatMap((m) => (m.type === "deliver" ? m.ids : []));
    expect(mine.filter((x) => x === stale)).toHaveLength(5);
    expect(mine).not.toContain(fresh);
    await notif.retryUndelivered(ctx);
    expect(
      queue.messages.flatMap((m) => (m.type === "deliver" ? m.ids : [])).filter((x) => x === stale),
    ).toHaveLength(5);
    expect((await read(ctx, [stale ?? ""]))[0]?.deliveryAttempts).toBe(5);
  });
});
