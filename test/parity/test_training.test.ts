/**
 * Port of tests/test_training.py. The GAME unit ports the recompute concurrency case; PROFILE-ACCOUNT the profile,
 * export/import and deletion cases; TRAINING ports the rest.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gear, userAchievements, userStats, weighIns, workouts } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { recompute } from "../../src/modules/game/service.ts";
import { Client, login, loginToken, register, signup } from "../fixtures/auth.ts";
import { testDb, uniqueEmail } from "../fixtures/db.ts";
import { person, putWorkout } from "../fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "../fixtures/http.ts";
import { onboard, person as onboarded, uniqueHandle, upload } from "../fixtures/profile.ts";
import { at, DAY, get, HOUR, type Json, logSession, put, workout } from "../fixtures/training.ts";
import { jobCtx } from "../jobs/helpers.ts";

const uuid = () => crypto.randomUUID();

describe("test_training", () => {
  it("login_returns_csrf_token_in_body_and_refresh_accepts_it", async () => {
    const client = new Client();
    const email = await register(client, uniqueEmail("csrf"));
    const res = await client.call("/v1/auth/login", {
      json: { email, password: "correct-horse-battery-staple" },
    });
    const body = await jsonOf<{ csrf_token: string }>(res);
    expect(body.csrf_token).toBe(client.cookies.get("csrf_token"));
    const refreshed = await client.call("/v1/auth/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": body.csrf_token },
    });
    expect(refreshed.status).toBe(200);
    expect((await jsonOf<{ csrf_token: string }>(refreshed)).csrf_token).toBe(
      client.cookies.get("csrf_token"),
    );
  });

  it("unused_csrf_helper_still_works", async () => {
    const client = new Client();
    const email = await register(client, uniqueEmail("x"));
    await loginToken(client, email);
    expect(client.csrf()["X-CSRF-Token"]).toBeTruthy();
  });

  it("put_is_idempotent_and_returns_outcome", async () => {
    const me = await person();
    // The first snapshot creates the default chain (two extra trips, once per account); budgets are for after.
    await get(me.token, "/v1/chains");
    const wid = uuid();
    const body = workout();
    const first = await put(me.token, wid, body);
    expect(first.status, await first.clone().text()).toBe(200);
    expectRoundTrips(first, 3);
    const data: Json = await jsonOf(first);
    expect(data.created && data.applied).toBe(true);
    expect(data.outcome.total_xp).toBeGreaterThan(0);
    expect(data.outcome.new_achievements.some((a: Json) => a.id === "first_session")).toBe(true);
    const again = await put(me.token, wid, body);
    expectRoundTrips(again, 1);
    expect(((await jsonOf(again)) as Json).applied).toBe(false);
    const listed = await get(me.token, "/v1/workouts");
    expect(listed).toHaveLength(1);
    expect(listed[0].sets).toHaveLength(2);
  });

  it("single_badge_cannot_be_awarded_twice_by_a_race", async () => {
    const me = await person();
    await put(me.token, uuid(), workout());
    await Promise.all([
      recompute(jobCtx(), me.userId, { notify: false, scope: null }),
      recompute(jobCtx(), me.userId, { notify: false, scope: null }),
    ]);
    const rows = await testDb()
      .db.select()
      .from(userAchievements)
      .where(eq(userAchievements.userId, me.userId));
    expect(rows.filter((r) => r.achievementId === "first_session")).toHaveLength(1);
  });

  it("recompute_is_serialized_across_concurrent_calls", async () => {
    const me = await person();
    await put(me.token, uuid(), workout());
    await Promise.all([
      recompute(jobCtx(), me.userId, { notify: false }),
      recompute(jobCtx(), me.userId, { notify: false }),
    ]);
    const rows = await testDb().db.select().from(userStats).where(eq(userStats.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessions).toBe(1);
    expect(rows[0]?.totalXp).toBeGreaterThanOrEqual(0);
  });

  it("older_edit_arriving_late_is_ignored", async () => {
    const me = await person();
    const wid = uuid();
    await put(me.token, wid, workout({ title: "Newer", client_updated_at: at(0) }));
    const r: Json = await jsonOf(
      await put(me.token, wid, workout({ title: "Older", client_updated_at: at(-5 * 60_000) })),
    );
    expect(r.applied).toBe(false);
    expect((await get(me.token, `/v1/workouts/${wid}`)).title).toBe("Newer");
  });

  it("cannot_touch_someone_elses_workout", async () => {
    const owner = await person();
    const other = await person();
    const wid = uuid();
    await put(owner.token, wid, workout());
    expect((await put(other.token, wid, workout({ client_updated_at: at(1000) }))).status).toBe(404);
    expect((await api(`/v1/workouts/${wid}`, { token: other.token })).status).toBe(404);
  });

  it("rejects_unknown_exercise_and_future_sessions", async () => {
    const me = await person();
    const bad = workout({ sets: [{ exercise_id: "made-up", position: 0, set_index: 0, reps: 5 }] });
    const res = await put(me.token, uuid(), bad);
    expect(res.status).toBe(422);
    expect(((await jsonOf(res)) as Json).detail).toBe("Unknown exercise: made-up");
    expect((await put(me.token, uuid(), workout({ started_at: at(DAY) }))).status).toBe(422);
  });

  it("test_changes_feed_includes_tombstones (and answers 304 when nothing changed)", async () => {
    const me = await person();
    const a = uuid();
    const b = uuid();
    await put(me.token, a, workout());
    await put(me.token, b, workout({ discipline: "run", sets: [], distance_m: 5000 }));
    const res = await api("/v1/workouts/changes?since=0", { token: me.token });
    expectRoundTrips(res, 1);
    const first: Json = await jsonOf(res);
    expect(new Set(first.workouts.map((w: Json) => w.id))).toEqual(new Set([a, b]));
    const etag = res.headers.get("ETag") ?? "";
    const same = await api("/v1/workouts/changes?since=0", {
      token: me.token,
      headers: { "If-None-Match": etag },
    });
    expect(same.status).toBe(304);
    await api(`/v1/workouts/${a}?client_updated_at=${encodeURIComponent(at(1000))}`, {
      method: "DELETE",
      token: me.token,
    });
    const delta: Json = await get(me.token, `/v1/workouts/changes?since=${first.cursor}`);
    expect(delta.workouts.map((w: Json) => w.id)).toEqual([a]);
    expect(delta.workouts[0].deleted_at).not.toBeNull();
    const changed = await api("/v1/workouts/changes?since=0", {
      token: me.token,
      headers: { "If-None-Match": etag },
    });
    expect(changed.status).toBe(200);
  });

  it("batch_applies_what_it_can", async () => {
    const me = await person();
    await get(me.token, "/v1/chains");
    const ops = [
      { op: "put", id: uuid(), workout: workout(), client_updated_at: at(0) },
      { op: "put", id: uuid(), workout: workout({ started_at: at(3 * DAY) }), client_updated_at: at(0) },
      { op: "put", id: uuid(), client_updated_at: at(0) },
    ];
    const res = await api("/v1/workouts/batch", { json: { ops }, token: me.token });
    expectRoundTrips(res, 3);
    const result: Json = await jsonOf(res);
    expect(result.results.map((r: Json) => r.ok)).toEqual([true, false, false]);
    expect(result.results[2].detail).toBe("put needs a workout");
    expect(result.outcome).not.toBeNull();
    expect(await get(me.token, "/v1/workouts")).toHaveLength(1);
  });

  it("batch: ops on one id see each other, and seq keeps rising", async () => {
    const me = await person();
    const id = uuid();
    const ops = [
      {
        op: "put",
        id,
        workout: workout({ title: "A", client_updated_at: at(-2000) }),
        client_updated_at: at(-2000),
      },
      {
        op: "put",
        id,
        workout: workout({ title: "B", client_updated_at: at(-1000) }),
        client_updated_at: at(-1000),
      },
      {
        op: "put",
        id,
        workout: workout({ title: "late", client_updated_at: at(-3000) }),
        client_updated_at: at(-3000),
      },
    ];
    const result: Json = await jsonOf(await api("/v1/workouts/batch", { json: { ops }, token: me.token }));
    expect(result.results.map((r: Json) => [r.applied, r.created])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    const seqs = result.results.map((r: Json) => r.workout.seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBe(seqs[1]);
    expect((await get(me.token, `/v1/workouts/${id}`)).title).toBe("B");
  });

  it("stats_streak_and_records", async () => {
    const me = await person();
    for (const [daysAgo, weight] of [
      [9, 100],
      [2, 104],
    ] as const) {
      const body = workout({
        started_at: at(-daysAgo * DAY),
        sets: [{ exercise_id: "bench-press", position: 0, set_index: 0, weight_kg: weight, reps: 5 }],
      });
      // Older than 30 days is import-only; 9 days is fine.
      expect((await put(me.token, uuid(), body)).status).toBe(200);
    }
    const stats = await get(me.token, "/v1/me/stats");
    expect(stats.totals.sessions).toBe(2);
    expect(stats.chains[0].target).toBe(3);
    expect(stats.heatmap).toHaveLength(2);
    const records = await get(me.token, "/v1/me/records");
    const bench = records.current.find((r: Json) => r.key === "e1rm:bench-press");
    expect(bench.value).toBeGreaterThan(116);
    expect(bench.previous).not.toBeNull();
    const history = await get(me.token, "/v1/exercises/bench-press/history");
    expect(history.sessions).toHaveLength(2);
    expect(history.records.length).toBeGreaterThan(0);
    const last = await get(me.token, "/v1/exercises/last?ids=bench-press,nope");
    expect(last["bench-press"].sets[0].weight_kg).toBe(104);
    expect(last.nope).toBeUndefined();
  });

  it("chains_target_change_and_repair_rules", async () => {
    const me = await person();
    const chains = await get(me.token, "/v1/chains");
    const main = chains.chains[0];
    expect(main.name).toBe("Everything");
    const created = await api("/v1/chains", {
      json: { name: "Running", disciplines: ["run"], target: 2 },
      token: me.token,
    });
    expect(created.status).toBe(201);
    const patched = await api(`/v1/chains/${main.id}`, {
      method: "PATCH",
      json: { target: 4 },
      token: me.token,
    });
    expect(patched.status).toBe(200);
    const after = (await get(me.token, "/v1/chains")).chains;
    expect(after.map((c: Json) => c.name)).toEqual(["Everything", "Running"]);
    expect(after[0].target).toBe(4);
    const bad = await api(`/v1/chains/${main.id}/repair`, {
      json: { week_start: "2026-01-05" },
      token: me.token,
    });
    expect(bad.status).toBe(409);
    expect((await api(`/v1/chains/${uuid()}`, { method: "PATCH", json: {}, token: me.token })).status).toBe(
      404,
    );
    // Archiving: the last chain cannot go.
    const second = ((await jsonOf(created)) as Json).id;
    expect((await api(`/v1/chains/${second}`, { method: "DELETE", token: me.token })).status).toBe(204);
    expect((await api(`/v1/chains/${main.id}`, { method: "DELETE", token: me.token })).status).toBe(409);
  });

  it("custom_exercise_routine_and_body_metrics", async () => {
    const me = await person();
    const res = await api("/v1/exercises/custom", {
      json: { name: "Sled push", pattern: "carry", equipment: "machine", primary: ["quads"] },
      token: me.token,
    });
    expect(res.status).toBe(201);
    const custom: Json = await jsonOf(res);
    expect(custom.id.startsWith("custom-")).toBe(true);
    const body = workout({
      sets: [{ exercise_id: custom.id, position: 0, set_index: 0, weight_kg: 80, reps: 10 }],
    });
    expect((await put(me.token, uuid(), body)).status).toBe(200);
    expect(
      (await api("/v1/routines/from-template/tpl-upper", { method: "POST", token: me.token })).status,
    ).toBe(201);
    expect(await get(me.token, "/v1/routines")).toHaveLength(1);
    const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    expect(
      (await api(`/v1/body-metrics/${day}`, { method: "PUT", json: { sleep_hours: 7.5 }, token: me.token }))
        .status,
    ).toBe(200);
    expect((await get(me.token, "/v1/body-metrics"))[0].sleep_hours).toBe(7.5);
    // A used custom exercise is archived, not deleted.
    expect(
      (await api(`/v1/exercises/custom/${custom.id}`, { method: "DELETE", token: me.token })).status,
    ).toBe(204);
    expect((await get(me.token, "/v1/exercises/custom"))[0].archived).toBe(true);
    const other = await person();
    expect(
      (await api(`/v1/exercises/custom/${custom.id}`, { method: "DELETE", token: other.token })).status,
    ).toBe(404);
  });

  it("weigh_ins_several_a_day_private_and_owned", async () => {
    const me = await person();
    const morning = uuid();
    const evening = uuid();
    const first = await api(`/v1/weigh-ins/${morning}`, {
      method: "PUT",
      json: { weighed_at: at(-10 * HOUR), moment: "waking", weight_kg: 80.456 },
      token: me.token,
    });
    expect(first.status).toBe(200);
    expect(((await jsonOf(first)) as Json).weight_kg).toBe(80.46);
    const body = { weighed_at: at(-HOUR), moment: "bedtime" };
    await api(`/v1/weigh-ins/${evening}`, {
      method: "PUT",
      json: { ...body, weight_kg: 81.2 },
      token: me.token,
    });
    await api(`/v1/weigh-ins/${evening}`, {
      method: "PUT",
      json: { ...body, weight_kg: 81.0 },
      token: me.token,
    });
    const listed = await get(me.token, "/v1/weigh-ins");
    expect(listed.map((w: Json) => [w.moment, w.weight_kg])).toEqual([
      ["waking", 80.46],
      ["bedtime", 81],
    ]);
    const bad = [
      { ...body, weight_kg: 80, moment: "lunch" },
      { ...body, weight_kg: 0 },
      { weighed_at: at(2 * HOUR), moment: "other", weight_kg: 80 },
      { weighed_at: "2026-01-01T08:00:00", moment: "other", weight_kg: 80 },
      { weighed_at: at(-40 * DAY), moment: "other", weight_kg: 80 },
    ];
    for (const payload of bad)
      expect(
        (await api(`/v1/weigh-ins/${uuid()}`, { method: "PUT", json: payload, token: me.token })).status,
      ).toBe(422);
    const other = await person();
    expect(
      (
        await api(`/v1/weigh-ins/${morning}`, {
          method: "PUT",
          json: { ...body, weight_kg: 50 },
          token: other.token,
        })
      ).status,
    ).toBe(404);
    await api(`/v1/weigh-ins/${morning}`, { method: "DELETE", token: other.token });
    expect(await get(other.token, "/v1/weigh-ins")).toEqual([]);
    expect(await get(me.token, "/v1/weigh-ins")).toHaveLength(2);
    expect((await api(`/v1/weigh-ins/${evening}`, { method: "DELETE", token: me.token })).status).toBe(204);
    expect(await get(me.token, "/v1/weigh-ins")).toHaveLength(1);
  });

  it("library_is_cacheable", async () => {
    const res = await api("/v1/library");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const lib: Json = await jsonOf(res);
    for (const d of ["strength", "run", "ride", "climb"])
      expect(lib.disciplines.map((x: Json) => x.id)).toContain(d);
    expect(lib.exercises.length).toBeGreaterThan(60);
  });

  it("chain_requirements_validate_and_report_progress", async () => {
    const me = await person();
    const main = (await get(me.token, "/v1/chains")).chains[0];
    const reqs = [
      { disciplines: ["run"], days: 2 },
      { disciplines: ["strength"], days: 2 },
    ];
    const tooMany = await api(`/v1/chains/${main.id}`, {
      method: "PATCH",
      json: { requirements: reqs },
      token: me.token,
    });
    expect(tooMany.status).toBe(422);
    expect(((await jsonOf(tooMany)) as Json).detail).toContain("weekly target");
    const ok = await api(`/v1/chains/${main.id}`, {
      method: "PATCH",
      json: { target: 4, requirements: reqs },
      token: me.token,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    await logSession(me.token);
    const chain = (await get(me.token, "/v1/chains")).chains[0];
    expect(chain.requirements).toEqual([
      { disciplines: ["run"], days: 2, done: 1 },
      { disciplines: ["strength"], days: 2, done: 0 },
    ]);
    expect("consistency_12" in chain && "consistency_52" in chain).toBe(true);
    const runsOnly = await api("/v1/chains", {
      json: {
        name: "Runs",
        disciplines: ["run"],
        target: 3,
        requirements: [{ disciplines: ["strength"], days: 1 }],
      },
      token: me.token,
    });
    expect(runsOnly.status).toBe(422);
  });

  it("tags_are_normalised_and_private", async () => {
    const me = await person();
    const saved = await logSession(me.token, { tags: ["#Hill Reps", "hill-reps", "With Sam!", "  "] });
    expect(saved.workout.tags).toEqual(["hill-reps", "with-sam"]);
    expect((await get(me.token, "/v1/workouts"))[0].tags).toEqual(["hill-reps", "with-sam"]);
  });

  it("gear_mileage_follows_the_log", async () => {
    const me = await person();
    const shoes = await api("/v1/gear", {
      json: { name: "Trail shoes", kind: "shoes", default_for: ["run"], limit_km: 700, initial_km: 100 },
      token: me.token,
    });
    expect(shoes.status).toBe(201);
    const gid = ((await jsonOf(shoes)) as Json).id;
    const first = await logSession(me.token, { gear_id: gid, distance_m: 10_000 });
    await logSession(me.token, { gear_id: gid, distance_m: 5_000 });
    const gear = (await get(me.token, "/v1/gear"))[0];
    expect(gear.distance_m).toBe(115_000);
    expect(gear.sessions).toBe(2);
    expect(gear.worn).toBe(Math.round((115 / 700) * 1000) / 1000);
    await api(`/v1/workouts/${first.workout.id}`, { method: "DELETE", token: me.token });
    expect((await get(me.token, "/v1/gear"))[0].distance_m).toBe(105_000);
    const road: Json = await jsonOf(
      await api("/v1/gear", { json: { name: "Road shoes", default_for: ["run"] }, token: me.token }),
    );
    const items = Object.fromEntries((await get(me.token, "/v1/gear")).map((g: Json) => [g.id, g]));
    expect(items[gid].default_for).toEqual([]);
    expect(items[road.id].default_for).toEqual(["run"]);
    await api(`/v1/gear/${road.id}`, { method: "PATCH", json: { retired: true }, token: me.token });
    expect((await api(`/v1/gear/${gid}`, { method: "DELETE", token: me.token })).status).toBe(204);
    const remaining = await get(me.token, "/v1/workouts");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].gear_id).toBeNull();
  });

  it("someone_elses_gear_is_dropped_not_linked", async () => {
    const a = await person();
    const b = await person();
    const theirs: Json = await jsonOf(await api("/v1/gear", { json: { name: "Not yours" }, token: a.token }));
    const saved = await logSession(b.token, { gear_id: theirs.id });
    expect(saved.workout.gear_id).toBeNull();
    expect(
      (await api(`/v1/gear/${theirs.id}`, { method: "PATCH", json: { name: "x" }, token: b.token })).status,
    ).toBe(404);
  });

  // ---- PROFILE-ACCOUNT ------------------------------------------------------------------------------------
  // Workouts, gear and weigh-ins are seeded straight into D1 (TRAINING owns their routes) and read back from D1.

  it("me_reports_onboarding_needed", async () => {
    const { token } = await signup();
    const me = await jsonOf<{ needs_onboarding: boolean; profile: { handle: string | null } }>(
      await api("/v1/me", { token }),
    );
    expect(me.needs_onboarding).toBe(true);
    expect(me.profile.handle).toBeNull();
  });

  it("onboarding_refuses_under_thirteen", async () => {
    const { token } = await signup();
    const res = await api("/v1/me/onboarding", {
      token,
      json: { handle: uniqueHandle("kid"), birth_year: new Date().getUTCFullYear() - 10, accept_terms: true },
    });
    expect(res.status).toBe(403);
  });

  it("teen_is_forced_private", async () => {
    const { token } = await signup();
    const out = await onboard(token, uniqueHandle("teen"), {
      birth_year: new Date().getUTCFullYear() - 14,
      visibility: "public",
    });
    expect(out.profile.visibility).toBe("private");
    const me = await jsonOf<{ social_allowed: boolean }>(await api("/v1/me", { token }));
    expect(me.social_allowed).toBe(false);
  });

  it("handles_are_unique_and_validated", async () => {
    const taken = await onboarded(uniqueHandle("taken"));
    const { token } = await signup();
    const avail = async (h: string) =>
      (await jsonOf<{ available: boolean }>(await api(`/v1/handles/${encodeURIComponent(h)}`, { token })))
        .available;
    expect(await avail(taken.handle)).toBe(false);
    expect(await avail("Bad Handle")).toBe(false);
    expect(await avail("admin")).toBe(false);
    expect(await avail(uniqueHandle("free_"))).toBe(true);
  });

  it("export_and_import_roundtrip", async () => {
    const me = await onboarded();
    await putWorkout(me.userId);
    const exported = await api("/v1/me/export?format=json", { token: me.token });
    expect(exported.status).toBe(200);
    const data = await jsonOf<{ format: string; workouts: { id: string }[] }>(exported);
    expect(data.format).toBe("pacestreak-export");
    expect(data.workouts).toHaveLength(1);
    const csv = await api("/v1/me/export?format=csv", { token: me.token });
    expect(csv.headers.get("content-type")).toBe("application/zip");
    const ics = await api("/v1/me/export?format=ics", { token: me.token });
    expect(await ics.text()).toContain("BEGIN:VEVENT");

    // Importing someone else's export re-mints the ids and never touches theirs.
    const other = await onboarded();
    const res = await upload("/v1/me/import", other.token, JSON.stringify(data));
    expect(await res.json()).toEqual({ imported: 1, skipped: 0 });
    const theirs = await testDb().db.select().from(workouts).where(eq(workouts.userId, other.userId));
    expect(theirs[0]?.source).toBe("import");
    expect(theirs[0]?.id).not.toBe(data.workouts[0]?.id);
    // Importing it again is a no-op for the original owner.
    const again = await upload("/v1/me/import", me.token, JSON.stringify(data));
    expect(await again.json()).toEqual({ imported: 0, skipped: 1 });
  });

  it("weigh_ins_export_and_import_including_legacy_daily_weight", async () => {
    const me = await onboarded();
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const legacy = {
      format: "pacestreak-export",
      version: 2,
      workouts: [],
      body_metrics: [{ date: day, weight_kg: 79.9, sleep_hours: 8 }],
      weigh_ins: [{ id: crypto.randomUUID(), weighed_at: at, moment: "waking", weight_kg: 79.5 }],
    };
    const send = async (data: unknown, token: string) =>
      expect((await upload("/v1/me/import", token, JSON.stringify(data))).status).toBe(200);
    await send(legacy, me.token);
    await send(legacy, me.token); // twice: no duplicates
    const { db } = testDb();
    const mine = await db.select().from(weighIns).where(eq(weighIns.userId, me.userId));
    expect(mine.map((w) => `${w.moment}:${w.weightKg}`).sort()).toEqual(["other:79.9", "waking:79.5"]);
    expect(mine.find((w) => w.moment === "other")?.localDate).toBe(day);

    const exported = await jsonOf<{
      version: number;
      weigh_ins: unknown[];
      body_metrics: Record<string, unknown>[];
    }>(await api("/v1/me/export?format=json", { token: me.token }));
    expect(exported.version).toBe(3);
    expect(exported.weigh_ins).toHaveLength(2);
    expect(exported.body_metrics[0]?.sleep_hours).toBe(8);
    expect("weight_kg" in (exported.body_metrics[0] ?? {})).toBe(false);
    // Someone else importing it gets their own copies, and the owner keeps theirs.
    const other = await onboarded();
    await send(exported, other.token);
    const theirs = await db.select().from(weighIns).where(eq(weighIns.userId, other.userId));
    expect(theirs).toHaveLength(2);
    const ids = new Set(mine.map((w) => w.id));
    expect(theirs.some((w) => ids.has(w.id))).toBe(false);
  });

  it("account_deletion_is_scheduled_and_cancellable", async () => {
    const me = await onboarded();
    const res = await api("/v1/me/delete", { token: me.token, json: { password: me.password } });
    expect(res.status).toBe(200);
    // Every session was ended...
    expect((await api("/v1/me", { token: me.token })).status).toBe(401);
    // ...and signing back in is how it gets cancelled.
    const back = await login(me.email);
    const now = await jsonOf<{ profile: { deletion_scheduled_at: string | null } }>(
      await api("/v1/me", { token: back.token }),
    );
    expect(now.profile.deletion_scheduled_at).not.toBeNull();
    expect(await jsonOf(await api("/v1/me/delete/cancel", { token: back.token, method: "POST" }))).toEqual({
      cancelled: true,
    });
    const events = await jsonOf<{ kind: string }[]>(
      await api("/v1/me/security-events", { token: back.token }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("deletion_scheduled");
    expect(kinds).toContain("login");
  });

  it("export_carries_tags_and_gear_and_import_restores_them", async () => {
    const me = await onboarded();
    const { db } = testDb();
    const now = Date.now();
    const shoes = uuid7(now);
    await db.insert(gear).values({
      id: shoes,
      userId: me.userId,
      name: "Racers",
      limitM: 400_000,
      createdAt: now,
      updatedAt: now,
    });
    const w = await putWorkout(me.userId, { discipline: "run", distanceM: 5000, sets: [] });
    await db
      .update(workouts)
      .set({ tags: ["race"], gearId: shoes })
      .where(eq(workouts.id, w.id));
    const exported = await jsonOf<{
      version: number;
      gear: { name: string }[];
      workouts: { tags: string[] }[];
    }>(await api("/v1/me/export?format=json", { token: me.token }));
    expect(exported.version).toBe(3);
    expect(exported.gear[0]?.name).toBe("Racers");
    expect(exported.workouts[0]?.tags).toEqual(["race"]);

    const other = await onboarded();
    const res = await upload("/v1/me/import", other.token, JSON.stringify(exported));
    expect((await jsonOf<{ imported: number }>(res)).imported).toBe(1);
    const theirGear = await db.select().from(gear).where(eq(gear.userId, other.userId));
    expect(theirGear.map((g) => g.name)).toEqual(["Racers"]);
    const linked = await db
      .select()
      .from(workouts)
      .where(and(eq(workouts.userId, other.userId), eq(workouts.gearId, theirGear[0]?.id ?? "")));
    expect(linked.map((x) => x.distanceM)).toEqual([5000]);
    // Importing twice never duplicates the gear.
    await upload("/v1/me/import", other.token, JSON.stringify(exported));
    expect(await db.select().from(gear).where(eq(gear.userId, other.userId))).toHaveLength(1);
  });
});
