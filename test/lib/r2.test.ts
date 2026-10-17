import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  DELETE_CHUNK,
  deleteMany,
  isPhotoType,
  matchesMagic,
  presignGet,
  presignPut,
  verifyUpload,
} from "../../src/lib/r2.ts";

const creds = {
  accessKeyId: "AKTEST",
  secretAccessKey: "secret",
  accountHost: "acct.r2.cloudflarestorage.com",
};
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const WEBP = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")];
const WAV = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVEfmt ")];

let n = 0;
const uniqueKey = () => `test/${Date.now()}-${n++}`;
const put = (key: string, bytes: number[], extra = 0) =>
  env.PHOTOS.put(key, new Uint8Array([...bytes, ...new Array<number>(extra).fill(0)]));

describe("presigned URLs", () => {
  it("PUT signs Content-Type and expires in 300 s", async () => {
    const url = new URL(await presignPut(creds, "pacestreak-photos", "body/u 1/p.jpg", "image/jpeg"));
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/pacestreak-photos/body/u%201/p.jpg");
    const q = url.searchParams;
    expect(q.get("X-Amz-Expires")).toBe("300");
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toMatch(/^AKTEST\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(q.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-type");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a different Content-Type gives a different signature", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 18, 12) });
    try {
      const sig = async (ct: string) =>
        new URL(await presignPut(creds, "b", "k", ct)).searchParams.get("X-Amz-Signature");
      expect(await sig("image/jpeg")).toBe(await sig("image/jpeg"));
      expect(await sig("image/jpeg")).not.toBe(await sig("image/png"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET carries signed response overrides and expires in 60 s", async () => {
    const url = new URL(await presignGet(creds, "pacestreak-photos", "body/u/p", "image/png"));
    const q = url.searchParams;
    expect(q.get("X-Amz-Expires")).toBe("60");
    expect(q.get("response-content-type")).toBe("image/png");
    expect(q.get("response-cache-control")).toBe("private, no-store");
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("magic bytes", () => {
  it("accepts exactly the old allowed types", () => {
    expect(["image/jpeg", "image/png", "image/webp"].every(isPhotoType)).toBe(true);
    expect(isPhotoType("image/gif")).toBe(false);
    expect(isPhotoType("toString")).toBe(false);
  });

  it("matches each signature and rejects the others", () => {
    const u8 = (a: number[]) => new Uint8Array(a);
    expect(matchesMagic("image/jpeg", u8(JPEG))).toBe(true);
    expect(matchesMagic("image/png", u8(PNG))).toBe(true);
    expect(matchesMagic("image/webp", u8(WEBP))).toBe(true);
    expect(matchesMagic("image/png", u8(JPEG))).toBe(false);
    expect(matchesMagic("image/webp", u8(WAV))).toBe(false);
    expect(matchesMagic("image/jpeg", u8([0xff, 0xd8]))).toBe(false);
    expect(matchesMagic("constructor", u8(JPEG))).toBe(false);
  });
});

describe("verifyUpload", () => {
  it("returns the real size for a valid object", async () => {
    const key = uniqueKey();
    await put(key, JPEG, 1000);
    expect(await verifyUpload(env.PHOTOS, key, "image/jpeg", 5000)).toEqual({ ok: true, size: 1018 });
    expect(await env.PHOTOS.head(key)).not.toBeNull();
  });

  it("reports a missing object", async () => {
    expect(await verifyUpload(env.PHOTOS, uniqueKey(), "image/jpeg", 5000)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("deletes an oversized object", async () => {
    const key = uniqueKey();
    await put(key, PNG, 100);
    expect(await verifyUpload(env.PHOTOS, key, "image/png", 50)).toEqual({ ok: false, reason: "too_large" });
    expect(await env.PHOTOS.head(key)).toBeNull();
  });

  it("deletes an object whose bytes do not match the declared type", async () => {
    const key = uniqueKey();
    await put(key, WAV, 100);
    expect(await verifyUpload(env.PHOTOS, key, "image/webp", 5000)).toEqual({
      ok: false,
      reason: "wrong_type",
    });
    expect(await env.PHOTOS.head(key)).toBeNull();
  });
});

describe("deleteMany", () => {
  it("deletes in chunks of at most 1000 keys", async () => {
    const keys = Array.from({ length: 2 * DELETE_CHUNK + 5 }, uniqueKey);
    await Promise.all(
      keys
        .slice(0, 3)
        .concat(keys.slice(-3))
        .map((k) => put(k, JPEG)),
    );
    const spy = vi.spyOn(env.PHOTOS, "delete");
    try {
      await deleteMany(env.PHOTOS, keys);
      expect(spy.mock.calls.map(([arg]) => (Array.isArray(arg) ? arg.length : 1))).toEqual([1000, 1000, 5]);
    } finally {
      spy.mockRestore();
    }
    for (const k of [keys[0], keys[keys.length - 1]]) expect(await env.PHOTOS.head(k ?? "")).toBeNull();
  });

  it("does nothing for no keys", async () => {
    const spy = vi.spyOn(env.PHOTOS, "delete");
    await deleteMany(env.PHOTOS, []);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
