/**
 * Port of tests/test_body_data.py: tape measurements and the photo backup. The habit cases in that file belong to
 * HABITS, and the export halves to PROFILE-ACCOUNT. R2 is the real local bucket; a test stands in for the
 * browser's presigned PUT by writing the object under the key the routes use.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, objectKey } from "../../src/modules/training/body.ts";
import { person } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
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
    const body = { date: today(), pose: "front", content_type: "image/jpeg" };
    const started = await api(`/v1/body-photos/${pid}/upload`, { json: body, token: me.token });
    expect(started.status).toBe(200);
    expect(((await jsonOf(started)) as Json).upload_url).toContain("X-Amz-Signature");
    await env.PHOTOS.put(objectKey(me.userId, pid), JPEG);
    const complete = () => api(`/v1/body-photos/${pid}/upload/complete`, { json: body, token: me.token });
    expect((await complete()).status).toBe(200);
    await env.PHOTOS.put(objectKey(me.userId, pid), JPEG);
    expect((await complete()).status).toBe(200);
    expect((await get(me.token, "/v1/body-photos")).map((p: Json) => p.id)).toEqual([pid]);
    const got = await api(`/v1/body-photos/${pid}`, { token: me.token });
    expect(got.status).toBe(200);
    expect(((await jsonOf(got)) as Json).url).toBeTruthy();
    expect((await api(`/v1/body-photos/${pid}`, { token: other.token })).status).toBe(404);
    expect((await api(`/v1/body-photos/${pid}/upload`, { json: body, token: other.token })).status).toBe(409);
    expect(
      (await api(`/v1/body-photos/${pid}/upload/complete`, { json: body, token: other.token })).status,
    ).toBe(409);
    const bad = crypto.randomUUID();
    await env.PHOTOS.put(objectKey(me.userId, bad), new TextEncoder().encode("<svg/>"));
    expect(
      (await api(`/v1/body-photos/${bad}/upload/complete`, { json: body, token: me.token })).status,
    ).toBe(415);
    expect(await env.PHOTOS.head(objectKey(me.userId, bad))).toBeNull();
    expect((await api(`/v1/body-photos/${bad}`, { token: me.token })).status).toBe(404);
    const text = { ...body, content_type: "text/html" };
    expect((await api(`/v1/body-photos/${bad}/upload`, { json: text, token: me.token })).status).toBe(415);
    const missing = crypto.randomUUID();
    expect(
      (await api(`/v1/body-photos/${missing}/upload/complete`, { json: body, token: me.token })).status,
    ).toBe(400);
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
    const big = new Uint8Array(JPEG.length + MAX_PHOTO_BYTES);
    big.set(JPEG);
    await env.PHOTOS.put(objectKey(me.userId, pid), big);
    const body = { date: today(), pose: "front", content_type: "image/jpeg" };
    expect(
      (await api(`/v1/body-photos/${pid}/upload/complete`, { json: body, token: me.token })).status,
    ).toBe(413);
    expect(await env.PHOTOS.head(objectKey(me.userId, pid))).toBeNull();
    expect(await get(me.token, "/v1/body-photos")).toEqual([]);
  });
});
