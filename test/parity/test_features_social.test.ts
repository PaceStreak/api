/**
 * The rest of tests/test_features.py: the pause rules inside the streak engine, the weekly recap, the year review and
 * record history (GAME routes), and official accounts as seen on a person page (SOCIAL).
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { computeChain, pausedDays } from "../../src/modules/game/service.ts";
import { makeRole } from "../fixtures/admin.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";
import { get, type Json, put } from "../fixtures/training.ts";

const MON = "2026-09-07";
const days = (...offsets: number[]) => offsets.map((o) => addDays(MON, o));
const fixed = (target: number) => () => target;
const keptWeeks = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => start + i).flatMap((w) => days(w * 7, w * 7 + 2, w * 7 + 4));
const span = (from: number, to: number | null) => ({
  startsOn: addDays(MON, from),
  endsOn: to === null ? null : addDays(MON, to),
});
const statuses = (r: ReturnType<typeof computeChain>) => r.weeks.map((w) => w.status);

describe("test_features (engine and social)", () => {
  it("paused_week_neither_breaks_nor_extends_the_run", () => {
    const active = [...keptWeeks(2), ...keptWeeks(1, 3)];
    const r = computeChain(active, addDays(MON, 29), 0, fixed(3), { pausedDays: pausedDays([span(14, 20)]) });
    expect(statuses(r)).toEqual(["kept", "kept", "paused", "kept", "open"]);
    expect(r.current).toBe(3);
  });

  it("pause_never_spends_or_earns_a_freeze", () => {
    const active = [...keptWeeks(4), ...keptWeeks(1, 6)];
    // Week 4 paused, week 5 missed: the freeze from weeks 0-3 is still there for it.
    const r = computeChain(active, addDays(MON, 50), 0, fixed(3), { pausedDays: pausedDays([span(28, 34)]) });
    expect(statuses(r).slice(4, 7)).toEqual(["paused", "frozen", "kept"]);
  });

  it("a_short_pause_does_not_shelter_a_week", () => {
    const active = [...keptWeeks(1), ...keptWeeks(1, 2)];
    const r = computeChain(active, addDays(MON, 22), 0, fixed(3), { pausedDays: pausedDays([span(7, 9)]) });
    expect(r.weeks[1]?.status).toBe("missed");
  });

  it("a_kept_week_inside_a_pause_is_still_kept", () => {
    const r = computeChain(days(0, 2, 4), addDays(MON, 8), 0, fixed(3), {
      pausedDays: pausedDays([span(0, 6)]),
    });
    expect(r.weeks[0]?.status).toBe("kept");
  });

  it("paused_current_week_is_not_at_risk_and_is_out_of_consistency", () => {
    const r = computeChain(keptWeeks(2), addDays(MON, 19), 0, fixed(3), {
      pausedDays: pausedDays([span(14, null)]),
    });
    expect(r.weeks[r.weeks.length - 1]?.status).toBe("paused");
    expect(r.pausedNow).toBe(true);
    expect(r.atRisk).toBe(false);
    expect(r.needed).toBe(0);
    expect(r.consistency).toBe(100);
  });

  it("recap_reports_attendance_not_volume", async () => {
    const { token } = await person();
    const started = Date.now() - 2 * 3_600_000;
    await put(token, "0192a7b8-0000-7000-8000-000000000001", {
      discipline: "run",
      started_at: new Date(started).toISOString(),
      client_updated_at: new Date().toISOString(),
      distance_m: 5000,
      duration_sec: 1500,
      sets: [],
    });
    const week = new Date(started).toISOString().slice(0, 10);
    const recap = await api(`/v1/me/recap?week=${week}`, { token });
    expect(recap.status, await recap.clone().text()).toBe(200);
    const body = await jsonOf<Json>(recap);
    expect(body.sessions).toBe(1);
    expect(body.disciplines[0].id).toBe("run");
    expect(JSON.stringify(body).toLowerCase().replaceAll("disciplines", "")).not.toContain("distance");

    const future = addDays(new Date().toISOString().slice(0, 10), 30);
    expect((await api(`/v1/me/recap?week=${future}`, { token })).status).toBe(422);
  });

  it("only_an_admin_can_grant_official_status", async () => {
    const brand = await person("brandteam");
    const admin = await person("boss");
    const grant = { official: true, handle: "pacestreak" };
    const call = (token: string, json: unknown) =>
      api(`/v1/admin/users/${brand.userId}/official`, { token, method: "POST", json });
    // Not an admin (and asking for itself): the endpoint does not exist.
    expect((await call(brand.token, grant)).status).toBe(404);

    await makeRole(admin.userId, "admin");
    const ok = await call(admin.token, grant);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await jsonOf(ok)).toEqual({ official: true, handle: "pacestreak" });

    const profile = await get(admin.token, "/v1/people/pacestreak");
    expect(profile.official).toBe(true);
    const named = await api("/v1/me/profile", {
      token: brand.token,
      method: "PATCH",
      json: { display_name: "PaceStreak" },
    });
    expect(named.status).toBe(200);

    expect((await call(admin.token, { official: false })).status).toBe(409);
    const revoke = await call(admin.token, { official: false, handle: "brandteam" });
    expect(await jsonOf(revoke)).toEqual({ official: false, handle: "brandteam" });
    const audit: Json[] = await get(admin.token, "/v1/admin/audit");
    expect(audit.some((a) => a.action === "user.official")).toBe(true);
  });

  it("year_review_and_record_history", async () => {
    const { token } = await person();
    const now = Date.now();
    for (const [daysAgo, kg] of [
      [20, 60],
      [10, 65],
      [1, 70],
    ] as const) {
      const res = await put(token, crypto.randomUUID(), {
        discipline: "strength",
        started_at: new Date(now - daysAgo * 86_400_000).toISOString(),
        client_updated_at: new Date(now).toISOString(),
        sets: [{ exercise_id: "back-squat", position: 0, set_index: 0, weight_kg: kg, reps: 5 }],
      });
      expect(res.status).toBe(200);
    }

    const review = await api("/v1/me/review", { token });
    expect(review.status, await review.clone().text()).toBe(200);
    const r = await jsonOf<Json>(review);
    expect(r.sessions).toBe(3);
    expect(r.days_trained).toBe(3);
    // Attendance, never volume.
    for (const k of ["tonnage", "distance", "calories", "volume"]) expect(k in r).toBe(false);

    const history = await api("/v1/me/records/history?key=e1rm:back-squat", { token });
    expect(history.status, await history.clone().text()).toBe(200);
    const points: Json[] = (await jsonOf<Json>(history)).points;
    expect(points[0].kind).toBe("first");
    const values = points.map((p) => Math.round(p.value));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(points.length).toBe(3);

    expect((await api("/v1/me/review?year=2001", { token })).status).toBe(404);
  });
});
