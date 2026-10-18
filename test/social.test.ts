/**
 * SOCIAL unit: the privacy rule on every social surface, D1 round-trip budgets, the challenge resolution job, and the
 * intentional changes from the Python service (each `changed:` test is listed in CHANGES-FROM-PYTHON.md).
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  activityEvents,
  challengeParticipants,
  challenges,
  groupMembers,
  groups,
  notifications,
  profiles,
} from "../src/db/schema/index.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import { rebuild } from "../src/modules/game/service.ts";
import { resolveFinished } from "../src/modules/groups/service.ts";
import { testDb } from "./fixtures/db.ts";
import { seedHeavyUser } from "./fixtures/heavy-user.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";
import { type Onboarded, person } from "./fixtures/profile.ts";
import { get, type Json, logSession } from "./fixtures/training.ts";
import { jobCtx } from "./jobs/helpers.ts";

const { db } = testDb();
const call = (token: string, method: string, path: string, json?: unknown) =>
  api(path, { token, method, ...(json === undefined ? {} : { json }) });
const post = (token: string, path: string, json?: unknown) => call(token, "POST", path, json);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Two followers of each other in one coaching group, buddies, in a challenge; `a` owns the group. */
async function crew(prefix: string) {
  const a = await person(`${prefix}a`);
  const b = await person(`${prefix}b`);
  await post(a.token, `/v1/people/${b.handle}/follow`);
  await post(b.token, `/v1/people/${a.handle}/follow`);
  const group = await jsonOf<Json>(
    await post(a.token, "/v1/groups", { name: `${prefix} crew`, kind: "coaching" }),
  );
  await post(b.token, "/v1/groups/join", { code: group.invite_code });
  await call(b.token, "PATCH", `/v1/groups/${group.id}/me`, { shares_with_coach: true });
  const pair = await jsonOf<Json>(await post(a.token, "/v1/buddies", { handle: b.handle }));
  await post(b.token, `/v1/buddies/${pair.id}/accept`);
  const day = today();
  const challenge = await jsonOf<Json>(
    await post(a.token, "/v1/challenges", {
      title: `${prefix} days`,
      starts_on: day,
      ends_on: addDays(day, 6),
      target: 1,
    }),
  );
  await post(b.token, "/v1/challenges/join", { code: challenge.invite_code });
  return { a, b, group, pair, challenge };
}

describe("privacy: habits never reach a social surface", () => {
  it("a habit's name, amounts, notes and slips appear on no feed, profile, group, board or buddy view", async () => {
    const { a, b, group, challenge } = await crew("priv");
    const secret = "Zyxquit secret drink";
    const note = "Qwvnote relapsed twice";
    const habit = await jsonOf<Json>(await post(b.token, "/v1/habits", { name: secret, kind: "quit" }));
    await call(b.token, "PUT", `/v1/habits/${habit.id}/days/${today()}`, { amount: 3, note });
    const done = await jsonOf<Json>(await post(b.token, "/v1/habits", { name: "Zyxcheck daily stretch" }));
    await call(b.token, "PUT", `/v1/habits/${done.id}/days/${today()}`, { amount: 1 });
    await logSession(b.token, { title: "Easy run" });
    const event = (await get(a.token, "/v1/feed")).events.find((e: Json) => e.kind === "workout");
    expect(event).toBeDefined();

    const surfaces = [
      "/v1/feed",
      `/v1/people/${b.handle}`,
      `/v1/people/${b.handle}/events`,
      `/v1/people/${b.handle}/followers`,
      `/v1/people/${b.handle}/following`,
      `/v1/people/search?q=${b.handle}`,
      "/v1/people/suggested",
      `/v1/events/${event.id}`,
      `/v1/events/${event.id}/comments`,
      "/v1/groups",
      `/v1/groups/${group.id}`,
      `/v1/groups/${group.id}/feed`,
      `/v1/groups/${group.id}/coach`,
      `/v1/groups/${group.id}/announcements`,
      "/v1/coaching",
      "/v1/challenges",
      `/v1/challenges/${challenge.id}`,
      "/v1/buddies",
      `/v1/leaderboards/consistency?scope=group&group_id=${group.id}`,
      "/v1/leaderboards/streak?scope=following",
    ];
    for (const path of surfaces) {
      const res = await api(path, { token: a.token });
      expect(res.status, path).toBe(200);
      const text = (await res.text()).toLowerCase();
      for (const word of ["zyxquit", "zyxcheck", "qwvnote", "habit", "slip"])
        expect(text, `${path}: ${word}`).not.toContain(word);
    }
  });
});

