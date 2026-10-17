// Progress photos in R2 (DESIGN.md §12, spec/core.md §5).
//
// The PHOTOS binding does every server-side read and delete; it cannot presign, so the two
// browser-facing URLs are SigV4 query-signed locally with aws4fetch (no subrequest).
import { AwsClient } from "aws4fetch";
import type { Config } from "../env.ts";

export type R2Credentials = NonNullable<Config["r2"]>;

/** Seconds a presigned upload URL stays valid (Python: `presigned_put_url` default). */
export const PUT_EXPIRES_S = 300;
/** Seconds a presigned view URL stays valid (Python: `presigned_get_url` default). */
export const GET_EXPIRES_S = 60;
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

function client(creds: R2Credentials): AwsClient {
  // R2 has no regions: "auto" is Cloudflare's documented value.
  return new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

function objectUrl(creds: R2Credentials, bucket: string, key: string): URL {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${creds.accountHost}/${encodeURIComponent(bucket)}/${path}`);
}

/**
 * A URL the browser PUTs the bytes to. Content-Type is a signed header, so a PUT with any other
 * type fails R2's signature check. Nothing about the bytes is trusted until `verifyUpload`.
 */
export async function presignPut(
  creds: R2Credentials,
  bucket: string,
  key: string,
  contentType: string,
): Promise<string> {
  const url = objectUrl(creds, bucket, key);
  url.searchParams.set("X-Amz-Expires", String(PUT_EXPIRES_S));
  const req = await client(creds).sign(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return req.url;
}

/**
 * A single-object view URL. The response overrides are signed into the query, so R2 itself tells
 * the browser the type and never to cache it.
 */
export async function presignGet(
  creds: R2Credentials,
  bucket: string,
  key: string,
  contentType: string,
): Promise<string> {
  const url = objectUrl(creds, bucket, key);
  url.searchParams.set("X-Amz-Expires", String(GET_EXPIRES_S));
  url.searchParams.set("response-content-type", contentType);
  url.searchParams.set("response-cache-control", "private, no-store");
  const req = await client(creds).sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return req.url;
}

export type VerifyResult =
  | { ok: true; size: number }
  | { ok: false; reason: "missing" | "too_large" | "wrong_type" };

/**
 * Confirms what a presigned PUT stored before any row points at it: real size within the cap and
 * first bytes matching the declared type. A rejected object is deleted so it never lingers.
 */
export async function verifyUpload(
  bucket: R2Bucket,
  key: string,
  contentType: string,
  maxBytes: number,
): Promise<VerifyResult> {
  const head = await bucket.head(key);
  if (head === null) return { ok: false, reason: "missing" };
  if (head.size > maxBytes) {
    await bucket.delete(key);
    return { ok: false, reason: "too_large" };
  }
  const obj = await bucket.get(key, { range: { offset: 0, length: MAGIC_READ_BYTES } });
  if (obj === null) return { ok: false, reason: "missing" };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (!matchesMagic(contentType, bytes)) {
    await bucket.delete(key);
    return { ok: false, reason: "wrong_type" };
  }
  return { ok: true, size: head.size };
}

/** Deletes any number of keys, at most DELETE_CHUNK per request. */
export async function deleteMany(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    await bucket.delete(keys.slice(i, i + DELETE_CHUNK));
  }
}
