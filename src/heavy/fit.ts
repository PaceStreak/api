/**
 * Streaming FIT reader (DESIGN.md §13, spec/training-a.md importers.parse_fit).
 *
 * Decodes the four messages the importer uses (file_id, session, lap, record) and skips the rest by
 * their definitions. A FIT file is a record stream: definition messages bind a local type (0-15) to a
 * field layout that later data messages use, so the definitions, the last timestamp (for compressed
 * timestamp headers) and the running CRC are part of `reader.state`, which is plain JSON. A slice may
 * end at any byte offset. Chained FIT files (several headers back to back) are read in turn.
 *
 * Errors do not throw: like fitdecode, everything before the bad byte is kept and `state.error` says
 * what went wrong, so the importer can keep earlier sessions ("The file ended early...").
 * Values are converted to SI here: timestamps to epoch ms, distances to metres, durations to seconds.
 */
import { binaryToBytes, bytesToBinary, concatBytes } from "./bytes.ts";

export const FIT_UNREADABLE = "That FIT file could not be read.";

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH_S = 631065600;

const MESG = { file_id: 0, session: 18, lap: 19, record: 20 } as const;

type FieldDef = [num: number, size: number, baseType: number];
type Definition = { global: number; bigEndian: boolean; fields: FieldDef[]; devBytes: number };

export type FitFileId = {
  kind: "file_id";
  type: number | null;
  manufacturer: number | null;
  product: number | null;
  serialNumber: number | null;
  timeCreated: number | null;
};
export type FitRecord = {
  kind: "record";
  timestamp: number | null;
  /** Degrees. */
  lat: number | null;
  lon: number | null;
  /** Metres from the start. */
  distance: number | null;
  /** Metres. */
  altitude: number | null;
  heartRate: number | null;
};
export type FitSummary = {
  kind: "session" | "lap";
  timestamp: number | null;
  startTime: number | null;
  /** fitdecode's names ("running", "strength_training"), or the number as text when unnamed. */
  sport: string | null;
  subSport: string | null;
  totalElapsedTime: number | null;
  totalTimerTime: number | null;
  totalDistance: number | null;
  totalAscent: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
};
export type FitMessage = FitFileId | FitRecord | FitSummary;

export type FitState = {
  offset: number;
  /** Unconsumed bytes (binary string): an unfinished header, record or CRC. */
  pending: string;
  /** "header" before each file in a chain, "records" inside one, "crc" for its trailing CRC. */
  phase: "header" | "records" | "crc";
  /** Record bytes left in the current file. */
  remaining: number;
  crc: number;
  /** Local message type (0-15) to definition. */
  defs: (Definition | null)[];
  lastTimestamp: number | null;
  files: number;
  error: string | null;
};

export const initialFitState = (): FitState => ({
  offset: 0,
  pending: "",
  phase: "header",
  remaining: 0,
  crc: 0,
  defs: Array.from({ length: 16 }, () => null),
  lastTimestamp: null,
  files: 0,
  error: null,
});

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000,
  0x9c01, 0x8801, 0x4400,
];

/** FIT's CRC-16 over `bytes`, continuing from `crc`. */
export function fitCrc(bytes: Uint8Array, crc = 0): number {
  let c = crc;
  for (const b of bytes) {
    let tmp = CRC_TABLE[c & 0xf] as number;
    c = (c >> 4) & 0x0fff;
    c = c ^ tmp ^ (CRC_TABLE[b & 0xf] as number);
    tmp = CRC_TABLE[c & 0xf] as number;
    c = (c >> 4) & 0x0fff;
    c = c ^ tmp ^ (CRC_TABLE[(b >> 4) & 0xf] as number);
  }
  return c;
}

const SPORTS: Record<number, string> = {
  0: "generic",
  1: "running",
  2: "cycling",
  3: "transition",
  4: "fitness_equipment",
  5: "swimming",
  6: "basketball",
  7: "soccer",
  8: "tennis",
  9: "american_football",
  10: "training",
  11: "walking",
  12: "cross_country_skiing",
  13: "alpine_skiing",
  14: "snowboarding",
  15: "rowing",
  16: "mountaineering",
  17: "hiking",
  18: "multisport",
  19: "paddling",
  21: "e_biking",
  31: "rock_climbing",
  62: "hiit",
};

const SUB_SPORTS: Record<number, string> = {
  0: "generic",
  1: "treadmill",
  2: "street",
  3: "trail",
  4: "track",
  5: "spin",
  6: "indoor_cycling",
  7: "road",
  8: "mountain",
  14: "indoor_rowing",
  15: "elliptical",
  17: "lap_swimming",
  18: "open_water",
  19: "flexibility_training",
  20: "strength_training",
  26: "cardio_training",
  27: "indoor_walking",
  43: "yoga",
  44: "pilates",
  45: "indoor_running",
  58: "virtual_activity",
  69: "bouldering",
  70: "hiit",
};

