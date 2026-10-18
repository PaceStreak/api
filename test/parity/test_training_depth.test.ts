/** Port of tests/test_training_depth.py: splits from tracks, supersets on sets, plans shared as files. */
import { describe, expect, it } from "vitest";
import { kmSplits, parseGpxFile } from "../../src/modules/training/importers.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { at, get, HOUR, type Json, put, upload } from "../fixtures/training.ts";

const T0 = Date.UTC(2026, 8, 20, 7, 0);

function gpx(km: number, secsPerKm: number): string {
  const n = Math.trunc((km * 1000) / 111.2) + 1;
  const points: string[] = [];
  for (let i = 0; i < n; i++) {
    const when = new Date(T0 + Math.round(((i * 111.2 * secsPerKm) / 1000) * 1e6) / 1000).toISOString();
    points.push(`<trkpt lat="${(51 + i * 0.001).toFixed(6)}" lon="0"><time>${when}</time></trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`;
}

describe("test_training_depth", () => {
  it("splits_interpolate_the_crossing_and_keep_the_remainder", () => {
    const track: [number, number][] = [];
    for (let d = 0; d <= 2500; d += 100) track.push([d, T0 + (d / 4) * 1000]);
    expect(kmSplits(track)).toEqual([
      { m: 1000, sec: 250 },
      { m: 1000, sec: 250 },
      { m: 500, sec: 125 },
    ]);
  });

  it("sparse_samples_still_split_honestly", () => {
    const track: [number, number][] = [
      [0, T0],
      [900, T0 + 270_000],
      [1300, T0 + 390_000],
    ];
    expect(kmSplits(track)[0]).toEqual({ m: 1000, sec: 300 });
  });

  it("too_short_to_split", () => {
    expect(
      kmSplits([
        [0, T0],
        [50, T0 + 20_000],
      ]),
    ).toEqual([]);
  });

  it("gpx_import_carries_splits", async () => {
    const me = await person();
    const up = await upload(me.token, "/v1/workouts/import", { name: "run.gpx", data: gpx(3.2, 300) });
    expect(up.status, await up.clone().text()).toBe(200);
    const w = (await get(me.token, "/v1/workouts"))[0];
    const whole = w.splits.filter((s: Json) => s.m === 1000);
    expect(whole).toHaveLength(3);
    for (const s of whole) expect(Math.abs(s.sec - 300)).toBeLessThanOrEqual(2);
    expect(parseGpxFile(new TextEncoder().encode(gpx(1.5, 360))).sessions[0]?.splits[0]?.m).toBe(1000);
  });

  it("supersets_and_splits_survive_a_client_edit", async () => {
    const me = await person();
    const wid = crypto.randomUUID();
    const body = {
      discipline: "strength",
      started_at: at(-HOUR),
      client_updated_at: at(0),
      sets: [
        { exercise_id: "bench-press", position: 0, set_index: 0, weight_kg: 60, reps: 8, superset: 1 },
        { exercise_id: "barbell-row", position: 1, set_index: 0, weight_kg: 50, reps: 8, superset: 1 },
        { exercise_id: "plank", position: 2, set_index: 0, duration_sec: 45 },
      ],
      splits: [{ m: 1000, sec: 300 }],
    };
    const saved: Json = ((await jsonOf(await put(me.token, wid, body))) as Json).workout;
    expect(saved.sets.map((s: Json) => s.superset)).toEqual([1, 1, null]);
    expect(saved.splits).toEqual([{ m: 1000, sec: 300 }]);
    const bad = { ...body, splits: [{ m: 5000, sec: 1 }], client_updated_at: at(1000) };
    expect((await put(me.token, wid, bad)).status).toBe(422);
  });

  it("plans_round_trip_as_files", async () => {
    const a = await person();
    const b = await person();
    const plan: Json = await jsonOf(
      await api("/v1/plans", { json: { template_id: "plan-strength-foundations" }, token: a.token }),
    );
    const exported = await api(`/v1/plans/${plan.id}/export`, { token: a.token });
    expect(exported.status).toBe(200);
    const data: Json = await jsonOf(exported);
    expect(data.format).toBe("pacestreak-plan");
    const first = data.weeks[0][0];
    expect("routine_id" in first).toBe(false);
    expect(first.routine.name).toBe("Full body A");
    const imported = await api("/v1/plans/import", { json: data, token: b.token });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const theirs = Object.fromEntries((await get(b.token, "/v1/routines")).map((r: Json) => [r.name, r.id]));
    expect(((await jsonOf(imported)) as Json).weeks[0][0].routine_id).toBe(theirs["Full body A"]);
    await api("/v1/plans/import", { json: data, token: b.token });
    expect(await get(b.token, "/v1/routines")).toHaveLength(Object.keys(theirs).length);
    const wrong = await api("/v1/plans/import", {
      json: { ...data, format: "something-else" },
      token: b.token,
    });
    expect(wrong.status).toBe(422);
    expect((await api(`/v1/plans/${plan.id}/export`, { token: b.token })).status).toBe(404);
  });
});