describe("round-trip budgets", () => {
  it("social reads are one round trip; writes are a read and a write", async () => {
    const { a, b, group, pair, challenge } = await crew("rt");
    await logSession(b.token);
    const event = (await get(a.token, "/v1/feed")).events.find((e: Json) => e.kind === "workout");
    const budgets: [string, string, number, unknown?][] = [
      ["GET", "/v1/feed", 1],
      ["GET", `/v1/people/${b.handle}/events`, 1],
      ["GET", `/v1/people/${b.handle}/followers`, 1],
      ["GET", "/v1/people/search?q=rt", 1],
      ["GET", "/v1/people/suggested", 1],
      ["GET", "/v1/me/follow-requests", 1],
      ["GET", "/v1/me/blocks", 1],
      ["GET", `/v1/events/${event.id}`, 1],
      ["GET", `/v1/events/${event.id}/comments`, 1],
      ["POST", `/v1/events/${event.id}/kudos`, 2, { reaction: "fire" }],
      ["DELETE", `/v1/events/${event.id}/kudos`, 1],
      ["POST", `/v1/events/${event.id}/comments`, 2, { body: "nice" }],
      ["POST", "/v1/reports", 2, { target_type: "user", target_id: b.handle, reason: "spam" }],
      ["GET", "/v1/buddies", 1],
      ["GET", "/v1/groups", 1],
      ["GET", `/v1/groups/${group.id}`, 1],
      ["GET", `/v1/groups/${group.id}/feed`, 1],
      ["GET", `/v1/groups/${group.id}/announcements`, 1],
      ["POST", `/v1/groups/${group.id}/announcements`, 2, { body: "Sunday long run" }],
      ["PATCH", `/v1/groups/${group.id}/me`, 1, { muted: true }],
      ["GET", `/v1/groups/${group.id}/coach`, 2],
      ["GET", "/v1/coaching", 2],
      ["GET", "/v1/challenges", 1],
      ["GET", `/v1/challenges/${challenge.id}`, 1],
      ["POST", `/v1/challenges/${challenge.id}/leave`, 1],
      ["POST", `/v1/challenges/${challenge.id}/join`, 2],
      ["POST", `/v1/people/${b.handle}/encourage`, 2, { preset: "proud" }],
    ];
    for (const [method, path, max, body] of budgets) {
      const res = await call(a.token, method, path, body);
      expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBeLessThan(300);
      expectRoundTrips(res, max);
    }
    // The person page reads the card first, then the snapshot.
    expectRoundTrips(await api(`/v1/people/${b.handle}`, { token: a.token }), 2);
    // Follow, unfollow and block.
    const c = await person("rtc");
    let res = await post(a.token, `/v1/people/${c.handle}/follow`);
    expectRoundTrips(res, 2);
    res = await call(a.token, "DELETE", `/v1/people/${c.handle}/follow`);
    expect(res.status).toBe(204);
    expectRoundTrips(res, 1);
    res = await post(a.token, `/v1/people/${c.handle}/block`);
    expectRoundTrips(res, 2);
    res = await post(b.token, `/v1/buddies/${pair.id}/end`);
    expect(res.status).toBe(204);
    expectRoundTrips(res, 1);
    // Group create and join are a read and a write.
    res = await post(c.token, "/v1/groups", { name: "Third" });
    expectRoundTrips(res, 2);
    res = await post(b.token, "/v1/groups/join", { code: (await jsonOf<Json>(res)).invite_code });
    expectRoundTrips(res, 2);
  });

  it("a coach view costs two round trips however many members share", async () => {
    const coach = await person("rtcoach");
    const g = await jsonOf<Json>(await post(coach.token, "/v1/groups", { name: "Roster", kind: "coaching" }));
    for (let i = 0; i < 4; i++) {
      const m: Onboarded = await person(`rtmember${i}`);
      await post(m.token, "/v1/groups/join", { code: g.invite_code });
      await call(m.token, "PATCH", `/v1/groups/${g.id}/me`, { shares_with_coach: true });
      await logSession(m.token);
    }
    const res = await api(`/v1/groups/${g.id}/coach`, { token: coach.token });
    expect((await jsonOf<Json>(res.clone())).members.length).toBe(4);
    expectRoundTrips(res, 2);
  });
});

