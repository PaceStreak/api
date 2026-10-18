/** Port of tests/test_readiness_blocks.py: race plans, blocks, readiness, reflections, heart rate, check-ins. */
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { parseGpxFile } from "../../src/modules/training/importers.ts";
import {
  blockWeek,
  buildRacePlan,
  hrSummary,
  RacePlanError,
  zoneSeconds,
} from "../../src/modules/training/service.ts";
import { person, setProfile } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { get, type Json, put, upload, workout } from "../fixtures/training.ts";

const MON = "2026-09-07";
const uuid = () => crypto.randomUUID();

const HR_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"
 xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><name>HR run</name><type>running</type><trkseg>
<trkpt lat="51.5000" lon="-0.1000"><time>2026-09-01T07:00:00Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="51.5010" lon="-0.1000"><time>2026-09-01T07:00:20Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="51.5020" lon="-0.1000"><time>2026-09-01T07:00:40Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>170</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
</trkseg></trk></gpx>`;

describe("test_readiness_blocks", () => {
  it("race_plan_builds_to_race_day_then_recovers", () => {
    const raceDay = addDays(MON, 75);
    const [first, weeks, name] = buildRacePlan("10k", raceDay, addDays(MON, 2), 0, 3);
    expect(first).toBe(MON);
    expect(weeks).toHaveLength(12);
    const raceWeek = weeks[weeks.length - 2] as Json[];
    expect(raceWeek[raceWeek.length - 1].title).toBe("Race day: 10 km");
    expect(raceWeek[raceWeek.length - 1].day).toBe(5);
    for (const s of raceWeek.slice(0, -1)) expect(s.day).toBeLessThan(5);
    const longs = weeks.slice(0, -3).map((w) => (w[w.length - 1] as Json).minutes as number);
    for (let k = 1; k < longs.length; k++)
      expect(longs[k]).toBeLessThanOrEqual(Math.round(Math.max(...longs.slice(0, k)) * 1.12) + 1);
    expect(longs[3]).toBeLessThan(longs[2] as number);
    expect(weeks[0]?.some((s) => String(s.title).includes("Intervals"))).toBe(false);
    expect(weeks.slice(5, 8).some((w) => w.some((s) => String(s.title).includes("Intervals")))).toBe(true);
    const taper = weeks[weeks.length - 3] as Json[];
    expect(taper[taper.length - 1].minutes).toBeLessThan(Math.max(...longs));
    expect((weeks[weeks.length - 1] as Json[])[0].discipline).toBe("walk");
    expect(name.startsWith("10 km on")).toBe(true);
  });

  it("race_plan_refuses_what_it_cant_do_safely", () => {
    expect(() => buildRacePlan("marathon", addDays(MON, 42), MON, 0, 4)).toThrow(/at least 12 weeks/);
    expect(() => buildRacePlan("5k", MON, MON, 0, 3)).toThrow(RacePlanError);
    expect(() => buildRacePlan("5k", MON, MON, 0, 3)).toThrow(/future/);
    const [first, weeks] = buildRacePlan("half", addDays(MON, 350), MON, 0, 4);
    expect(first > MON).toBe(true);
    expect(weeks).toHaveLength(26);
  });

  it("block_weeks_step_reps_in_reserve_down_then_deload", () => {
    const b = { startsOn: MON, weeks: 5, rirStart: 3, rirEnd: 1, endedAt: null };
    const seen = [0, 1, 2, 3, 4].map((i) => blockWeek(b, addDays(MON, 7 * i + 2)));
    expect(seen.map((x) => x?.rir)).toEqual([3, 2, 2, 1, 4]);
    expect(seen.map((x) => x?.deload)).toEqual([false, false, false, false, true]);
    expect(blockWeek(b, addDays(MON, -1))).toBeNull();
    expect(blockWeek(b, addDays(MON, 35))).toBeNull();
  });

  it("gpx_heart_rate_and_zones", () => {
    const s = parseGpxFile(new TextEncoder().encode(HR_GPX)).sessions[0];
    expect([s?.avgHr, s?.maxHr]).toEqual([135, 170]);
    expect(zoneSeconds(s?.hrSamples ?? [], 200)).toEqual([0, 20, 20, 0, 0]);
    const t = Date.UTC(2026, 8, 1);
    expect(
      zoneSeconds(
        [
          [t, 190],
          [t + 3_600_000, 190],
        ],
        200,
      ),
    ).toEqual([0, 0, 0, 0, 30]);
    expect(
      hrSummary([
        [t, 10],
        [t, 300],
      ]),
    ).toEqual([null, null]);
  });

  it("imported_run_carries_heart_rate_zones", async () => {
    const me = await person();
    // PATCH /v1/me/profile belongs to PROFILE-ACCOUNT; set max_hr the way it would.
    await setProfile(me.userId, { maxHr: 200 });
    const res = await upload(me.token, "/v1/workouts/import", { name: "run.gpx", data: HR_GPX });
    expect(res.status, await res.clone().text()).toBe(200);
    const w = (await get(me.token, "/v1/workouts"))[0];
    expect([w.avg_hr, w.max_hr, w.hr_zones]).toEqual([135, 170, [0, 20, 20, 0, 0]]);
  });

  it("checkin_and_heart_rate_on_a_logged_session", async () => {
    const me = await person();
    const saved: Json = await jsonOf(
      await put(me.token, uuid(), workout({ soreness: 2, pump: 1, avg_hr: 140 })),
    );
    expect([saved.workout.soreness, saved.workout.pump, saved.workout.avg_hr]).toEqual([2, 1, 140]);
    expect((await put(me.token, uuid(), workout({ soreness: 9 }))).status).toBe(422);
  });

  it("race_plan_endpoint_starts_the_plan", async () => {
    const me = await person();
    const raceDay = new Date(Date.now() + 63 * 86_400_000).toISOString().slice(0, 10);
    const made = await api("/v1/plans/race", { json: { race: "10k", race_date: raceDay }, token: me.token });
    expect(made.status, await made.clone().text()).toBe(201);
    expect((await get(me.token, "/v1/plans/active")).id).toBe(((await jsonOf(made)) as Json).id);
    const tooSoon = await api("/v1/plans/race", {
      json: { race: "marathon", race_date: raceDay },
      token: me.token,
    });
    expect(tooSoon.status).toBe(422);
  });

  it("blocks_readiness_and_reflections", async () => {
    const me = await person();
    expect(await get(me.token, "/v1/blocks/active")).toBeNull();
    const block: Json = await jsonOf(await api("/v1/blocks", { json: { weeks: 4 }, token: me.token }));
    expect(block.now.week).toBe(1);
    expect(block.now.rir).toBe(3);
    expect((await api("/v1/blocks", { json: { rir_start: 1, rir_end: 3 }, token: me.token })).status).toBe(
      422,
    );
    const second: Json = await jsonOf(await api("/v1/blocks", { json: { when: "next" }, token: me.token }));
    expect(second.now).toBeNull();
    expect((await get(me.token, "/v1/blocks/active")).id).toBe(second.id);
    await api(`/v1/blocks/${second.id}/end`, { method: "POST", token: me.token });
    expect(await get(me.token, "/v1/blocks/active")).toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    const r = await api(`/v1/readiness/${today}`, {
      method: "PUT",
      json: { sleep: 2, energy: 3, soreness: 4 },
      token: me.token,
    });
    expect(r.status).toBe(200);
    expect(await get(me.token, "/v1/readiness")).toHaveLength(1);
    const old = await api(`/v1/readiness/${addDays(today, -5)}`, {
      method: "PUT",
      json: { sleep: 2, energy: 3, soreness: 4 },
      token: me.token,
    });
    expect(old.status).toBe(422);
    const week = addDays(today, -7);
    const saved: Json = await jsonOf(
      await api(`/v1/reflections/${week}`, {
        method: "PUT",
        json: { went_well: " Three early starts " },
        token: me.token,
      }),
    );
    expect(saved.went_well).toBe("Three early starts");
    expect(await get(me.token, "/v1/reflections")).toHaveLength(1);
    await api(`/v1/reflections/${week}`, { method: "PUT", json: {}, token: me.token });
    expect(await get(me.token, "/v1/reflections")).toEqual([]);
    const other = await person();
    expect((await api(`/v1/blocks/${block.id}/end`, { method: "POST", token: other.token })).status).toBe(
      404,
    );
    // The account-export half of this test belongs to PROFILE-ACCOUNT.
  });
});