/** Reads one field value; null for FIT's "invalid" sentinel or an unexpected size. */
function readField(view: DataView, at: number, size: number, baseType: number, le: boolean): number | null {
  switch (baseType & 0x1f) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0a: {
      // uint8z
      if (size < 1) return null;
      const v = view.getUint8(at);
      return v === 0xff || ((baseType & 0x1f) === 0x0a && v === 0) ? null : v;
    }
    case 0x01: {
      if (size < 1) return null;
      const v = view.getInt8(at);
      return v === 0x7f ? null : v;
    }
    case 0x03: {
      if (size < 2) return null;
      const v = view.getInt16(at, le);
      return v === 0x7fff ? null : v;
    }
    case 0x04:
    case 0x0b: {
      if (size < 2) return null;
      const v = view.getUint16(at, le);
      return v === 0xffff || ((baseType & 0x1f) === 0x0b && v === 0) ? null : v;
    }
    case 0x05: {
      if (size < 4) return null;
      const v = view.getInt32(at, le);
      return v === 0x7fffffff ? null : v;
    }
    case 0x06:
    case 0x0c: {
      if (size < 4) return null;
      const v = view.getUint32(at, le);
      return v === 0xffffffff || ((baseType & 0x1f) === 0x0c && v === 0) ? null : v;
    }
    default:
      return null; // strings, floats, bytes and 64-bit types: none of the fields we read use them
  }
}

const scaled = (v: number | null, scale: number, offset = 0) => (v === null ? null : v / scale - offset);
const fitTime = (v: number | null) => (v === null ? null : (v + FIT_EPOCH_S) * 1000);
const semicircles = (v: number | null) => (v === null ? null : v * (180 / 2 ** 31));
const named = (table: Record<number, string>, v: number | null) =>
  v === null ? null : (table[v] ?? String(v));

export class FitReader {
  state: FitState;

  constructor(state: FitState = initialFitState()) {
    this.state = structuredClone(state);
  }

  /** Feeds the next bytes; returns the messages they complete. Stops at the first error (`state.error`). */
  push(chunk: Uint8Array): FitMessage[] {
    const s = this.state;
    s.offset += chunk.length;
    const out: FitMessage[] = [];
    if (s.error) return out;
    const buf = s.pending ? concatBytes(binaryToBytes(s.pending), chunk) : chunk;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let i = 0;
    try {
      for (;;) {
        if (s.phase === "header") {
          if (i === buf.length) break;
          const size = buf[i] as number;
          if (size !== 12 && size !== 14) throw new Error("bad header size");
          if (buf.length - i < size) break;
          if (buf[i + 8] !== 0x2e || buf[i + 9] !== 0x46 || buf[i + 10] !== 0x49 || buf[i + 11] !== 0x54) {
            throw new Error("missing .FIT signature");
          }
          const header = buf.subarray(i, i + size);
          if (size === 14) {
            const stored = view.getUint16(i + 12, true);
            if (stored !== 0 && stored !== fitCrc(header.subarray(0, 12))) throw new Error("header CRC");
          }
          s.remaining = view.getUint32(i + 4, true);
          // The file CRC covers the header too (the 14-byte header's own CRC included).
          s.crc = fitCrc(header);
          s.defs = Array.from({ length: 16 }, () => null);
          s.lastTimestamp = null;
          s.files++;
          s.phase = "records";
          i += size;
        } else if (s.phase === "records") {
          if (s.remaining === 0) {
            s.phase = "crc";
            continue;
          }
          const used = this.record(buf, view, i, out);
          if (used === 0) break;
          s.crc = fitCrc(buf.subarray(i, i + used), s.crc);
          s.remaining -= used;
          i += used;
        } else {
          if (buf.length - i < 2) break;
          if (view.getUint16(i, true) !== s.crc) throw new Error("file CRC");
          i += 2;
          s.phase = "header";
        }
      }
    } catch (err) {
      s.error = err instanceof Error ? err.message : "unreadable";
      s.pending = "";
      return out;
    }
    s.pending = bytesToBinary(buf.subarray(i));
    return out;
  }

  /** Ends the input; a file cut short sets `state.error`. */
  end(): FitMessage[] {
    const s = this.state;
    if (!s.error) {
      if (s.files === 0) s.error = "empty";
      else if (s.phase !== "header" || s.pending.length > 0) s.error = "truncated";
    }
    return [];
  }

