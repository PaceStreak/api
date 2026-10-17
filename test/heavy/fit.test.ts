import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type FitMessage, FitReader, type FitState, fitCrc, parseFit } from "../../src/heavy/fit.ts";
import { cutsFor, feedSliced } from "./helpers.ts";

/** A tiny FIT encoder for fixtures: the importer's messages plus the awkward parts of the format. */
class FitWriter {
  private body: number[] = [];

  /** fields: [fieldNum, size, baseType]; dev: sizes of developer fields. */
  define(
    local: number,
    global: number,
    fields: [number, number, number][],
    opts: { bigEndian?: boolean; dev?: number[] } = {},
  ) {
    const dev = opts.dev ?? [];
    this.body.push(0x40 | (dev.length ? 0x20 : 0) | local, 0, opts.bigEndian ? 1 : 0);
    this.body.push(...u16(global, !opts.bigEndian), fields.length);
    for (const f of fields) this.body.push(...f);
    if (dev.length) {
      this.body.push(dev.length);
      for (const [i, size] of dev.entries()) this.body.push(i, size, 0);
    }
    return this;
  }

  /** values are pre-encoded field bytes in definition order. */
  data(local: number, values: number[][], compressedOffset?: number) {
    this.body.push(compressedOffset === undefined ? local : 0x80 | (local << 5) | compressedOffset);
    for (const v of values) this.body.push(...v);
    return this;
  }

  bytes(): Uint8Array {
    const header = new Uint8Array(14);
    header[0] = 14;
    header[1] = 0x20;
    header.set(u16(2132, true), 2);
    header.set(u32(this.body.length, true), 4);
    header.set([0x2e, 0x46, 0x49, 0x54], 8);
    header.set(u16(fitCrc(header.subarray(0, 12)), true), 12);
    const all = new Uint8Array(14 + this.body.length + 2);
    all.set(header);
    all.set(this.body, 14);
    all.set(u16(fitCrc(all.subarray(0, 14 + this.body.length)), true), 14 + this.body.length);
    return all;
  }
}

function u16(v: number, le: boolean): number[] {
  const b = [v & 0xff, (v >> 8) & 0xff];
  return le ? b : b.reverse();
}
function u32(v: number, le: boolean): number[] {
  const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  return le ? b : b.reverse();
}

const FIT_EPOCH = 631065600;
const T0 = Date.UTC(2026, 8, 1, 6, 0, 0) / 1000 - FIT_EPOCH;

function activity(): Uint8Array {
  const w = new FitWriter()
    // file_id: type enum, manufacturer uint16, time_created uint32
    .define(0, 0, [
      [0, 1, 0x00],
      [1, 2, 0x84],
      [4, 4, 0x86],
    ])
    .data(0, [[4], u16(1, true), u32(T0, true)])
    // An unrelated message (device_info, 23) with a developer field: skipped by its definition.
    .define(1, 23, [[253, 4, 0x86]], { dev: [3] })
    .data(1, [u32(T0, true), [9, 9, 9]])
    // record, big-endian: timestamp, distance(cm), heart_rate, altitude, position_lat
    .define(
      2,
      20,
      [
        [253, 4, 0x86],
        [5, 4, 0x86],
        [3, 1, 0x02],
        [2, 2, 0x84],
        [0, 4, 0x85],
      ],
      { bigEndian: true },
    );
  for (let k = 0; k < 6; k++) {
    w.data(2, [
      u32(T0 + k * 10, false),
      u32(k * 3000, false),
      [k === 3 ? 0xff : 120 + k],
      u16(2550 + k * 5, false),
      u32(0x7fffffff, false),
    ]);
  }
  // Compressed-timestamp records on local 3 (no timestamp field), rolling over the 5-bit offset.
  w.define(3, 20, [
    [5, 4, 0x86],
    [3, 1, 0x02],
  ]);
  const last = T0 + 50;
  w.data(3, [u32(18000, true), [130]], (last + 20) & 0x1f);
  w.data(3, [u32(21000, true), [131]], (last + 40) & 0x1f);
  // Local 2 redefined as a session.
  w.define(2, 18, [
    [253, 4, 0x86],
    [2, 4, 0x86],
    [5, 1, 0x00],
    [6, 1, 0x00],
    [7, 4, 0x86],
    [8, 4, 0x86],
    [9, 4, 0x86],
    [22, 2, 0x84],
    [16, 1, 0x02],
    [17, 1, 0x02],
  ]);
  w.data(2, [
    u32(T0 + 95, true),
    u32(T0, true),
    [1],
    [0],
    u32(95_500, true),
    u32(90_000, true),
    u32(21_000, true),
    u16(12, true),
    [125],
    [0xff],
  ]);
  return w.bytes();
}

