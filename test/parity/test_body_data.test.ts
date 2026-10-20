/**
 * Port of tests/test_body_data.py: tape measurements and the photo backup. The habit cases in that file belong to
 * HABITS, and the export halves to PROFILE-ACCOUNT. R2 is the real local bucket; photos go up as one raw-body
 * `PUT /v1/body-photos/{id}` and come back as bytes (CHANGES-FROM-PYTHON.md, Photos).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/lib/time.ts";
import { firstWeekTarget, viewHabit } from "../../src/modules/habits/engine.ts";
import { MAX_PHOTO_BYTES, objectKey } from "../../src/modules/training/body.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { putPhoto } from "../fixtures/photos.ts";
import { get, type Json } from "../fixtures/training.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
const today = () => new Date().toISOString().slice(0, 10);

describe("test_body_data", () => {
  it("tape_measurements_round_trip_and_export", async () => {
    const me = await person();
    const day = today();
    const body = { chest_cm: 101.5, arm_cm: 36, thigh_cm: 58.2, waist_cm: 82 };
    expect(
      (await api(`/v1/body-metrics/${day}`, { method: "PUT", json: body, token: me.token })).status,
    ).toBe(200);
    const got = (await get(me.token, "/v1/body-metrics"))[0];
    expect(Object.fromEntries(Object.keys(body).map((k) => [k, got[k]]))).toEqual(body);
    expect(got.neck_cm).toBeNull();
    expect(
      (await api(`/v1/body-metrics/${day}`, { method: "PUT", json: { calf_cm: 0 }, token: me.token })).status,
    ).toBe(422);
    expect((await api(`/v1/body-metrics/${day}`, { method: "PUT", json: {}, token: me.token })).status).toBe(
      422,
    );
  });

  it("photo_backup_is_owner_only_and_checked", async () => {
    const me = await person();
    const other = await person();
    const pid = crypto.randomUUID();
    const up = await putPhoto(me.token, pid, JPEG);
    expect(up.status).toBe(200);
    expect(await jsonOf(up)).toEqual({ id: pid, date: today(), pose: "front", size: JPEG.length });
    expect((await putPhoto(me.token, pid, JPEG, "image/jpeg", { pose: "side" })).status).toBe(200);
    expect((await get(me.token, "/v1/body-photos")).map((p: Json) => [p.id, p.pose])).toEqual([
      [pid, "side"],
    ]);
    const got = await api(`/v1/body-photos/${pid}`, { token: me.token });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);
    expect((await api(`/v1/body-photos/${pid}`, { token: other.token })).status).toBe(404);
    expect((await putPhoto(other.token, pid, JPEG)).status).toBe(409);
    const bad = crypto.randomUUID();
    expect((await putPhoto(me.token, bad, new TextEncoder().encode("<svg/>"))).status).toBe(415);
    expect(await env.PHOTOS.head(objectKey(me.userId, bad))).toBeNull();
    expect((await api(`/v1/body-photos/${bad}`, { token: me.token })).status).toBe(404);
    expect((await putPhoto(me.token, bad, JPEG, "text/html")).status).toBe(415);
    expect((await api(`/v1/body-photos/${pid}`, { token: me.token })).status).toBe(200);
    expect((await api(`/v1/body-photos/${pid}`, { method: "DELETE", token: other.token })).status).toBe(204);
    expect(await get(me.token, "/v1/body-photos")).toHaveLength(1);
    expect((await api("/v1/body-photos", { method: "DELETE", token: me.token })).status).toBe(204);
    expect(await get(me.token, "/v1/body-photos")).toEqual([]);
    expect(await env.PHOTOS.head(objectKey(me.userId, pid))).toBeNull();
  });

  it("oversized_upload_is_rejected_and_swept_from_r2", async () => {
    const me = await person();
    const pid = crypto.randomUUID();
    const big = new Uint8Array(1 + MAX_PHOTO_BYTES);
    big.set(JPEG);
    expect((await putPhoto(me.token, pid, big)).status).toBe(413);
    expect(await env.PHOTOS.head(objectKey(me.userId, pid))).toBeNull();
    expect(await get(me.token, "/v1/body-photos")).toEqual([]);
  });

  it("a_habit_started_mid_week_can_keep_its_first_week", () => {
    const mon = "2026-09-14";
    const thu = addDays(mon, 3);
    expect(firstWeekTarget(7, thu, mon)).toBe(4);
    expect(firstWeekTarget(3, thu, mon)).toBe(3);
    expect(firstWeekTarget(7, thu, addDays(mon, 7))).toBe(7);
    // Daily from a Thursday through the next Sunday: both weeks count.
    const v = viewHabit({
      kind: "check",
      dailyGoal: null,
      weeklyTarget: 7,
      startedOn: thu,
      logs: Array.from({ length: 11 }, (_, i) => ({ day: addDays(thu, i), amount: 1 })),
      today: addDays(thu, 10),
      weekStartsOn: 0,
      pausedDays: new Set(),
    });
    expect(v.chain.current).toBe(2);
    expect(v.chain.weeks[0]?.status).toBe("kept");
  });

  it("habit_list_carries_the_last_seven_days", async () => {
    const me = await person();
    const habit = await jsonOf<Json>(
      await api("/v1/habits", { json: { template_id: "water" }, token: me.token }),
    );
    const day = today();
    const yesterday = addDays(day, -1);
    await api(`/v1/habits/${habit.id}/days/${yesterday}`, {
      method: "PUT",
      json: { amount: 3 },
      token: me.token,
    });
    const recent = (await get(me.token, "/v1/habits"))[0].recent;
    expect(recent).toHaveLength(7);
    expect(recent[6].date).toBe(day);
    expect(recent[5]).toEqual({ date: yesterday, amount: 3, note: null });
  });

  it("habit_day_notes_survive_a_tick_and_can_stand_alone", async () => {
    const me = await person();
    const habit = await jsonOf<Json>(
      await api("/v1/habits", { json: { template_id: "journal" }, token: me.token }),
    );
    const day = today();
    const url = `/v1/habits/${habit.id}/days/${day}`;
    const put = (json: unknown) => api(url, { method: "PUT", json, token: me.token });
    const days = async () => (await get(me.token, `/v1/habits/${habit.id}`)).days;
    expect((await put({ amount: 1, note: "wrote two pages" })).status).toBe(200);
    // A plain tick later, with no note sent, keeps it.
    await put({ amount: 1 });
    expect(await days()).toEqual([{ date: day, amount: 1, note: "wrote two pages" }]);
    // Unticking keeps a day that still has a note, as not done.
    await put({ amount: 0 });
    const kept = (await days())[0];
    expect(kept.amount).toBe(0);
    expect(kept.note).toBe("wrote two pages");
    expect((await get(me.token, "/v1/habits"))[0].today.done).toBe(false);
    // Clearing both removes the day.
    await put({ amount: 0, note: "" });
    expect(await days()).toEqual([]);
  });
});