describe("challenges", () => {
  it("resolution freezes scores, tells everyone once and posts the completed to their feed", async () => {
    const { a, b, challenge } = await crew("res");
    await logSession(b.token);
    const ctx = jobCtx();
    const later = addDays(today(), 8);
    const ids = await resolveFinished(ctx, later);
    expect(ids.length).toBeGreaterThanOrEqual(2); // other challenges in this file end too
    const parts = await db
      .select()
      .from(challengeParticipants)
      .where(eq(challengeParticipants.challengeId, challenge.id));
    const byUser = new Map(parts.map((p) => [p.userId, p]));
    expect(byUser.get(b.userId)).toMatchObject({ finalScore: 1, finalRank: 1, completed: true });
    expect(byUser.get(a.userId)).toMatchObject({ finalScore: 0, finalRank: 2, completed: false });
    const [row] = await db.select().from(challenges).where(eq(challenges.id, challenge.id));
    expect(row?.resolvedAt).not.toBeNull();
    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.refKey, `challenge:${challenge.id}`));
    expect(events.map((e) => e.userId)).toEqual([b.userId]);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, `challenge_done:${challenge.id}`));
    expect(notes.find((n) => n.userId === b.userId)?.title).toBe("res days is over - you placed #1");
    expect(notes.find((n) => n.userId === b.userId)?.body).toBe("1 active days.");
    expect(await resolveFinished(ctx, later)).toEqual([]);
    const board = await get(a.token, `/v1/challenges/${challenge.id}`);
    expect(board.status).toBe("finished");
    expect(board.leaderboard.map((r: Json) => [r.handle, r.score, r.rank])).toEqual([
      ["resb", 1, 1],
      ["resa", 0, 2],
    ]);
  });

  it("weekly_target counts kept weeks of the main chain inside the window", async () => {
    const a = await person("wta");
    await logSession(a.token);
    const day = today();
    const c = await jsonOf<Json>(
      await post(a.token, "/v1/challenges", {
        title: "Keep weeks",
        kind: "weekly_target",
        starts_on: day,
        ends_on: addDays(day, 27),
      }),
    );
    const board = (await get(a.token, `/v1/challenges/${c.id}`)).leaderboard;
    // One session is not a kept week yet (target 3): this week is open.
    expect(board.map((r: Json) => r.score)).toEqual([0]);
  });
});

