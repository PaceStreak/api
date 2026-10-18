/** Port of tests/test_social.py: follows, the feed, privacy, blocks, kudos, comments, reports, groups, challenges. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../../src/db/schema/index.ts";
import { signUnsubscribe } from "../../src/modules/notifications/service.ts";
import { makeRole } from "../fixtures/admin.ts";
import { signup } from "../fixtures/auth.ts";
import { testDb, uniqueEmail } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { onboard, person } from "../fixtures/profile.ts";
import { get, type Json, logSession } from "../fixtures/training.ts";
import { jobCtx } from "../jobs/helpers.ts";

interface Prefs {
  categories: { id: string; locked: boolean; email: boolean }[];
}

const post = (path: string, token: string, json?: unknown) =>
  api(path, { token, method: "POST", ...(json === undefined ? {} : { json }) });
const del = (path: string, token: string) => api(path, { token, method: "DELETE" });
const patch = (path: string, token: string, json: unknown) => api(path, { token, method: "PATCH", json });

const inbox = async (token: string): Promise<Json[]> => (await get(token, "/v1/notifications")).items;
const feedEvents = async (token: string): Promise<Json[]> => (await get(token, "/v1/feed")).events;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("test_social", () => {
  it("follow_public_is_immediate_and_feed_shows_sessions", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    expect(await jsonOf(await post("/v1/people/alice/follow", bob.token))).toEqual({ status: "accepted" });
    await logSession(alice.token, { title: "Morning 5k", notes: "felt slow" });
    const events = await feedEvents(bob.token);
    expect(events.map((e) => e.kind)).toContain("workout");
    const event = events.find((e) => e.kind === "workout");
    expect(event.data.title).toBe("Morning 5k");
    expect(event.author.handle).toBe("alice");
    // Private notes never leave their author.
    expect("notes" in event.data).toBe(false);
    expect((await inbox(alice.token)).some((n) => n.kind === "new_follower")).toBe(true);
  });

  it("followers_only_needs_approval", async () => {
    const carol = await person("carol", { visibility: "followers" });
    const dave = await person("dave");
    expect(await jsonOf(await post("/v1/people/carol/follow", dave.token))).toEqual({ status: "pending" });
    await logSession(carol.token);
    expect((await feedEvents(dave.token)).filter((e) => e.author.handle === "carol")).toEqual([]);
    const profile = await get(dave.token, "/v1/people/carol");
    expect(profile.visible).toBe(false);
    expect("heatmap" in profile).toBe(false);

    const requests: Json[] = await get(carol.token, "/v1/me/follow-requests");
    expect(requests.map((r) => r.handle)).toEqual(["dave"]);
    await post(`/v1/me/follow-requests/${requests[0].request_id}/accept`, carol.token);
    expect((await feedEvents(dave.token)).filter((e) => e.author.handle === "carol").length).toBeGreaterThan(
      0,
    );
    expect((await get(dave.token, "/v1/people/carol")).visible).toBe(true);
  });

  it("private_accounts_cannot_be_followed_or_found", async () => {
    await person("eve", { visibility: "private" });
    const frank = await person("frank");
    expect((await post("/v1/people/eve/follow", frank.token)).status).toBe(404);
    expect(await get(frank.token, "/v1/people/search?q=eve")).toEqual([]);
  });

  it("block_hides_everything_both_ways", async () => {
    const gina = await person("gina");
    const hank = await person("hank");
    await post("/v1/people/gina/follow", hank.token);
    await logSession(gina.token);
    expect((await post("/v1/people/hank/block", gina.token)).status).toBe(204);
    expect((await api("/v1/people/gina", { token: hank.token })).status).toBe(404);
    expect((await feedEvents(hank.token)).every((e) => e.author.handle !== "gina")).toBe(true);
    expect((await post("/v1/people/gina/follow", hank.token)).status).toBe(404);
    expect(await get(hank.token, "/v1/people/search?q=gin")).toEqual([]);
  });

  it("pausing_sharing_stops_new_events", async () => {
    const ivy = await person("ivy");
    const jon = await person("jon");
    await post("/v1/people/ivy/follow", jon.token);
    await patch("/v1/me/profile", ivy.token, { sharing_paused: true });
    await logSession(ivy.token);
    expect((await feedEvents(jon.token)).filter((e) => e.author.handle === "ivy")).toEqual([]);
  });

  it("kudos_and_comments", async () => {
    const kim = await person("kim");
    const leo = await person("leo");
    await post("/v1/people/kim/follow", leo.token);
    await logSession(kim.token);
    const event = (await feedEvents(leo.token)).find((e) => e.kind === "workout");
    expect((await jsonOf<Json>(await post(`/v1/events/${event.id}/kudos`, leo.token))).kudos).toBe(1);
    expect((await jsonOf<Json>(await post(`/v1/events/${event.id}/kudos`, leo.token))).kudos).toBe(1);

    const posted = await post(`/v1/events/${event.id}/comments`, leo.token, {
      body: "  Strong‮ work\u0000  ",
    });
    expect(posted.status).toBe(201);
    // Bidirectional overrides and control characters are stripped.
    expect((await jsonOf<Json>(posted)).body).toBe("Strong work");
    const comments: Json[] = await get(kim.token, `/v1/events/${event.id}/comments`);
    expect(comments[0].can_delete).toBe(true); // the event owner may remove it
    expect((await post(`/v1/events/${event.id}/comments`, leo.token, { body: "x".repeat(281) })).status).toBe(
      422,
    );
  });

  it("under_sixteen_cannot_use_social", async () => {
    const teen = await person("teenager", { birth_year: new Date().getUTCFullYear() - 15 });
    await person("adult");
    expect((await post("/v1/people/adult/follow", teen.token)).status).toBe(403);
    expect((await api("/v1/leaderboards/consistency", { token: teen.token })).status).toBe(403);
    expect((await patch("/v1/me/profile", teen.token, { visibility: "public" })).status).toBe(403);
  });

  it("unverified_email_cannot_follow", async () => {
    await person("target");
    const me = await signup(uniqueEmail("unverified"));
    await testDb().db.update(users).set({ isVerified: false }).where(eq(users.id, me.userId));
    await onboard(me.token, "newcomer");
    expect((await post("/v1/people/target/follow", me.token)).status).toBe(403);
  });

  it("report_and_moderation_hide_content_and_suspend", async () => {
    const mona = await person("mona");
    const ned = await person("ned");
    await post("/v1/people/mona/follow", ned.token);
    await logSession(mona.token);
    const event = (await feedEvents(ned.token)).find((e) => e.kind === "workout");
    const comment = await jsonOf<Json>(
      await post(`/v1/events/${event.id}/comments`, ned.token, { body: "rude words" }),
    );
    const reported = await post("/v1/reports", mona.token, {
      target_type: "comment",
      target_id: comment.id,
      reason: "harassment",
    });
    expect(reported.status).toBe(201);

    // Not a moderator: the admin API does not exist as far as they can tell.
    expect((await api("/v1/admin/reports", { token: mona.token })).status).toBe(404);

    const mod = await signup(uniqueEmail("mod"));
    await makeRole(mod.userId, "moderator");
    const queue: Json[] = await get(mod.token, "/v1/admin/reports");
    const mine = queue.find((r) => r.target_id === comment.id);
    expect(mine.snapshot).toEqual({ body: "rude words" });
    const resolved = await post(`/v1/admin/reports/${mine.id}/resolve`, mod.token, {
      action: "hide_and_suspend",
    });
    expect(resolved.status).toBe(200);
    expect(await get(mona.token, `/v1/events/${event.id}/comments`)).toEqual([]);
    // Suspended: no social, but the training log still works.
    expect((await post("/v1/people/mona/follow", ned.token)).status).toBe(403);
    await logSession(ned.token);
    const audit: Json[] = await get(mod.token, "/v1/admin/audit");
    expect(audit[0].action).toBe("report.hide_and_suspend");
    // Moderators cannot change roles.
    const target = (await get(mod.token, "/v1/admin/users?q=ned"))[0];
    expect((await patch(`/v1/admin/users/${target.id}`, mod.token, { role: "admin" })).status).toBe(403);
  });

  it("groups_challenges_and_leaderboards", async () => {
    const olga = await person("olga");
    const pete = await person("pete");
    const group = await jsonOf<Json>(
      await post("/v1/groups", olga.token, { name: "Dawn crew", kind: "coaching" }),
    );
    expect(group.invite_code).toBeTruthy();
    expect((await post("/v1/groups/join", pete.token, { code: group.invite_code })).status).toBe(200);
    const detail = await get(pete.token, `/v1/groups/${group.id}`);
    expect(detail.member_count).toBe(2);
    expect(detail.invite_code).toBeNull(); // members do not see the code

    // Coach view shows only members who opted in.
    await logSession(pete.token);
    expect((await get(olga.token, `/v1/groups/${group.id}/coach`)).members).toEqual([]);
    await patch(`/v1/groups/${group.id}/me`, pete.token, { shares_with_coach: true });
    const coach = await get(olga.token, `/v1/groups/${group.id}/coach`);
    expect(coach.members.map((m: Json) => m.handle)).toEqual(["pete"]);
    expect((await api(`/v1/groups/${group.id}/coach`, { token: pete.token })).status).toBe(403);

    const day = today();
    const challenge = await jsonOf<Json>(
      await post("/v1/challenges", olga.token, {
        title: "Ten days",
        kind: "active_days",
        target: 10,
        group_id: group.id,
        starts_on: day,
        ends_on: addDays(day, 13),
      }),
    );
    await post(`/v1/challenges/${challenge.id}/join`, pete.token);
    const board = await get(pete.token, `/v1/challenges/${challenge.id}`);
    const scores = Object.fromEntries(board.leaderboard.map((r: Json) => [r.handle, r.score]));
    expect(scores).toEqual({ pete: 1, olga: 0 });

    // Leaderboards are opt-in globally, automatic within a group.
    expect((await get(olga.token, "/v1/leaderboards/streak")).rows).toEqual([]);
    await patch("/v1/me/profile", pete.token, { leaderboard_opt_in: true });
    const rows: Json[] = (await get(olga.token, "/v1/leaderboards/season_xp")).rows;
    expect(rows.map((r) => r.handle)).toEqual(["pete"]);
    const grouped = await get(olga.token, `/v1/leaderboards/consistency?scope=group&group_id=${group.id}`);
    expect(new Set(grouped.rows.map((r: Json) => r.handle))).toEqual(new Set(["olga", "pete"]));
    expect((await api("/v1/leaderboards/bodyweight", { token: olga.token })).status).toBe(404);
  });

  it("notification_preferences_and_unsubscribe", async () => {
    const { token } = await signup();
    let prefs = await jsonOf<Prefs>(await api("/v1/notifications/preferences", { token }));
    const security = prefs.categories.find((c) => c.id === "security");
    expect(security?.locked && security.email).toBe(true);
    await api("/v1/notifications/preferences", {
      token,
      method: "PUT",
      json: { channels: { digest: { email: false }, security: { email: false } } },
    });
    prefs = await jsonOf<Prefs>(await api("/v1/notifications/preferences", { token }));
    const byId = new Map(prefs.categories.map((c) => [c.id, c]));
    expect(byId.get("digest")?.email).toBe(false);
    expect(byId.get("security")?.email).toBe(true); // cannot be switched off

    // Python read the id from /v1/me (PROFILE-ACCOUNT); /v1/auth/me carries it too.
    const uid = (await jsonOf<{ id: string }>(await api("/v1/auth/me", { token }))).id;
    const bad = await api("/v1/notifications/unsubscribe", { json: { u: uid, c: "social", s: "nope" } });
    expect(bad.status).toBe(400);
    const good = await api("/v1/notifications/unsubscribe", {
      json: { u: uid, c: "social", s: await signUnsubscribe(jobCtx(), uid, "social") },
    });
    expect(good.status).toBe(200);
  });

  it("muting_a_group_keeps_its_notifications_in_the_inbox", async () => {
    const owner = await person("olive");
    const joiner = await person("joiner");
    const group = await jsonOf<Json>(await post("/v1/groups", owner.token, { name: "Quiet" }));
    const muted = await patch(`/v1/groups/${group.id}/me`, owner.token, { muted: true });
    expect((await jsonOf<Json>(muted)).muted).toBe(true);
    expect((await get(owner.token, `/v1/groups/${group.id}`)).muted).toBe(true);

    await post("/v1/groups/join", joiner.token, { code: group.invite_code });
    expect((await inbox(owner.token)).some((n) => n.kind === "group_join")).toBe(true);
  });

  it("reactions_are_presets_one_per_person_and_switchable", async () => {
    const ana = await person("anaruns");
    const ben = await person("benlifts");
    const cy = await person("cyrides");
    for (const fan of [ben, cy]) await post("/v1/people/anaruns/follow", fan.token);
    await logSession(ana.token);
    const event = (await feedEvents(ben.token)).find((e) => e.kind === "workout");
    const url = `/v1/events/${event.id}/kudos`;
    const first = await jsonOf<Json>(await post(url, ben.token, { reaction: "fire" }));
    expect([first.kudos, first.my_reaction, first.reactions]).toEqual([1, "fire", { fire: 1 }]);
    // Switching replaces it: still one kudos from ben, and no second notice.
    const switched = await jsonOf<Json>(await post(url, ben.token, { reaction: "strong" }));
    expect([switched.kudos, switched.reactions]).toEqual([1, { strong: 1 }]);
    await post(url, cy.token); // no body: plain kudos
    const seen = await get(ana.token, `/v1/events/${event.id}`);
    expect(seen.reactions).toEqual({ strong: 1, kudos: 1 });
    expect(seen.my_reaction).toBeNull();
    expect((await inbox(ana.token)).filter((n) => n.kind === "kudos").length).toBe(2);
    // Only the presets: free text is refused.
    expect((await post(url, cy.token, { reaction: "lol nice" })).status).toBe(422);
    const gone = await jsonOf<Json>(await del(url, cy.token));
    expect([gone.kudos, gone.reactions, gone.my_reaction]).toEqual([1, { strong: 1 }, null]);
  });
});
