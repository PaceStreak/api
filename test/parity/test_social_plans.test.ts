/** Port of tests/test_social_plans.py: plan challenges, coach-suggested plans, announcements, coaching overview. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buddyPairs, profiles, userStats } from "../../src/db/schema/index.ts";
import { buddyClock } from "../../src/jobs/tasks/buddies.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { testDb } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";
import { get, type Json, logSession } from "../fixtures/training.ts";
import { runFor } from "../jobs/helpers.ts";

const post = (path: string, token: string, json?: unknown) =>
  api(path, { token, method: "POST", ...(json === undefined ? {} : { json }) });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const group = async (token: string, kind = "crew", name = "Crew"): Promise<Json> =>
  jsonOf(await post("/v1/groups", token, { name, kind }));

const items = async (token: string): Promise<Json[]> => (await get(token, "/v1/notifications")).items;

describe("test_social_plans", () => {
  it("plan_challenge_gives_everyone_a_copy_and_scores_sessions", async () => {
    const a = await person("pca");
    const b = await person("pcb");
    const day = today();
    const made = await post("/v1/challenges", a.token, {
      title: "Run from zero, together",
      kind: "plan_sessions",
      plan_template_id: "plan-run-from-zero",
      starts_on: day,
      ends_on: day,
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const c = await jsonOf<Json>(made);
    // The window is the plan: eight whole weeks.
    expect(c.ends_on).toBe(addDays(day, 8 * 7 - 1));
    expect(c.plan_name).toBe("Run from zero");
    expect(c.target).toBe(24);

    const joined = await post("/v1/challenges/join", b.token, { code: c.invite_code });
    expect(joined.status, await joined.clone().text()).toBe(200);
    let plans: Json[] = await get(b.token, "/v1/plans");
    expect(plans.length).toBe(1);
    expect(plans[0].active).toBe(true);

    await logSession(b.token);
    const board: Json[] = (await get(a.token, `/v1/challenges/${c.id}`)).leaderboard;
    // Any run this week completes one of the week's three plan runs.
    expect(Object.fromEntries(board.map((r) => [r.handle, r.score]))).toEqual({ pca: 0, pcb: 1 });

    // Leaving stops their copy but keeps it.
    await post(`/v1/challenges/${c.id}/leave`, b.token);
    plans = await get(b.token, "/v1/plans");
    expect(plans.length).toBe(1);
    expect(plans[0].active).toBe(false);
  });

  it("plan_challenge_needs_a_plan", async () => {
    const a = await person("pcc");
    const day = today();
    const r = await post("/v1/challenges", a.token, {
      title: "No plan",
      kind: "plan_sessions",
      starts_on: day,
      ends_on: day,
    });
    expect(r.status).toBe(422);
  });

  it("coach_can_suggest_a_plan_only_with_consent", async () => {
    const coach = await person("coachy");
    const athlete = await person("athletey");
    const g = await group(coach.token, "coaching");
    const code = (await get(coach.token, `/v1/groups/${g.id}`)).invite_code;
    await post("/v1/groups/join", athlete.token, { code });
    const athleteId = (await get(athlete.token, "/v1/me")).user.id;
    const url = `/v1/groups/${g.id}/members/${athleteId}/plan`;
    const body = { plan_template_id: "plan-5k-to-10k", note: "Your next block" };

    expect((await post(url, coach.token, body)).status).toBe(403); // no consent yet
    await api(`/v1/groups/${g.id}/me`, {
      token: athlete.token,
      method: "PATCH",
      json: { shares_with_coach: true },
    });
    const ok = await post(url, coach.token, body);
    expect(ok.status, await ok.clone().text()).toBe(201);

    const plans: Json[] = await get(athlete.token, "/v1/plans");
    expect(plans.length).toBe(1);
    expect(plans[0].active).toBe(false); // the athlete decides when
    expect((await items(athlete.token)).some((n) => n.kind === "plan_assigned")).toBe(true);

    await post(`/v1/plans/${plans[0].id}/start`, athlete.token, {});
    const roster: Json[] = (await get(coach.token, `/v1/groups/${g.id}/coach`)).members;
    expect(roster[0].plan.name).toBe("5 km to 10 km");
    expect(roster[0].plan.from_this_coach).toBe(true);
    // A member can't assign plans.
    expect((await post(url, athlete.token, body)).status).toBe(403);
  });

  it("announcements_are_admin_only_and_notify_members", async () => {
    const owner = await person("anno");
    const member = await person("annm");
    const g = await group(owner.token);
    const code = (await get(owner.token, `/v1/groups/${g.id}`)).invite_code;
    await post("/v1/groups/join", member.token, { code });

    const url = `/v1/groups/${g.id}/announcements`;
    expect((await post(url, member.token, { body: "hi" })).status).toBe(403);
    const posted = await post(url, owner.token, { body: "Long run Sunday, 8am.", pinned: true });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const listed: Json[] = await get(member.token, url);
    expect(listed[0].body).toBe("Long run Sunday, 8am.");
    expect(listed[0].pinned).toBe(true);
    expect((await items(member.token)).some((n) => n.kind === "group_announcement")).toBe(true);
    const id = (await jsonOf<Json>(posted)).id;
    expect((await api(`${url}/${id}`, { token: owner.token, method: "DELETE" })).status).toBe(204);
  });

  it("coaching_overview_spans_groups_and_respects_consent", async () => {
    const coach = await person("headcoach");
    const keen = await person("keenone");
    const quiet = await person("quietone");
    const shy = await person("shyone");
    const groups = [
      await group(coach.token, "coaching", "Mornings"),
      await group(coach.token, "coaching", "Evenings"),
    ];
    const rosters = [
      [keen, quiet],
      [keen, shy],
    ];
    for (const [i, g] of groups.entries()) {
      const code = (await get(coach.token, `/v1/groups/${g.id}`)).invite_code;
      for (const m of rosters[i] ?? []) {
        await post("/v1/groups/join", m.token, { code });
        if (m !== shy)
          await api(`/v1/groups/${g.id}/me`, {
            token: m.token,
            method: "PATCH",
            json: { shares_with_coach: true },
          });
      }
    }
    await logSession(keen.token);

    const overview = await get(coach.token, "/v1/coaching");
    expect(overview.groups.map((g: Json) => g.name)).toEqual(["Evenings", "Mornings"]);
    const byHandle = new Map<string, Json>(overview.people.map((p: Json) => [p.handle, p]));
    expect(new Set(byHandle.keys())).toEqual(new Set(["keenone", "quietone"])); // no consent, no row
    expect(
      byHandle
        .get("keenone")
        .groups.map((g: Json) => g.name)
        .sort(),
    ).toEqual(["Evenings", "Mornings"]);
    // Nothing logged: flagged, and listed first.
    expect(byHandle.get("quietone").attention).toBe(true);
    expect(overview.people[0].handle).toBe("quietone");
    expect(byHandle.get("keenone").last_session).not.toBeNull();

    // Someone who coaches nobody gets an empty overview, not an error.
    expect(await get(shy.token, "/v1/coaching")).toEqual({ groups: [], people: [] });
  });

  it("joining_a_plan_challenge_with_same_named_routines", async () => {
    // Routine names aren't unique; a duplicate "Full body A" used to 500 the join.
    const a = await person("pcda");
    const b = await person("pcdb");
    for (let i = 0; i < 2; i++) await post("/v1/routines", b.token, { name: "Full body A", items: [] });
    const day = today();
    const c = await jsonOf<Json>(
      await post("/v1/challenges", a.token, {
        title: "Lift together",
        kind: "plan_sessions",
        plan_template_id: "plan-strength-foundations",
        starts_on: day,
        ends_on: day,
      }),
    );
    const joined = await post("/v1/challenges/join", b.token, { code: c.invite_code });
    expect(joined.status, await joined.clone().text()).toBe(200);
  });
});

/** Python's `update(UserStats)`: one session short this week (the rows are created when missing). */
async function shortThisWeek(userIds: readonly string[]): Promise<void> {
  const { db } = testDb();
  const now = Date.now();
  const short = { recentWeeks: ["kept" as const, "open" as const], thisWeekDays: 2, thisWeekTarget: 3 };
  for (const userId of userIds) {
    await db
      .insert(userStats)
      .values({
        id: uuid7(now),
        userId,
        computedAt: now,
        computedFor: today(),
        seasonId: "2026-Q4",
        createdAt: now,
        updatedAt: now,
        ...short,
      })
      .onConflictDoUpdate({ target: userStats.userId, set: short });
  }
}

