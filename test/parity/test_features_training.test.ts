/**
 * The training half of tests/test_features.py (pauses through the API, file import), plus test_qol.py's workout
 * undo and test_habits.py's monthly goal and rest days, whose routes live in the training module. The engine-only
 * pause rules sit beside the game engine; SOCIAL ports the rest of test_features.py.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { trashItems } from "../../src/db/schema/index.ts";
import { addDays } from "../../src/lib/time.ts";
import { effectiveEnd, PAUSE_MAX_DAYS, pauseEndFor, pauseError } from "../../src/modules/game/service.ts";
import {
  ImportFormatError,
  parse,
  parseCsvFile,
  parseGpxFile,
} from "../../src/modules/training/importers.ts";
import { testDb } from "../fixtures/db.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { at, get, type Json, logSession, put, upload, workout } from "../fixtures/training.ts";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Morning run</name><type>running</type><trkseg>
    <trkpt lat="51.5000" lon="-0.1000"><ele>10</ele><time>2026-09-01T07:00:00Z</time></trkpt>
    <trkpt lat="51.5090" lon="-0.1000"><ele>20</ele><time>2026-09-01T07:05:00Z</time></trkpt>
    <trkpt lat="51.5180" lon="-0.1000"><ele>15</ele><time>2026-09-01T07:10:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

const BOMB = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;">]>
<gpx><trk><name>&lol2;</name></trk></gpx>`;

const enc = (s: string) => new TextEncoder().encode(s);
const todayUtc = () => new Date().toISOString().slice(0, 10);

describe("test_features (training)", () => {
  it("pause_rules", () => {
    const today = "2026-09-25";
    expect(pauseError({ startsOn: addDays(today, -15), endsOn: null }, [], today)).not.toBeNull();
    expect(pauseError({ startsOn: addDays(today, 31), endsOn: null }, [], today)).not.toBeNull();
    expect(pauseError({ startsOn: today, endsOn: addDays(today, PAUSE_MAX_DAYS) }, [], today)).not.toBeNull();
    const first = { startsOn: addDays(today, -5), endsOn: addDays(today, 5) };
    expect(pauseError(first, [], today)).toBeNull();
    expect(pauseError({ startsOn: today, endsOn: null }, [first], today)).not.toBeNull();
    expect(effectiveEnd({ startsOn: today, endsOn: null })).toBe(addDays(today, PAUSE_MAX_DAYS - 1));
  });

  it("pause_budget_is_bounded", () => {
    const today = "2026-09-25";
    const held = [{ startsOn: addDays(today, -300), endsOn: addDays(today, -300 + 83) }];
    expect(pauseError({ startsOn: today, endsOn: addDays(today, 60) }, held, today)).toContain("120");
  });

  it("ending_a_pause", () => {
    const today = "2026-09-25";
    expect(pauseEndFor({ startsOn: addDays(today, -4), endsOn: null }, today)).toBe(addDays(today, -1));
    expect(pauseEndFor({ startsOn: today, endsOn: null }, today)).toBeNull();
  });

  it("pause_lifecycle", async () => {
    const me = await person();
    const today = todayUtc();
    const created = await api("/v1/pauses", {
      json: { starts_on: addDays(today, -2), reason: "injury" },
      token: me.token,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const pause: Json = await jsonOf(created);
    expect(pause.active).toBe(true);
    const stats = await get(me.token, "/v1/me/stats");
    expect(stats.paused_today).toBe(true);
    expect(stats.pauses[0].reason).toBe("injury");
    expect((await api("/v1/pauses", { json: { starts_on: today }, token: me.token })).status).toBe(409);
    const ended = await api(`/v1/pauses/${pause.id}/end`, { method: "POST", token: me.token });
    expect(ended.status).toBe(200);
    expect(((await jsonOf(ended)) as Json).pauses[0].ends_on).toBe(addDays(today, -1));
    expect((await get(me.token, "/v1/me/stats")).paused_today).toBe(false);
    const listed = await get(me.token, "/v1/pauses");
    expect(listed.budget).toEqual({ days_used: 2, days_allowed: 120 });
    // Declared moments ago: deleting is still allowed as an undo.
    expect((await api(`/v1/pauses/${pause.id}`, { method: "DELETE", token: me.token })).status).toBe(204);
    expect((await get(me.token, "/v1/pauses")).pauses).toEqual([]);
  });

  it("pauses_are_private", async () => {
    const a = await person();
    const b = await person();
    const pause: Json = await jsonOf(
      await api("/v1/pauses", { json: { starts_on: todayUtc() }, token: a.token }),
    );
    expect((await api(`/v1/pauses/${pause.id}/end`, { method: "POST", token: b.token })).status).toBe(404);
    expect((await api(`/v1/pauses/${pause.id}`, { method: "DELETE", token: b.token })).status).toBe(404);
  });

  it("gpx_parser", () => {
    const r = parseGpxFile(enc(GPX));
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s?.discipline).toBe("run");
    expect(s?.title).toBe("Morning run");
    expect(s?.durationSec).toBe(600);
    expect(s?.distanceM).toBeGreaterThan(1900);
    expect(s?.distanceM).toBeLessThan(2100);
    expect(s?.elevationM).toBe(10);
  });

  it("gpx_entity_expansion_is_refused", () => {
    expect(() => parseGpxFile(enc(BOMB))).toThrow(ImportFormatError);
  });

  it("csv_parser_handles_units_durations_and_bad_rows", () => {
    const data =
      "Date,Type,Duration,Distance,Title\n2026-09-01,Running,0:30:00,5,Easy\n2026-09-02T18:00:00,Weight Training,45:00,,Legs\nnot a date,Run,,,\n";
    const r = parseCsvFile(enc(data), "Europe/London");
    expect(r.sessions.map((s) => s.discipline)).toEqual(["run", "strength"]);
    expect(r.sessions[0]?.distanceM).toBe(5000);
    expect(r.sessions[0]?.durationSec).toBe(1800);
    // A bare date is midday local: 12:00 in London (BST) is 11:00 UTC.
    expect(new Date(r.sessions[0]?.startedAt ?? 0).toISOString()).toBe("2026-09-01T11:00:00.000Z");
    expect(r.problems).toEqual(["Row 4 could not be read."]);
  });

  it("unknown_format_is_refused", () => {
    expect(() => parse("notes.txt", enc("hello"), "UTC", null)).toThrow(ImportFormatError);
  });

  it("import_endpoint_is_idempotent_and_marks_source", async () => {
    const me = await person();
    const first = await upload(me.token, "/v1/workouts/import", { name: "run.gpx", data: GPX });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(((await jsonOf(first)) as Json).imported).toBe(1);
    const again: Json = await jsonOf(
      await upload(me.token, "/v1/workouts/import", { name: "run.gpx", data: GPX }),
    );
    expect([again.imported, again.duplicates]).toEqual([0, 1]);
    const ws = await get(me.token, "/v1/workouts");
    expect(ws).toHaveLength(1);
    expect(ws[0].source).toBe("import");
    expect((await upload(me.token, "/v1/workouts/import", { name: "x.fit", data: "nope" })).status).toBe(422);
    const unit = await upload(me.token, "/v1/workouts/import", { name: "r.gpx", data: GPX }, { unit: "st" });
    expect(unit.status).toBe(422);
  });
});

describe("test_qol (workouts)", () => {
  it("undo_by_resaving_a_workout_clears_its_trash_entry", async () => {
    const me = await person();
    const wid = crypto.randomUUID();
    const trash = () =>
      testDb()
        .db.select()
        .from(trashItems)
        .where(and(eq(trashItems.userId, me.userId), eq(trashItems.itemId, wid)));
    await put(me.token, wid, workout());
    await api(`/v1/workouts/${wid}`, { method: "DELETE", token: me.token });
    await api(`/v1/workouts/${wid}`, { method: "DELETE", token: me.token });
    const rows = await trash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toMatch(/^Strength, \d{4}-\d{2}-\d{2}$/);
    expect((await put(me.token, wid, workout({ client_updated_at: at(5000) }))).status).toBe(200);
    expect(await trash()).toEqual([]);
  });
});

describe("test_habits (monthly goal and rest days)", () => {
  it("monthly_goal_counts_distinct_days", async () => {
    const me = await person();
    const month = todayUtc().slice(0, 7);
    await logSession(me.token);
    await logSession(me.token);
    const set = await api("/v1/me/monthly-goal", {
      method: "PUT",
      json: { month, days: 12 },
      token: me.token,
    });
    expect(set.status, await set.clone().text()).toBe(200);
    const view = await get(me.token, "/v1/me/monthly-goal");
    expect([view.goal, view.done]).toEqual([12, 1]);
    for (const json of [
      { month: "2020-01", days: 5 },
      { month: "2099-02", days: 30 },
    ])
      expect((await api("/v1/me/monthly-goal", { method: "PUT", json, token: me.token })).status).toBe(422);
    await api(`/v1/me/monthly-goal/${month}`, { method: "DELETE", token: me.token });
    expect((await get(me.token, "/v1/me/monthly-goal")).goal).toBeNull();
  });

  it("rest_days_are_private_and_never_count", async () => {
    const me = await person();
    const today = todayUtc();
    const r = await api(`/v1/me/rest-days/${today}`, {
      method: "PUT",
      json: { kind: "sleep", note: "  early night " },
      token: me.token,
    });
    expect(r.status).toBe(200);
    expect(((await jsonOf(r)) as Json).note).toBe("early night");
    await api(`/v1/me/rest-days/${today}`, { method: "PUT", json: { kind: "mobility" }, token: me.token });
    expect(await get(me.token, "/v1/me/rest-days")).toEqual([{ day: today, kind: "mobility", note: null }]);
    expect((await get(me.token, "/v1/me/stats")).chains[0].this_week_days).toBe(0);
    expect(
      (await api(`/v1/me/rest-days/${addDays(today, 30)}`, { method: "PUT", json: {}, token: me.token }))
        .status,
    ).toBe(422);
    expect(
      (await api(`/v1/me/rest-days/${today}`, { method: "PUT", json: { kind: "lazy" }, token: me.token }))
        .status,
    ).toBe(422);
  });
});
