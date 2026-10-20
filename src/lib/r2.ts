// Progress photos in R2 (DESIGN.md §12, spec/core.md §5).
//
// Every read, write and delete goes through the PHOTOS binding: the bytes stream through the Worker, so no S3
// access keys exist anywhere (CHANGES-FROM-PYTHON.md, Photos).

/** R2's DeleteObjects limit per request. */
export const DELETE_CHUNK = 1000;
/** Bytes fetched for the type check: enough for every signature below. */
export const MAGIC_READ_BYTES = 16;

type Signature = (head: Uint8Array) => boolean;
const startsWith = (head: Uint8Array, sig: readonly number[], at = 0): boolean =>
  head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/**
 * The upload types the Python service accepted (photos.py ALLOWED_TYPES), keyed by the declared
 * Content-Type. WebP checks "WEBP" at offset 8 as well as "RIFF": Python checked only "RIFF",
 * which also passes WAV and AVI files.
 */
export const PHOTO_TYPES: Readonly<Record<string, Signature>> = {
  "image/jpeg": (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  "image/png": (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (h) => startsWith(h, ascii("RIFF")) && startsWith(h, ascii("WEBP"), 8),
};

export function isPhotoType(contentType: string): boolean {
  return Object.hasOwn(PHOTO_TYPES, contentType);
}

/** True when `head` (the object's first bytes) matches the declared type. */
export function matchesMagic(contentType: string, head: Uint8Array): boolean {
  const check = Object.hasOwn(PHOTO_TYPES, contentType) ? PHOTO_TYPES[contentType] : undefined;
  return check?.(head) ?? false;
}

export type StoreResult = { ok: true } | { ok: false; reason: "wrong_type" };

/**
 * Streams an upload of exactly `length` bytes into `bucket` under `key`, checking its first bytes against the
 * declared type before anything is stored. Only the first MAGIC_READ_BYTES are inspected; the rest is piped through
 * a FixedLengthStream (R2 needs a known length), so the photo is never buffered whole. A body shorter or longer than
 * `length` errors the stream and the put rejects, so nothing is left behind and an existing object is untouched.
 */
export async function storeChecked(
  bucket: R2Bucket,
  key: string,
  contentType: string,
  body: ReadableStream<Uint8Array>,
  length: number,
): Promise<StoreResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  while (seen < MAGIC_READ_BYTES) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    seen += r.value.byteLength;
  }
  const first = new Uint8Array(seen);
  let at = 0;
  for (const c of chunks) {
    first.set(c, at);
    at += c.byteLength;
  }
  if (!matchesMagic(contentType, first)) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "wrong_type" };
  }
  const fixed = new FixedLengthStream(length);
  const writer = fixed.writable.getWriter();
  const pump = (async () => {
    try {
      let sent = 0;
      const send = async (chunk: Uint8Array) => {
        sent += chunk.byteLength;
        if (sent > length) throw new RangeError("The body is longer than its Content-Length");
        await writer.write(chunk);
      };
      await send(first);
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        await send(r.value);
      }
      if (sent !== length) throw new RangeError("The body is shorter than its Content-Length");
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => undefined);
      throw err;
    }
  })();
  const [stored, pumped] = await Promise.allSettled([
    bucket.put(key, fixed.readable, { httpMetadata: { contentType } }),
    pump,
  ]);
  if (stored.status === "rejected") throw stored.reason;
  if (pumped.status === "rejected") throw pumped.reason;
  return { ok: true };
}

/** Deletes any number of keys, at most DELETE_CHUNK per request. */
export async function deleteMany(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    await bucket.delete(keys.slice(i, i + DELETE_CHUNK));
  }
}
