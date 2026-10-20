/**
 * Photo bytes through the Worker (CHANGES-FROM-PYTHON.md, Photos): one raw-body PUT streams into the PHOTOS binding,
 * GET streams it back to its owner. No presigned URL, no S3 key.
 */
import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { profiles } from "../src/db/schema/index.ts";
import { purgeAccounts } from "../src/jobs/tasks/maintenance.ts";
import { MAX_PHOTO_BYTES, objectKey } from "../src/modules/training/body.ts";
import { testDb } from "./fixtures/db.ts";
import { person } from "./fixtures/game.ts";
import { api, BASE, jsonOf, randomIp } from "./fixtures/http.ts";
import { JPEG, PNG, putPhoto, WEBP } from "./fixtures/photos.ts";
import { get, type Json } from "./fixtures/training.ts";
import { jobCtx } from "./jobs/helpers.ts";

const id = () => crypto.randomUUID();

describe("PUT /v1/body-photos/{id}", () => {
  it("stores JPEG, PNG and WebP with their real size and type, in two D1 round trips", async () => {
    const me = await person();
    for (const [bytes, type] of [
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
      [WEBP, "image/webp"],
    ] as const) {
      const pid = id();
      const res = await putPhoto(me.token, pid, bytes, type, { pose: "back" });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-D1-Round-Trips")).toBe("2");
      expect(((await jsonOf(res)) as Json).size).toBe(bytes.length);
      const obj = await env.PHOTOS.get(objectKey(me.userId, pid));
      expect(obj?.httpMetadata?.contentType).toBe(type);
      expect(new Uint8Array((await obj?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes);
    }
    expect(await get(me.token, "/v1/body-photos")).toHaveLength(3);
  });

  it("takes the media type without parameters or case", async () => {
    const me = await person();
    expect((await putPhoto(me.token, id(), PNG, "Image/PNG; foo=bar")).status).toBe(200);
  });

  it("refuses bytes that are not the declared type, keeping an earlier version", async () => {
    const me = await person();
    const pid = id();
    expect((await putPhoto(me.token, pid, JPEG)).status).toBe(200);
    const res = await putPhoto(me.token, pid, PNG, "image/jpeg");
    expect(res.status).toBe(415);
    expect(await jsonOf(res)).toEqual({ detail: "Not the image type it claims" });
    expect((await putPhoto(me.token, id(), WEBP, "image/png")).status).toBe(415);
    expect((await putPhoto(me.token, id(), JPEG, "image/gif")).status).toBe(415);
    const kept = await api(`/v1/body-photos/${pid}`, { token: me.token });
    expect(new Uint8Array(await kept.arrayBuffer())).toEqual(JPEG);
  });

  it("refuses a photo over 2 MiB from its Content-Length, and a body without one", async () => {
    const me = await person();
    const pid = id();
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    const res = await putPhoto(me.token, pid, big);
    expect(res.status).toBe(413);
    expect(await jsonOf(res)).toEqual({ detail: "That photo is too large" });
    const exact = new Uint8Array(MAX_PHOTO_BYTES);
    exact.set(JPEG);
    expect((await putPhoto(me.token, pid, exact)).status).toBe(200);
    const streamed = await SELF.fetch(`${BASE}/v1/body-photos/${id()}?date=2026-01-01&pose=front`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        Authorization: `Bearer ${me.token}`,
        "CF-Connecting-IP": randomIp(),
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(JPEG);
          c.close();
        },
      }),
    });
    expect(streamed.status).toBe(411);
    expect((await putPhoto(me.token, id(), new Uint8Array(0))).status).toBe(400);
  });

  it("validates date and pose, and needs a session", async () => {
    const me = await person();
    expect((await putPhoto(me.token, id(), JPEG, "image/jpeg", { pose: "top" })).status).toBe(422);
    expect((await putPhoto(me.token, id(), JPEG, "image/jpeg", { date: "2999-01-01" })).status).toBe(422);
    const pid = id();
    expect((await putPhoto(undefined, pid, JPEG)).status).toBe(401);
    expect((await api(`/v1/body-photos/${pid}`)).status).toBe(401);
    expect(await env.PHOTOS.head(objectKey(me.userId, pid))).toBeNull();
  });

  it("counts every upload against body-photo (60 an hour), refused ones included", async () => {
    const me = await person();
    const svg = new TextEncoder().encode("<svg/>");
    for (let i = 0; i < 60; i++) expect((await putPhoto(me.token, id(), svg)).status).toBe(415);
    const res = await putPhoto(me.token, id(), JPEG);
    expect(res.status).toBe(429);
    expect(await get(me.token, "/v1/body-photos")).toEqual([]);
  });
});

describe("GET /v1/body-photos/{id}", () => {
  it("streams the owner's bytes with private, no-sniff, inline headers", async () => {
    const me = await person();
    const pid = id();
    await putPhoto(me.token, pid, PNG, "image/png");
    const res = await api(`/v1/body-photos/${pid}`, { token: me.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(PNG.length));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("is 404 for another account, after a delete, and when the object is gone", async () => {
    const me = await person();
    const other = await person();
    const pid = id();
    await putPhoto(me.token, pid, JPEG);
    expect((await api(`/v1/body-photos/${pid}`, { token: other.token })).status).toBe(404);
    expect((await api(`/v1/body-photos/${id()}`, { token: me.token })).status).toBe(404);
    const lost = id();
    await putPhoto(me.token, lost, JPEG);
    await env.PHOTOS.delete(objectKey(me.userId, lost));
    expect((await api(`/v1/body-photos/${lost}`, { token: me.token })).status).toBe(404);
    expect((await api(`/v1/body-photos/${pid}`, { method: "DELETE", token: me.token })).status).toBe(204);
    expect(await env.PHOTOS.head(objectKey(me.userId, pid))).toBeNull();
    expect((await api(`/v1/body-photos/${pid}`, { token: me.token })).status).toBe(404);
  });
});

describe("account purge", () => {
  it("removes uploaded photo objects", async () => {
    const me = await person();
    const keys = [id(), id()].map((pid) => objectKey(me.userId, pid));
    for (const k of keys) await putPhoto(me.token, k.split("/").at(-1) ?? "", JPEG);
    for (const k of keys) expect(await env.PHOTOS.head(k)).not.toBeNull();
    const { db } = testDb();
    await db
      .update(profiles)
      .set({ deletionScheduledAt: Date.now() - 86_400_000 })
      .where(eq(profiles.userId, me.userId));
    expect(await purgeAccounts(jobCtx(), [me.userId])).toBe(1);
    for (const k of keys) expect(await env.PHOTOS.head(k)).toBeNull();
  });
});
