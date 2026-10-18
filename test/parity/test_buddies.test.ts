/** Port of tests/test_buddies.py: buddy streaks, group streaks and encouragement. */
import { describe, expect, it } from "vitest";
import { jointStreak } from "../../src/modules/game/service.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";
import { get, type Json, logSession } from "../fixtures/training.ts";

const statuses = (r: ReturnType<typeof jointStreak>) => r.weeks.map((w) => w.status);
const post = (path: string, token: string, json?: unknown) =>
  api(path, { token, method: "POST", ...(json === undefined ? {} : { json }) });

async function follow(token: string, handle: string) {
  const r = await post(`/v1/people/${handle}/follow`, token);
  expect([200, 201], await r.clone().text()).toContain(r.status);
}

describe("test_buddies", () => {
  // --- the pure engine ---

  it("a_pair_keeps_a_week_only_when_both_do", () => {
    const r = jointStreak(
      [
        ["kept", "kept", "missed", "open"],
        ["kept", "kept", "kept", "open"],
      ],
      1.0,
    );
    expect(statuses(r)).toEqual(["kept", "kept", "missed", "open"]);
    expect([r.current, r.longest]).toEqual([0, 2]);
  });

  it("freezes_and_repairs_carry_over", () => {
    expect(
      jointStreak(
        [
          ["frozen", "kept"],
          ["kept", "repaired"],
        ],
        1.0,
      ).current,
    ).toBe(2);
  });

  it("a_paused_member_sits_the_week_out", () => {
    // B is injured in week 2: A alone decides it. Both paused in week 3: the week is neutral.
    const r = jointStreak(
      [
        ["kept", "kept", "paused", "kept"],
        ["kept", "paused", "paused", "kept"],
      ],
      1.0,
    );
    expect(statuses(r)).toEqual(["kept", "kept", "paused", "kept"]);
    expect(r.current).toBe(3);
  });

  it("group_threshold", () => {
    const members = [
      ["kept", "open"],
      ["kept", "open"],
      ["kept", "open"],
      ["missed", "open"],
    ];
    expect(jointStreak(members, 0.75).weeks[0]?.status).toBe("kept");
    expect(jointStreak(members, 1.0).weeks[0]?.status).toBe("missed");
  });

  it("the_current_week_never_breaks_and_counts_once_kept", () => {
    expect(
      jointStreak(
        [
          ["kept", "open"],
          ["kept", "open"],
        ],
        1.0,
      ).current,
    ).toBe(1);
    expect(
      jointStreak(
        [
          ["kept", "kept"],
          ["kept", "kept"],
        ],
        1.0,
      ).current,
    ).toBe(2);
  });

  it("max_weeks_starts_the_pair_fresh", () => {
    const r = jointStreak([Array(5).fill("kept"), Array(5).fill("kept")], 1.0, 2);
    expect(r.weeks.length).toBe(2);
    expect(r.current).toBe(2);
  });

  it("members_with_shorter_history_are_left_out_of_old_weeks", () => {
    // B only has this week (just joined): the older weeks are A's alone, and this week is still open for B.
    const r = jointStreak([["kept", "kept", "kept"], ["open"]], 1.0);
    expect(statuses(r)).toEqual(["kept", "kept", "open"]);
    expect(r.current).toBe(2);
  });

  // --- the API ---

  it("buddy_invite_accept_and_progress", async () => {
    const a = await person("buda");
    const b = await person("budb");

    // Strangers can't invite each other.
    expect((await post("/v1/buddies", a.token, { handle: "budb" })).status).toBe(403);

    await follow(a.token, "budb");
    const invite = await post("/v1/buddies", a.token, { handle: "budb" });
    expect(invite.status, await invite.clone().text()).toBe(201);
    const pairId = (await jsonOf<Json>(invite)).id;
    expect((await post("/v1/buddies", a.token, { handle: "budb" })).status).toBe(409);
    // Only the invitee can accept.
    expect((await post(`/v1/buddies/${pairId}/accept`, a.token)).status).toBe(409);

    const incoming: Json[] = await get(b.token, "/v1/buddies");
    expect(incoming[0].incoming).toBe(true);
    const accepted = await post(`/v1/buddies/${pairId}/accept`, b.token);
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    await logSession(b.token);
    const view = (await get(a.token, "/v1/buddies"))[0];
    expect(view.status).toBe("active");
    expect(view.them.days).toBe(1);
    // Progress only: nothing about sessions, notes or pause reasons.
    expect(new Set(Object.keys(view.them))).toEqual(new Set(["days", "target", "paused"]));
  });

  it("blocking_ends_a_pair", async () => {
    const a = await person("budc");
    const b = await person("budd");
    await follow(b.token, "budc");
    const pair = await jsonOf<Json>(await post("/v1/buddies", a.token, { handle: "budd" }));
    await post(`/v1/buddies/${pair.id}/accept`, b.token);
    await post("/v1/people/budc/block", b.token);
    expect(await get(a.token, "/v1/buddies")).toEqual([]);
  });

  it("encouragement_is_preset_and_once_a_day", async () => {
    const a = await person("enca");
    const b = await person("encb");
    const presets: Json[] = await get(a.token, "/v1/encouragement/presets");
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every((p) => "text" in p)).toBe(true);

    // b doesn't follow a yet: a can't message b.
    const body = { preset: presets[0].id };
    expect((await post("/v1/people/encb/encourage", a.token, body)).status).toBe(403);
    await follow(b.token, "enca");
    const first = await post("/v1/people/encb/encourage", a.token, body);
    expect(first.status).toBe(202);
    expect((await jsonOf<Json>(first)).sent).toBe(true);
    const again = await post("/v1/people/encb/encourage", a.token, body);
    expect((await jsonOf<Json>(again)).sent).toBe(false);
    const freeText = await post("/v1/people/encb/encourage", a.token, { preset: "anything I like" });
    expect(freeText.status).toBe(422);

    const items: Json[] = (await get(b.token, "/v1/notifications")).items;
    expect(items.filter((n) => n.kind === "encouragement").length).toBe(1);
  });

  it("group_streak_is_reported", async () => {
    const a = await person("grpa");
    const group = await jsonOf<Json>(await post("/v1/groups", a.token, { name: "Crew" }));
    await logSession(a.token);
    const detail = await get(a.token, `/v1/groups/${group.id}`);
    expect(detail.streak.threshold).toBe(75);
    expect(detail.streak.this_week).toEqual({ kept: 0, counted: 1 });
    const patch = (json: unknown) => api(`/v1/groups/${group.id}`, { token: a.token, method: "PATCH", json });
    expect((await patch({ streak_threshold: 20 })).status).toBe(422);
    expect((await patch({ streak_threshold: 100 })).status).toBe(200);
  });
});