/** Python monkeypatched BUDDY_NUDGE_HOUR to now and week_start to six days ago: 5pm on the week's last day. */
async function atLastDayFivePm<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...buddyClock };
  buddyClock.hour = new Date().getUTCHours();
  buddyClock.weekStart = () => addDays(today(), -6);
  try {
    return await fn();
  } finally {
    Object.assign(buddyClock, saved);
  }
}

/** Two buddies, b with a session logged and one short this week, the pair active. */
async function buddies(prefix: string) {
  const a = await person(`${prefix}a`, { visibility: "public" });
  const b = await person(`${prefix}b`, { visibility: "public" });
  await post(`/v1/people/${b.handle}/follow`, a.token);
  const pair = await jsonOf<Json>(await post("/v1/buddies", a.token, { handle: b.handle }));
  await post(`/v1/buddies/${pair.id}/accept`, b.token);
  await logSession(b.token);
  await shortThisWeek([a.userId, b.userId]);
  await testDb().db.update(buddyPairs).set({ status: "active" }).where(eq(buddyPairs.id, pair.id));
  return { a, b, pair };
}

describe("test_social_plans: buddy nudges", () => {
  it("buddy_nudge_fires_once_near_the_end_of_the_week", async () => {
    const { a, b } = await buddies("bn");
    await atLastDayFivePm(async () => {
      const first = await runFor("buddies", [a.userId, b.userId]);
      const again = await runFor("buddies", [a.userId, b.userId]);
      expect(first).toHaveLength(2); // both are one short: each hears about the other
      expect(again).toEqual([]);
    });
  });

  it("changed: a buddy scheduled for deletion is never the subject of a nudge (test_buddy_nudge_fires_once_near_the_end_of_the_week)", async () => {
    const { a, b } = await buddies("bd");
    await testDb()
      .db.update(profiles)
      .set({ deletionScheduledAt: Date.now() + 86_400_000 })
      .where(eq(profiles.userId, b.userId));
    await atLastDayFivePm(async () => {
      // a hears nothing about the leaving b; b, leaving, hears nothing either.
      expect(await runFor("buddies", [a.userId, b.userId])).toEqual([]);
    });
  });
});
