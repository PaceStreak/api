/**
 * Shared pieces for the heavy readers: the user-facing format error and byte helpers.
 *
 * Every reader keeps its resumable state as plain JSON (numbers, strings, booleans, arrays), so an
 * import slice can store `{offset, state}` on the job row and the next slice can carry on from any
 * byte offset. Bytes that must survive between slices (an unfinished token, a split UTF-8 sequence)
 * are kept as "binary strings": one char per byte, code points 0-255.
 */

/** The file as a whole could not be read. `message` is shown to the user verbatim (a 422 detail). */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8, throwing `FormatError(message)` on invalid sequences. */
export function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new FormatError(message);
  }
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Bytes to a binary string (for JSON state). Chunked to stay clear of argument-count limits. */
export function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export function binaryToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** First index of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  if (first === undefined) return from;
  const last = hay.length - needle.length;
  let i = hay.indexOf(first, from);
  while (i !== -1 && i <= last) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = hay.indexOf(first, i + 1);
  }
  return -1;
}

export const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
