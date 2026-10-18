/** Port of tests/test_habit_schedule.py: habits on chosen weekdays, and pausing one habit on its own. */
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { firstWeekTarget, pauseDays, scheduled } from "../../src/modules/habits/engine.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";

const MON = "2026-09-28";
const MWF = 0b0010101; // Monday, Wednesday, Friday
const today = () => new Date().toISOString().slice(0, 10);

type Habit = Record<string, unknown> & { id: string };

async function habit(token: string, body: Record<string, unknown> = {}): Promise<Habit> {
  const res = await api("/v1/habits", { token, json: { name: "Gym", ...body } });
  expect(res.status, await res.clone().text()).toBe(201);
  return jsonOf<Habit>(res);
}

describe("test_habit_schedule", () => {
  it("scheduled_days", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => scheduled(MWF, addDays(MON, i)))).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(scheduled(null, MON)).toBe(true);
  });

  it("first_week_counts_only_planned_days_left", () => {
    // Started on Thursday: only Friday is left of Mon/Wed/Fri.
    expect(firstWeekTarget(3, addDays(MON, 3), MON, MWF)).toBe(1);
    expect(firstWeekTarget(3, MON, MON, MWF)).toBe(3);
    expect(firstWeekTarget(3, addDays(MON, 7), addDays(MON, 7), null)).toBe(3);
  });

  it("pause_days_stop_at_today", () => {
    const t = addDays(MON, 3);
    expect(pauseDays(MON, null, t)).toEqual(new Set([0, 1, 2, 3].map((i) => addDays(MON, i))));
    expect(pauseDays(MON, addDays(MON, 1), t)).toEqual(new Set([MON, addDays(MON, 1)]));
    expect(pauseDays(null, null, t)).toEqual(new Set());
  });

  it("picking_days_sets_the_target", async () => {
    const { token } = await person();
    const h = await habit(token, { days_mask: MWF });
    expect([h.days_mask, h.weekly_target]).toEqual([MWF, 3]);
    const smaller = await habit(token, { name: "Read", days_mask: MWF, weekly_target: 2 });
    expect(smaller.weekly_target).toBe(2);
    // A target above the planned days is brought down to them.
    const tooMany = await api(`/v1/habits/${smaller.id}`, {
      token,
      method: "PATCH",
      json: { weekly_target: 6 },
    });
    expect((await jsonOf<Habit>(tooMany)).weekly_target).toBe(3);
    // Clearing the schedule leaves the target alone.
    const cleared = await jsonOf<Habit>(
      await api(`/v1/habits/${h.id}`, { token, method: "PATCH", json: { days_mask: null } }),
    );
    expect([cleared.days_mask, cleared.scheduled_today]).toEqual([null, true]);
  });

  it("a_quit_habit_has_no_schedule", async () => {
    const { token } = await person();
    const h = await habit(token, { name: "No smoking", kind: "quit", days_mask: MWF });
    expect(h.days_mask).toBeNull();
  });

  it("pause_and_resume_one_habit", async () => {
    const { token } = await person();
    const h = await habit(token);
    const paused = await api(`/v1/habits/${h.id}/pause`, { token, json: {} });
    expect(paused.status, await paused.clone().text()).toBe(200);
    const p = await jsonOf<Habit>(paused);
    expect(p.paused).toBe(true);
    expect(p.paused_until).toBeNull();

    const resumed = await jsonOf<Habit>(await api(`/v1/habits/${h.id}/resume`, { token, method: "POST" }));
    // Paused from today, so resuming today removes it entirely.
    expect(resumed.paused).toBe(false);
    expect(resumed.paused_from).toBeNull();
  });

  it("pause_limits", async () => {
    const { token } = await person();
    const h = await habit(token);
    const url = `/v1/habits/${h.id}/pause`;
    expect((await api(url, { token, json: { start: addDays(today(), 90) } })).status).toBe(422);
    const start = today();
    const before = addDays(start, -1);
    expect((await api(url, { token, json: { start, until: before } })).status).toBe(422);
  });
});
