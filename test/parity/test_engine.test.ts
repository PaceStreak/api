/** Port of tests/test_engine.py: the pure engines (streaks, records, XP, levels). No database. */
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { detect, e1rm } from "../../src/modules/game/engine/records.ts";
import { computeChain, requirementsResolver, targetResolver } from "../../src/modules/game/engine/streak.ts";
import {
  computeXp,
  DAY_XP,
  type DayActivity,
  EXTRA_DAY_XP,
  levelForXp,
  xpForLevel,
  xpToReach,
} from "../../src/modules/game/engine/xp.ts";

const MON = "2026-09-07"; // a Monday
const days = (...offsets: number[]) => offsets.map((o) => addDays(MON, o));
const fixed = (target: number) => () => target;
const statuses = (r: { weeks: { status: string }[] }) => r.weeks.map((w) => w.status);

/** {offset: discipline} -> active days and the discipline map. */
function mixed(spec: Record<number, string>) {
  const offsets = Object.keys(spec).map(Number);
  return {
    active: days(...offsets),
    kinds: new Map(offsets.map((o) => [addDays(MON, o), new Set([spec[o] as string])])),
  };
}

const reqs = (from: string, ...pairs: [string[], number][]) =>
  requirementsResolver([{ from, requirements: pairs.map(([disciplines, n]) => ({ disciplines, days: n })) }]);

