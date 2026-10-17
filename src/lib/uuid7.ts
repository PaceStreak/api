/**
 * UUIDv7 (RFC 9562 §5.7), lowercase canonical form.
 *
 * Monotonic within an isolate: ids minted in the same millisecond use the 12-bit `rand_a` field as a counter
 * (RFC 9562 §6.2 method 1), so `a < b` as strings whenever `a` was minted first. If the counter would overflow, the
 * timestamp is advanced by one millisecond, which keeps ordering at the cost of a 1 ms skew under extreme load.
 */
let lastMs = -1;
let counter = 0;

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function uuid7(nowMs: number = Date.now()): string {
  let ms = Math.max(Math.trunc(nowMs), lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) {
      ms++;
      counter = 0;
    }
  } else {
    counter = 0;
  }
  lastMs = ms;

  const b = new Uint8Array(16);
  crypto.getRandomValues(b.subarray(8));
  // 48-bit big-endian unix ms. Division keeps it exact beyond 2^32.
  const hi = Math.floor(ms / 0x10000);
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((counter >>> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);

  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[i] ?? 0];
  }
  return s;
}

/** Milliseconds encoded in a UUIDv7, or null if `id` is not one. */
export function uuid7Time(id: string): number | null {
  if (!UUID7_RE.test(id)) return null;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