const fixture = activity();
// A chained file: a second activity right after the first.
const chained = new Uint8Array([...fixture, ...activity()]);
const ms = (s: number) => (s + FIT_EPOCH) * 1000;

describe("fit reader", () => {
  it("decodes file_id, records (both endiannesses, compressed timestamps) and sessions", () => {
    const { messages, error } = parseFit(fixture);
    expect(error).toBeNull();
    expect(messages[0]).toEqual({
      kind: "file_id",
      type: 4,
      manufacturer: 1,
      product: null,
      serialNumber: null,
      timeCreated: ms(T0),
    });
    const records = messages.filter((m) => m.kind === "record");
    expect(records).toHaveLength(8);
    expect(records[1]).toEqual({
      kind: "record",
      timestamp: ms(T0 + 10),
      lat: null,
      lon: null,
      distance: 30,
      altitude: 11,
      heartRate: 121,
    });
    expect(records[3]?.kind === "record" && records[3].heartRate).toBeNull();
    expect(records.slice(6).map((r) => r.timestamp)).toEqual([ms(T0 + 70), ms(T0 + 90)]);
    expect(messages.at(-1)).toEqual({
      kind: "session",
      timestamp: ms(T0 + 95),
      startTime: ms(T0),
      sport: "running",
      subSport: "generic",
      totalElapsedTime: 95.5,
      totalTimerTime: 90,
      totalDistance: 210,
      totalAscent: 12,
      avgHeartRate: 125,
      maxHeartRate: null,
    });
  });

  it("reads chained files", () => {
    const { messages, error } = parseFit(chained);
    expect(error).toBeNull();
    expect(messages.filter((m) => m.kind === "session")).toHaveLength(2);
  });

  it("keeps what came before a truncation or corruption", () => {
    const cut = parseFit(fixture.subarray(0, fixture.length - 20));
    expect(cut.error).toBe("truncated");
    expect(cut.messages.filter((m) => m.kind === "record")).toHaveLength(8);
    const bad = fixture.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    expect(parseFit(bad).error).toBe("file CRC");
    expect(parseFit(new TextEncoder().encode("<gpx></gpx>")).error).not.toBeNull();
    expect(parseFit(new Uint8Array(0)).error).toBe("empty");
  });

  it("slice-at-any-offset equals whole-file parse (property)", () => {
    for (const bytes of [fixture, chained, fixture.subarray(0, 77)]) {
      const whole = parseFit(bytes);
      fc.assert(
        fc.property(cutsFor(bytes.length), (cuts) => {
          const { out, state } = feedSliced<FitState, FitMessage>(bytes, cuts, (st) => new FitReader(st));
          expect(out).toEqual(whole.messages);
          expect(state.error).toBe(whole.error);
        }),
        { numRuns: 200 },
      );
    }
  });

  it("fuzz: random bytes never throw", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 400 }),
        fc.integer({ min: 0, max: fixture.length }),
        (noise, at) => {
          const mixed = new Uint8Array([...fixture.subarray(0, at), ...noise]);
          expect(() => parseFit(mixed)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});