  /** Decodes the record at `i`; returns its length, or 0 when it is not complete in `buf` yet. */
  private record(buf: Uint8Array, view: DataView, i: number, out: FitMessage[]): number {
    const s = this.state;
    const avail = Math.min(buf.length - i, s.remaining);
    if (avail < 1) return 0;
    const h = buf[i] as number;
    if (h & 0x80) {
      // Compressed timestamp header: local type in bits 5-6, a 5-bit time offset.
      const def = s.defs[(h >> 5) & 0x03];
      if (!def) throw new Error("undefined local message");
      const len = 1 + this.dataLength(def);
      if (len > s.remaining) throw new Error("record overruns file");
      if (avail < len) return 0;
      const off = h & 0x1f;
      const last = s.lastTimestamp ?? 0;
      let ts = (last & ~0x1f) + off;
      if (off < (last & 0x1f)) ts += 0x20;
      s.lastTimestamp = ts;
      this.data(def, view, i + 1, out, ts);
      return len;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      // Definition message.
      if (avail < 6) return s.remaining < 6 ? this.fail("record overruns file") : 0;
      const bigEndian = buf[i + 2] === 1;
      const global = view.getUint16(i + 3, !bigEndian);
      const n = buf[i + 5] as number;
      let len = 6 + n * 3;
      const dev = (h & 0x20) !== 0;
      if (dev) len += 1;
      if (len > s.remaining) throw new Error("record overruns file");
      if (avail < len) return 0;
      const fields: FieldDef[] = [];
      for (let k = 0; k < n; k++) {
        const at = i + 6 + k * 3;
        fields.push([buf[at] as number, buf[at + 1] as number, buf[at + 2] as number]);
      }
      let devBytes = 0;
      if (dev) {
        const dn = buf[i + 6 + n * 3] as number;
        const dlen = len + dn * 3;
        if (dlen > s.remaining) throw new Error("record overruns file");
        if (avail < dlen) return 0;
        for (let k = 0; k < dn; k++) devBytes += buf[i + len + k * 3 + 1] as number;
        len = dlen;
      }
      s.defs[local] = { global, bigEndian, fields, devBytes };
      return len;
    }
    const def = s.defs[local];
    if (!def) throw new Error("undefined local message");
    const len = 1 + this.dataLength(def);
    if (len > s.remaining) throw new Error("record overruns file");
    if (avail < len) return 0;
    this.data(def, view, i + 1, out, null);
    return len;
  }

  private fail(message: string): never {
    throw new Error(message);
  }

  private dataLength(def: Definition): number {
    let n = def.devBytes;
    for (const f of def.fields) n += f[1];
    return n;
  }

  private data(def: Definition, view: DataView, at: number, out: FitMessage[], compressedTs: number | null) {
    const s = this.state;
    const le = !def.bigEndian;
    const v = new Map<number, number | null>();
    let p = at;
    for (const [num, size, base] of def.fields) {
      v.set(num, readField(view, p, size, base, le));
      p += size;
    }
    const ts = v.get(253) ?? null;
    if (ts !== null) s.lastTimestamp = ts;
    const timestamp = fitTime(ts ?? compressedTs);
    const get = (n: number) => v.get(n) ?? null;
    switch (def.global) {
      case MESG.record:
        out.push({
          kind: "record",
          timestamp,
          lat: semicircles(get(0)),
          lon: semicircles(get(1)),
          distance: scaled(get(5), 100),
          altitude: scaled(get(2), 5, 500),
          heartRate: get(3),
        });
        break;
      case MESG.session:
      case MESG.lap: {
        const session = def.global === MESG.session;
        out.push({
          kind: session ? "session" : "lap",
          timestamp,
          startTime: fitTime(get(2)),
          sport: named(SPORTS, get(session ? 5 : 25)),
          subSport: named(SUB_SPORTS, get(session ? 6 : 39)),
          totalElapsedTime: scaled(get(7), 1000),
          totalTimerTime: scaled(get(8), 1000),
          totalDistance: scaled(get(9), 100),
          totalAscent: get(session ? 22 : 21),
          avgHeartRate: get(session ? 16 : 15),
          maxHeartRate: get(session ? 17 : 16),
        });
        break;
      }
      case MESG.file_id:
        out.push({
          kind: "file_id",
          type: get(0),
          manufacturer: get(1),
          product: get(2),
          serialNumber: get(3),
          timeCreated: fitTime(get(4)),
        });
        break;
      default:
        break;
    }
  }
}

/** Reads a whole FIT file: the messages, and the error that stopped it (null when it read cleanly). */
export function parseFit(bytes: Uint8Array): { messages: FitMessage[]; error: string | null } {
  const r = new FitReader();
  const messages = [...r.push(bytes), ...r.end()];
  return { messages, error: r.state.error };
}
