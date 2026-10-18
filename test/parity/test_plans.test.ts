/** Port of tests/test_plans.py: the pure week matcher, and the API around it. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { trainingPlans } from "../../src/db/schema/index.ts";
import { addDays, pyWeekday } from "../../src/lib/time.ts";
import { matchWeek } from "../../src/modules/training/service.ts";
import { testDb } from "../fixtures/db.ts";
import { person } from "../fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "../fixtures/http.ts";
import { get, type Json, logSession } from "../fixtures/training.ts";

const MON = "2026-09-07";
const s = (day: number, discipline = "run") => ({ day, discipline, title: "x" });
const statuses = (out: Record<string, unknown>[]) => out.map((x) => [x.status, x.moved]);
const todayIdx = () => pyWeekday(new Date().toISOString().slice(0, 10));

describe("test_plans", () => {
  it("a_session_on_its_day_is_done", () => {
    const out = matchWeek([s(0), s(2)], MON, [[MON, "run"]], addDays(MON, 3));
    expect(statuses(out)).toEqual([
      ["done", false],
      ["skipped", false],
    ]);
  });

  it("a_moved_session_still_counts_that_week", () => {
    const out = matchWeek([s(0), s(4)], MON, [[addDays(MON, 1), "run"]], addDays(MON, 2));
    expect([out[0]?.status, out[0]?.moved]).toEqual(["done", true]);
    expect(out[1]?.status).toBe("upcoming");
  });

  it("exact_matches_win_over_moved_ones", () => {
    const done: [string, string][] = [
      [addDays(MON, 2), "run"],
      [addDays(MON, 3), "run"],
    ];
    expect(statuses(matchWeek([s(0), s(2)], MON, done, addDays(MON, 4)))).toEqual([
      ["done", true],
      ["done", false],
    ]);
  });

  it("the_wrong_kind_of_session_does_not_count", () => {
    expect(matchWeek([s(0, "strength")], MON, [[MON, "run"]], MON)[0]?.status).toBe("today");
  });

  it("templates_create_routines_and_start_this_week", async () => {
    const me = await person();
    const templates = await jsonOf<{ id: string }[]>(await api("/v1/plans/templates"));
    const ids = templates.map((t) => t.id);
    expect(ids).toContain("plan-run-from-zero");
    expect(ids).toContain("plan-strength-foundations");
    const plan = await api("/v1/plans", {
      json: { template_id: "plan-strength-foundations" },
      token: me.token,
    });
    expect(plan.status, await plan.clone().text()).toBe(201);
    expectRoundTrips(plan, 2);
    const body: Json = await jsonOf(plan);
    const routineIds = new Set(body.weeks.flatMap((w: Json[]) => w.map((x) => x.routine_id)));
    const routines = Object.fromEntries(
      (await get(me.token, "/v1/routines")).map((r: Json) => [r.id, r.name]),
    );
    for (const id of routineIds) expect(Object.keys(routines)).toContain(id);
    expect(Object.values(routines)).toEqual(expect.arrayContaining(["Full body A", "Full body B"]));
    await api("/v1/plans", { json: { template_id: "plan-strength-foundations" }, token: me.token });
    expect(await get(me.token, "/v1/routines")).toHaveLength(Object.keys(routines).length);
    const started = await api(`/v1/plans/${body.id}/start`, { json: { when: "this" }, token: me.token });
    expect(started.status).toBe(200);
    expectRoundTrips(started, 2);
    expect(((await jsonOf(started)) as Json).current_week).toBe(0);
    expect((await get(me.token, "/v1/plans/active")).id).toBe(body.id);
  });

  it("one_plan_runs_at_a_time_and_logging_completes_it", async () => {
    const me = await person();
    const a: Json = await jsonOf(
      await api("/v1/plans", { json: { template_id: "plan-run-from-zero" }, token: me.token }),
    );
    const custom = {
      name: "Every day",
      weeks: [[0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, discipline: "run", title: "Run" }))],
    };
    const b: Json = await jsonOf(await api("/v1/plans", { json: { plan: custom }, token: me.token }));
    await api(`/v1/plans/${a.id}/start`, { json: {}, token: me.token });
    await api(`/v1/plans/${b.id}/start`, { json: {}, token: me.token });
    const plans = Object.fromEntries((await get(me.token, "/v1/plans")).map((p: Json) => [p.id, p]));
    expect(plans[b.id].active).toBe(true);
    expect(plans[a.id].active).toBe(false);
    const before = await get(me.token, "/v1/plans/active");
    expect(before.today[0].status).toBe("today");
    await logSession(me.token);
    const after = await get(me.token, "/v1/plans/active");
    expect(after.today[0].status).toBe("done");
    expect(after.progress.done).toBe(1);
    expect(after.progress.due).toBe(todayIdx() + 1);
  });

  it("plans_are_private_and_validated", async () => {
    const a = await person();
    const b = await person();
    const mine: Json = await jsonOf(
      await api("/v1/plans", { json: { template_id: "plan-two-a-week" }, token: a.token }),
    );
    expect((await api(`/v1/plans/${mine.id}`, { token: b.token })).status).toBe(404);
    const bad = await api("/v1/plans", {
      json: { plan: { name: "x", weeks: [[{ day: 9, discipline: "run", title: "x" }]] } },
      token: a.token,
    });
    expect(bad.status).toBe(422);
    const theirRoutine = mine.weeks[1][1].routine_id;
    const stolen = await api("/v1/plans", {
      json: {
        plan: {
          name: "x",
          weeks: [[{ day: 0, discipline: "strength", title: "x", routine_id: theirRoutine }]],
        },
      },
      token: b.token,
    });
    expect(stolen.status).toBe(422);
  });

  it("a_repeating_plan_loops_and_never_finishes", async () => {
    const me = await person();
    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, discipline: "run", title: "Run" }));
    const body = { name: "Two-week loop", weeks: [everyDay, everyDay], repeat: true };
    const plan: Json = await jsonOf(await api("/v1/plans", { json: { plan: body }, token: me.token }));
    expect(plan.repeat).toBe(true);
    const started: Json = await jsonOf(
      await api(`/v1/plans/${plan.id}/start`, { json: {}, token: me.token }),
    );
    await testDb()
      .db.update(trainingPlans)
      .set({ startedOn: addDays(started.started_on, -28) })
      .where(eq(trainingPlans.id, plan.id));
    let view = await get(me.token, `/v1/plans/${plan.id}`);
    expect(view.active).toBe(true);
    expect(view.finished_at).toBeNull();
    expect(view.current_week).toBe(0);
    expect(view.cycle).toBe(3);
    expect(view.today[0].status).toBe("today");
    expect(view.progress.due).toBe(todayIdx() + 1);
    await logSession(me.token);
    view = await get(me.token, "/v1/plans/active");
    expect(view.today[0].status).toBe("done");
    await api(`/v1/plans/${plan.id}`, { method: "PUT", json: { ...body, repeat: false }, token: me.token });
    view = await get(me.token, `/v1/plans/${plan.id}`);
    expect(view.active).toBe(false);
    expect(view.finished_at).not.toBeNull();
  });

  it("repeat_survives_sharing", async () => {
    const me = await person();
    const plan: Json = await jsonOf(
      await api("/v1/plans", {
        json: { plan: { name: "My week", weeks: [[]], repeat: true } },
        token: me.token,
      }),
    );
    const shared = await get(me.token, `/v1/plans/${plan.id}/export`);
    expect(shared.repeat).toBe(true);
    const copy: Json = await jsonOf(await api("/v1/plans/import", { json: shared, token: me.token }));
    expect(copy.repeat).toBe(true);
    expect(copy.weeks_count).toBe(1);
  });

  it("routine_items_keep_a_starting_weight", async () => {
    const me = await person();
    const item = { exercise_id: "back-squat", sets: 5, reps_min: 5, reps_max: 5 };
    const made = await api("/v1/routines", {
      json: { name: "Squat day", items: [{ ...item, weight_kg: 60, rest_sec: 180 }] },
      token: me.token,
    });
    expect(made.status).toBe(201);
    expect(((await jsonOf(made)) as Json).items[0].weight_kg).toBe(60);
    for (const step of [0, 51])
      expect(
        (
          await api("/v1/routines", {
            json: { name: "x", items: [{ ...item, increment_kg: step }] },
            token: me.token,
          })
        ).status,
      ).toBe(422);
    const ok: Json = await jsonOf(
      await api("/v1/routines", {
        json: { name: "Pull", items: [{ ...item, increment_kg: 5 }] },
        token: me.token,
      }),
    );
    expect(ok.items[0].increment_kg).toBe(5);
    const bad = await api("/v1/routines", {
      json: { name: "x", items: [{ ...item, weight_kg: -1 }] },
      token: me.token,
    });
    expect(bad.status).toBe(422);
  });

  it("a_template_reuses_one_of_several_same_named_routines", async () => {
    const me = await person();
    for (let i = 0; i < 2; i++)
      expect((await api("/v1/routines", { json: { name: "Push", items: [] }, token: me.token })).status).toBe(
        201,
      );
    const plan = await api("/v1/plans", { json: { template_id: "plan-ppl-six" }, token: me.token });
    expect(plan.status, await plan.clone().text()).toBe(201);
  });
});
