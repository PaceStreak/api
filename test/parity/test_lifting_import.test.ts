/** Port of tests/test_lifting_import.py: Strong, Hevy and FitNotes exports through the import endpoint. */
import { describe, expect, it } from "vitest";
import fitnotes from "../../docs/rewrite/python-tests/fixtures/lifting/fitnotes.csv?raw";
import hevy from "../../docs/rewrite/python-tests/fixtures/lifting/hevy.csv?raw";
import strong from "../../docs/rewrite/python-tests/fixtures/lifting/strong.csv?raw";
import { LB, parseLifting } from "../../src/modules/training/lifting.ts";
import { person } from "../fixtures/game.ts";
import { jsonOf } from "../fixtures/http.ts";
import { get, type Json, upload } from "../fixtures/training.ts";

const send = async (token: string, name: string, data: string, fields: Record<string, string> = {}) => {
  const res = await upload(token, "/v1/workouts/import", { name, data, type: "text/csv" }, fields);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await jsonOf(res)) as Json;
};

const sessions = async (token: string) =>
  ((await get(token, "/v1/workouts/changes?since=0")).workouts as Json[])
    .filter((w) => !w.deleted_at)
    .sort((a, b) => (a.started_at < b.started_at ? -1 : 1));

describe("test_lifting_import", () => {
  it("strong_groups_sets_maps_names_and_keeps_unknowns", async () => {
    const me = await person();
    const body = await send(me.token, "strong.csv", strong, { unit: "kg" });
    expect(body.format).toBe("strong");
    expect([body.imported, body.sets]).toEqual([2, 7]);
    expect(body.new_exercises).toEqual(["Cable Thing Nobody Has (Cable)"]);
    const [push, legs] = await sessions(me.token);
    expect(push.source).toBe("import");
    expect(push.discipline).toBe("strength");
    expect(push.title).toBe("Push day");
    expect(push.duration_sec).toBe(3900);
    const bench = push.sets.filter((s: Json) => s.exercise_id === "bench-press");
    expect(bench.map((s: Json) => [s.kind, s.weight_kg, s.reps])).toEqual([
      ["warmup", 40, 10],
      ["work", 80, 5],
      ["work", 80, 5],
    ]);
    expect(bench[2].rpe).toBe(8.5);
    expect(push.sets.some((s: Json) => s.exercise_id.startsWith("custom-"))).toBe(true);
    expect(legs.sets.find((s: Json) => s.exercise_id === "plank").duration_sec).toBe(60);
    const again = await send(me.token, "strong.csv", strong, { unit: "kg" });
    expect([again.imported, again.duplicates, again.new_exercises]).toEqual([0, 2, []]);
  });

  it("strong_in_pounds_is_converted", () => {
    const result = parseLifting(new TextEncoder().encode(strong), "UTC", "lb");
    expect(result.sessions[0]?.sets[1]?.weightKg).toBeCloseTo(80 * LB);
  });

  it("hevy_set_types_supersets_and_duration", async () => {
    const me = await person();
    const body = await send(me.token, "hevy.csv", hevy);
    expect([body.format, body.imported, body.sets, body.new_exercises]).toEqual(["hevy", 1, 4, []]);
    const [pull] = await sessions(me.token);
    expect(pull.duration_sec).toBe(65 * 60);
    const kinds = Object.fromEntries(pull.sets.map((s: Json) => [`${s.exercise_id}:${s.set_index}`, s]));
    expect(kinds["lat-pulldown:0"].kind).toBe("warmup");
    expect(kinds["barbell-curl:0"].superset).toBe(1);
    expect(kinds["hammer-curl:0"].kind).toBe("drop");
  });

  it("fitnotes_groups_by_day_in_pounds", async () => {
    const me = await person();
    const body = await send(me.token, "fitnotes.csv", fitnotes);
    expect([body.format, body.imported]).toEqual(["fitnotes", 2]);
    const [first, second] = await sessions(me.token);
    const bench = first.sets.filter((s: Json) => s.exercise_id === "bench-press");
    expect(bench.map((s: Json) => Math.round(s.weight_kg * 10) / 10)).toEqual([61.2, 70.3]);
    expect(first.sets.some((s: Json) => s.exercise_id === "back-squat")).toBe(true);
    expect(second.sets[0].distance_m).toBe(5000);
    expect(second.sets[0].duration_sec).toBe(1800);
  });

  it("a_plain_activity_csv_still_uses_the_old_importer", async () => {
    const me = await person();
    const body = await send(me.token, "runs.csv", "date,type,duration,distance\n2026-09-01,run,30:00,5\n");
    expect(body.format).toBe("csv");
  });
});
