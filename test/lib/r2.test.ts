import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DELETE_CHUNK, deleteMany, isPhotoType, matchesMagic, storeChecked } from "../../src/lib/r2.ts";

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const WEBP = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")];
const WAV = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVEfmt ")];

let n = 0;
const uniqueKey = () => `test/${Date.now()}-${n++}`;
const put = (key: string, bytes: number[], extra = 0) =>
  env.PHOTOS.put(key, new Uint8Array([...bytes, ...new Array<number>(extra).fill(0)]));

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

/** A stream that hands out `bytes` in chunks of `size`, so a signature can straddle chunks. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}
const bytes = (head: number[], extra = 0) => new Uint8Array([...head, ...new Array<number>(extra).fill(7)]);

describe("storeChecked", () => {
  it("stores a matching body whole, with its type, even when the signature spans chunks", async () => {
    const key = uniqueKey();
    const body = bytes(PNG, 5000);
    expect(await storeChecked(env.PHOTOS, key, "image/png", chunked(body, 3), body.length)).toEqual({
      ok: true,
    });
    const obj = await env.PHOTOS.get(key);
    expect(obj?.size).toBe(body.length);
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array((await obj?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(body);
  });

  it("stores nothing when the bytes do not match the declared type", async () => {
    const key = uniqueKey();
    const body = bytes(WAV, 100);
    expect(await storeChecked(env.PHOTOS, key, "image/webp", chunked(body, 64), body.length)).toEqual({
      ok: false,
      reason: "wrong_type",
    });
    expect(await env.PHOTOS.head(key)).toBeNull();
  });

  it("rejects a body too short to carry its signature", async () => {
    const key = uniqueKey();
    expect(await storeChecked(env.PHOTOS, key, "image/png", chunked(bytes([0x89, 0x50]), 8), 2)).toEqual({
      ok: false,
      reason: "wrong_type",
    });
    expect(await env.PHOTOS.head(key)).toBeNull();
  });

  it("fails and leaves an earlier object alone when the body is longer than declared", async () => {
    const key = uniqueKey();
    await put(key, JPEG);
    const body = bytes(JPEG, 500);
    await expect(storeChecked(env.PHOTOS, key, "image/jpeg", chunked(body, 64), 100)).rejects.toThrow();
    expect((await env.PHOTOS.head(key))?.size).toBe(JPEG.length);
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