describe("changed from Python", () => {
  it("changed: GET /events/{id} reports the real comment count (Python's fallback said 0)", async () => {
    const a = await person("chga");
    const b = await person("chgb");
    await post(b.token, `/v1/people/${a.handle}/follow`);
    await logSession(a.token);
    const event = (await get(b.token, "/v1/feed")).events.find((e: Json) => e.kind === "workout");
    await post(b.token, `/v1/events/${event.id}/comments`, { body: "one" });
    await post(b.token, `/v1/events/${event.id}/comments`, { body: "two" });
    expect((await get(b.token, `/v1/events/${event.id}`)).comments).toBe(2);
  });

  it("changed: the group feed counts comments and reactions, and refuses a malformed cursor with 422", async () => {
    const a = await person("gfa");
    const g = await jsonOf<Json>(await post(a.token, "/v1/groups", { name: "Feeders" }));
    await logSession(a.token);
    const event = (await get(a.token, `/v1/groups/${g.id}/feed`)).events[0];
    await post(a.token, `/v1/events/${event.id}/comments`, { body: "self note" });
    await post(a.token, `/v1/events/${event.id}/kudos`, { reaction: "star" });
    const again = (await get(a.token, `/v1/groups/${g.id}/feed`)).events[0];
    expect([again.comments, again.reactions, again.my_reaction]).toEqual([1, { star: 1 }, "star"]);
    expect((await api(`/v1/groups/${g.id}/feed?before=garbage`, { token: a.token })).status).toBe(422);
  });

  it("changed: a suggested plan without a note gets the default text (Python raised a 500)", async () => {
    const coach = await person("nonote");
    const athlete = await person("nonotea");
    const g = await jsonOf<Json>(await post(coach.token, "/v1/groups", { name: "Block", kind: "coaching" }));
    await post(athlete.token, "/v1/groups/join", { code: g.invite_code });
    await call(athlete.token, "PATCH", `/v1/groups/${g.id}/me`, { shares_with_coach: true });
    const res = await post(coach.token, `/v1/groups/${g.id}/members/${athlete.userId}/plan`, {
      plan_template_id: "plan-5k-to-10k",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const note = (await get(athlete.token, "/v1/notifications")).items.find(
      (n: Json) => n.kind === "plan_assigned",
    );
    expect(note.body).toBe("It's in your plans. Start it when you're ready, or not at all.");
  });

  it("changed: the coaching overview leaves hidden groups out instead of failing with 404", async () => {
    const coach = await person("hidco");
    const m = await person("hidm");
    const g1 = await jsonOf<Json>(await post(coach.token, "/v1/groups", { name: "Alpha", kind: "coaching" }));
    const g2 = await jsonOf<Json>(await post(coach.token, "/v1/groups", { name: "Beta", kind: "coaching" }));
    for (const g of [g1, g2]) {
      await post(m.token, "/v1/groups/join", { code: g.invite_code });
      await call(m.token, "PATCH", `/v1/groups/${g.id}/me`, { shares_with_coach: true });
    }
    await db.update(groups).set({ hiddenAt: Date.now() }).where(eq(groups.id, g2.id));
    const overview = await get(coach.token, "/v1/coaching");
    expect(overview.groups.map((g: Json) => g.name)).toEqual(["Alpha"]);
    expect(overview.people[0].groups.map((g: Json) => g.name)).toEqual(["Alpha"]);
  });

  it("changed: people search matches handle and display-name prefixes, case- and accent-insensitively", async () => {
    const me = await person("finder");
    await person("zoeprefix", { display_name: "Zoë Ångström" });
    const names = async (q: string) =>
      ((await get(me.token, `/v1/people/search?q=${encodeURIComponent(q)}`)) as Json[]).map((p) => p.handle);
    expect(await names("ZOEPRE")).toEqual(["zoeprefix"]);
    expect(await names("zoe ang")).toEqual(["zoeprefix"]);
    expect(await names("@zoepr")).toEqual(["zoeprefix"]);
    expect(await names("ngstr")).toEqual([]); // a display-name substring is not a prefix
    expect(await names("%")).not.toContain("finder");
  });

  it("changed: a group name that cleans to nothing is a 422, and an explicit null name is ignored", async () => {
    const a = await person("namer");
    expect((await post(a.token, "/v1/groups", { name: "​​​" })).status).toBe(422);
    const g = await jsonOf<Json>(await post(a.token, "/v1/groups", { name: "Named" }));
    const res = await call(a.token, "PATCH", `/v1/groups/${g.id}`, { name: null, description: "  hi  " });
    expect(res.status).toBe(200);
    const after = await get(a.token, `/v1/groups/${g.id}`);
    expect([after.name, after.description]).toEqual(["Named", "hi"]);
  });
});

describe("groups", () => {
  it("roles: hand over ownership, admins manage members, the owner cannot leave", async () => {
    const o = await person("rolo");
    const m = await person("rolm");
    const g = await jsonOf<Json>(await post(o.token, "/v1/groups", { name: "Roles" }));
    await post(m.token, "/v1/groups/join", { code: g.invite_code });
    expect((await post(o.token, `/v1/groups/${g.id}/leave`)).status).toBe(409);
    const promote = await call(o.token, "PATCH", `/v1/groups/${g.id}/members/${m.userId}`, { role: "owner" });
    expect(await jsonOf(promote)).toEqual({ role: "owner" });
    const detail = await get(o.token, `/v1/groups/${g.id}`);
    expect(detail.my_role).toBe("admin");
    expect((await call(o.token, "DELETE", `/v1/groups/${g.id}/members/${m.userId}`)).status).toBe(403);
    expect((await post(o.token, `/v1/groups/${g.id}/leave`)).status).toBe(204);
    expect((await api(`/v1/groups/${g.id}`, { token: o.token })).status).toBe(404);
    const rotated = await jsonOf<Json>(await post(m.token, `/v1/groups/${g.id}/invite/rotate`));
    expect(rotated.invite_code).toMatch(/^[a-hjkmnp-z2-9]{8}$/);
    expect((await call(m.token, "DELETE", `/v1/groups/${g.id}`)).status).toBe(204);
  });
});

describe("heavy user", () => {
  it("a person page and a coach view stay at two round trips on five years of history", async () => {
    const data = await seedHeavyUser();
    const hid = data.users[0]?.id as string;
    await db
      .update(profiles)
      .set({ handle: "heavyone", handleFold: "heavyone", birthYear: 1990, visibility: "public" })
      .where(eq(profiles.userId, hid));
    await rebuild(jobCtx(), hid);
    const viewer = await person("heavyviewer");
    const page = await api("/v1/people/heavyone", { token: viewer.token });
    expect(page.status, await page.clone().text()).toBe(200);
    expectRoundTrips(page, 2);
    expect((await jsonOf<Json>(page)).totals.sessions).toBeGreaterThan(1000);

    const g = await jsonOf<Json>(await post(viewer.token, "/v1/groups", { name: "Heavy", kind: "coaching" }));
    const now = Date.now();
    await db.insert(groupMembers).values({
      id: uuid7(now),
      groupId: g.id,
      userId: hid,
      sharesWithCoach: true,
      createdAt: now,
      updatedAt: now,
    });
    const coach = await api(`/v1/groups/${g.id}/coach`, { token: viewer.token });
    expect((await jsonOf<Json>(coach.clone())).members[0].recent.length).toBe(10);
    expectRoundTrips(coach, 2);
  });
});