describe("test_engine", () => {
  it("week_is_kept_when_target_met_and_rest_days_cost_nothing", () => {
    const r = computeChain(days(0, 2, 4), addDays(MON, 8), 0, fixed(3));
    expect(r.weeks[0]?.status).toBe("kept");
    expect(r.current).toBe(1);
  });

  it("current_week_never_breaks_the_streak", () => {
    const r = computeChain(days(0, 2, 4), addDays(MON, 7), 0, fixed(3));
    expect(r.weeks.at(-1)?.status).toBe("open");
    expect(r.current).toBe(1);
  });

  it("missed_week_breaks_without_freeze", () => {
    const r = computeChain(days(0, 2, 4, 14, 16, 18), addDays(MON, 21), 0, fixed(3));
    expect(statuses(r)).toEqual(["kept", "missed", "kept", "open"]);
    expect(r.current).toBe(1);
    expect(r.longest).toBe(1);
  });

  it("freeze_is_earned_every_four_kept_weeks_and_spent_automatically", () => {
    const active = [0, 1, 2, 3].flatMap((w) => days(w * 7, w * 7 + 2, w * 7 + 4));
    active.push(...days(35, 37, 39));
    const r = computeChain(active, addDays(MON, 43), 0, fixed(3));
    expect(statuses(r).slice(0, 6)).toEqual(["kept", "kept", "kept", "kept", "frozen", "kept"]);
    expect(r.current).toBe(6);
    expect(r.freezesAvailable).toBe(0);
  });

  it("repair_counts_a_missed_week", () => {
    const r = computeChain(days(0, 2, 4, 14, 16, 18), addDays(MON, 15), 0, fixed(3), {
      repaired: [addDays(MON, 7)],
    });
    expect(statuses(r)).toEqual(["kept", "repaired", "open"]);
    expect(r.current).toBe(2);
  });

  it("repairable_week_is_offered_only_when_available", () => {
    const today = addDays(MON, 15);
    expect(computeChain(days(0, 2, 4), today, 0, fixed(3), { repairAvailable: true }).repairableWeek).toBe(
      addDays(MON, 7),
    );
    expect(
      computeChain(days(0, 2, 4), today, 0, fixed(3), { repairAvailable: false }).repairableWeek,
    ).toBeNull();
  });

  it("raising_the_target_does_not_rejudge_past_weeks", () => {
    const history = [
      { from: "2000-01-03", target: 3 },
      { from: addDays(MON, 7), target: 5 },
    ];
    const r = computeChain(days(0, 2, 4, 7, 8, 9), addDays(MON, 15), 0, targetResolver(history));
    expect(r.weeks[0]?.status).toBe("kept");
    expect(r.weeks[1]?.status).toBe("missed");
    expect(r.weeks[1]?.target).toBe(5);
  });

  it("at_risk_when_every_remaining_day_is_needed", () => {
    const r = computeChain(days(0), addDays(MON, 4), 0, fixed(4));
    expect([r.needed, r.daysLeft, r.atRisk]).toEqual([3, 3, true]);
  });

  it("week_start_respects_preference", () => {
    const r = computeChain(["2026-09-13"], "2026-09-14", 6, fixed(1));
    expect(r.weeks.at(-1)?.weekStart).toBe("2026-09-13");
    expect(r.weeks.at(-1)?.status).toBe("kept");
  });

  it("e1rm", () => {
    expect(e1rm(100, 1)).toBe(100);
    expect(Math.round(e1rm(100, 5) * 10) / 10).toBe(116.7);
    expect(e1rm(100, 20)).toBe(0);
  });

  it("pr_detection_flags_implausible_jumps_and_respects_cooldown", () => {
    const d0 = "2026-01-01";
    const { events, bests } = detect([
      { key: "e1rm:bench", value: 100, day: d0, workoutId: "a" },
      { key: "e1rm:bench", value: 105, day: addDays(d0, 3), workoutId: "b" },
      { key: "e1rm:bench", value: 108, day: addDays(d0, 5), workoutId: "c" },
      { key: "e1rm:bench", value: 200, day: addDays(d0, 20), workoutId: "d" },
    ]);
    expect(events.map((e) => [e.value, e.rewarded, e.flagged])).toEqual([
      [105, true, false],
      [108, false, false],
      [200, false, true],
    ]);
    expect(bests.get("e1rm:bench")?.value).toBe(200);
  });

  it("lower_is_better_for_pace", () => {
    const d0 = "2026-01-01";
    const { events } = detect([
      { key: "pace_5k:run", value: 330, day: d0, workoutId: "a", higherIsBetter: false },
      { key: "pace_5k:run", value: 320, day: addDays(d0, 10), workoutId: "b", higherIsBetter: false },
    ]);
    expect(events[0]?.rewarded).toBe(true);
    expect(Math.round((events[0]?.gainPct ?? 0) * 10) / 10).toBe(3.0);
  });

  it("same_day_sets_are_one_pr", () => {
    const d0 = "2026-01-01";
    const { events } = detect([
      { key: "e1rm:squat", value: 100, day: d0, workoutId: "a" },
      { key: "e1rm:squat", value: 104, day: addDays(d0, 8), workoutId: "b" },
      { key: "e1rm:squat", value: 106, day: addDays(d0, 8), workoutId: "b" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.value).toBe(106);
  });

  it("xp_does_not_reward_training_every_day", () => {
    const week: DayActivity[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      day: addDays(MON, i),
      sessions: 1,
      detailed: false,
    }));
    const items = computeXp(week, 0, fixed(3), [], [], [], []);
    const dayXp = items.filter((i) => i.source === "training_day").map((i) => i.amount);
    expect(dayXp).toEqual([DAY_XP, DAY_XP, DAY_XP, DAY_XP, EXTRA_DAY_XP, EXTRA_DAY_XP, EXTRA_DAY_XP]);
  });

  it("xp_ignores_load_entirely", () => {
    const one: DayActivity[] = [{ day: MON, sessions: 1, detailed: true }];
    const sum = (xs: { amount: number }[]) => xs.reduce((n, x) => n + x.amount, 0);
    expect(sum(computeXp(one, 0, fixed(3), [], [], [], []))).toBe(
      sum(computeXp(one, 0, fixed(3), [], [], [], [])),
    );
  });

  it("level_curve_is_monotonic_and_consistent", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(xpForLevel(1))).toBe(2);
    for (let level = 1; level < 30; level++) {
      expect(levelForXp(xpToReach(level))).toBe(level);
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
  });

  it("a_week_needs_every_requirement_not_just_the_total", () => {
    const { active, kinds } = mixed({ 0: "run", 1: "run", 2: "run", 3: "run" });
    const r = computeChain(active, addDays(MON, 8), 0, fixed(4), {
      requirementsFor: reqs(MON, [["strength"], 2]),
      dayDisciplines: kinds,
    });
    expect(r.weeks[0]?.status).toBe("missed");
    expect(
      r.weeks[0] && Math.round(Math.min(1, r.weeks[0].days / r.weeks[0].target, r.weeks[0].ratio) * 100),
    ).toBe(0);
  });

  it("requirements_met_keep_the_week", () => {
    const { active, kinds } = mixed({ 0: "run", 2: "strength", 4: "run", 5: "strength" });
    const r = computeChain(active, addDays(MON, 8), 0, fixed(4), {
      requirementsFor: reqs(MON, [["run"], 2], [["strength"], 2]),
      dayDisciplines: kinds,
    });
    expect(r.weeks[0]?.status).toBe("kept");
  });

  it("requirements_never_rejudge_weeks_before_they_existed", () => {
    const { active, kinds } = mixed({
      0: "run",
      2: "run",
      4: "run",
      7: "strength",
      9: "run",
      11: "strength",
    });
    const r = computeChain(active, addDays(MON, 15), 0, fixed(3), {
      requirementsFor: reqs(addDays(MON, 7), [["strength"], 2]),
      dayDisciplines: kinds,
    });
    expect(statuses(r).slice(0, 2)).toEqual(["kept", "kept"]);
    expect(r.current).toBe(2);
  });

  it("needed_counts_the_requirement_shortfall", () => {
    const { active, kinds } = mixed({ 0: "run" });
    const r = computeChain(active, addDays(MON, 1), 0, fixed(3), {
      requirementsFor: reqs(MON, [["run"], 1], [["strength"], 2]),
      dayDisciplines: kinds,
    });
    expect(r.needed).toBe(2);
    expect(r.requirementsProgress.map(([q, done]) => [[...q.disciplines].sort(), done])).toEqual([
      [["run"], 1],
      [["strength"], 0],
    ]);
  });

  it("long_window_consistency_ignores_the_open_week", () => {
    const active = Array.from({ length: 12 }, (_, w) => [
      addDays(MON, 7 * w),
      addDays(MON, 7 * w + 1),
    ]).flat();
    const r = computeChain(active, addDays(MON, 7 * 12 + 1), 0, fixed(4));
    expect([r.consistency, r.consistency12, r.consistency52]).toEqual([50, 50, 50]);
  });
});
