/**
 * Streaming GPX scanner (DESIGN.md §13, spec/training-a.md importers.parse_gpx).
 *
 * Not a general XML parser: it tokenises tags, tracks the element stack, and keeps only what the
 * importer reads: each `<trk>` directly under `<gpx>` with its `<name>` and `<type>`, and each
 * `<trkpt>` under `<trkseg>` with `lat`, `lon`, `<ele>`, `<time>` and the first `<hr>` anywhere inside
 * it (Garmin's TrackPointExtension). Values are returned as raw strings; the importer converts them
 * and skips points Python would skip.
 *
 * Safety (defusedxml parity): any `<!DOCTYPE` or `<!ENTITY` (any `<!` other than a comment or CDATA)
 * fails with "That GPX file could not be read.", so entity expansion and external entities are
 * impossible by construction. Only the five predefined entities and character references decode.
 *
 * Resumable: `reader.state` is plain JSON (the open element stack, the track being built and the
 * bytes of an unfinished token), so a slice may end at any byte offset.
 */
import { binaryToBytes, bytesToBinary, concatBytes, decodeUtf8, FormatError } from "./bytes.ts";

export const GPX_UNREADABLE = "That GPX file could not be read.";
export const GPX_NOT_GPX = "That isn't a GPX file.";

const MAX_DEPTH = 256;
/** A single tag or comment longer than this is not a real GPX file. */
const MAX_TOKEN = 1024 * 1024;

export type GpxPoint = {
  lat: string | null;
  lon: string | null;
  ele: string | null;
  time: string | null;
  /** The first `<hr>` inside the point: null when there is none, "" when it is empty. */
  hr: string | null;
};

export type GpxTrack = { name: string | null; type: string | null; points: GpxPoint[] };

/** What text is being captured: the leaf element's text before its first child (ElementTree `.text`). */
type Capture = "name" | "type" | "ele" | "time" | "hr";

export type GpxState = {
  offset: number;
  /** Local names of the open elements. */
  stack: string[];
  /** Bytes not yet tokenised (binary string): an unfinished tag, comment or text run. */
  pending: string;
  sawRoot: boolean;
  rootClosed: boolean;
  /** The `<trk>` being read, if any. */
  track: GpxTrack | null;
  point: GpxPoint | null;
  /** Depth (stack length) of the element whose text is being captured, and the text so far. */
  capture: { what: Capture; depth: number; text: string; done: boolean } | null;
};

export const initialGpxState = (): GpxState => ({
  offset: 0,
  stack: [],
  pending: "",
  sawRoot: false,
  rootClosed: false,
  track: null,
  point: null,
  capture: null,
});

const LT = 0x3c;
const GT = 0x3e;
const unreadable = () => new FormatError(GPX_UNREADABLE);

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1);

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decodes the predefined entities and character references; anything else is malformed XML. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&\s]{0,32});/g, (_, ref: string) => {
    if (ref in NAMED) return NAMED[ref] as string;
    const m = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(ref);
    if (m) {
      const cp = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2]);
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
    }
    throw unreadable();
  });
}

function checkAmpersands(decodedFrom: string): void {
  // A bare `&` without a terminating `;` is malformed too.
  if (/&(?![^;&\s]{0,32};)/.test(decodedFrom)) throw unreadable();
}

/** Parses `<name attr="v" ...>` contents (without the angle brackets). */
function parseTag(body: string): { name: string; attrs: Map<string, string>; selfClosing: boolean } {
  let text = body;
  const selfClosing = text.endsWith("/");
  if (selfClosing) text = text.slice(0, -1);
  const m = /^([^\s/>=]+)/.exec(text);
  if (!m?.[1]) throw unreadable();
  const name = m[1];
  const attrs = new Map<string, string>();
  const rest = text.slice(name.length);
  const re = /\s+([^\s=]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  while (at < rest.length) {
    if (/^\s*$/.test(rest.slice(at))) break;
    re.lastIndex = at;
    const a = re.exec(rest);
    if (!a?.[1]) throw unreadable();
    const raw = a[2] ?? a[3] ?? "";
    checkAmpersands(raw);
    if (attrs.has(a[1])) throw unreadable();
    attrs.set(a[1], decodeEntities(raw));
    at = re.lastIndex;
  }
  return { name, attrs, selfClosing };
}

export class GpxReader {
  state: GpxState;

  constructor(state: GpxState = initialGpxState()) {
    this.state = structuredClone(state);
  }

  /** Feeds the next bytes; returns the tracks closed by them. */
  push(chunk: Uint8Array): GpxTrack[] {
    const s = this.state;
    if (s.offset === 0 && chunk.length === 0) return [];
    s.offset += chunk.length;
    const buf = s.pending ? concatBytes(binaryToBytes(s.pending), chunk) : chunk;
    const out: GpxTrack[] = [];
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== LT) {
        const lt = buf.indexOf(LT, i);
        const end = lt === -1 ? buf.length : lt;
        if (lt === -1 && s.capture && !s.capture.done) {
          // Keep captured text pending so an entity or UTF-8 sequence split by the slice survives.
          break;
        }
        this.text(buf.subarray(i, end));
        i = end;
        continue;
      }
      const end = this.tokenEnd(buf, i);
      if (end === -1) break;
      this.token(buf.subarray(i, end), out);
      i = end;
    }
    const rest = buf.subarray(i);
    if (rest.length > MAX_TOKEN) throw unreadable();
    s.pending = bytesToBinary(rest);
    return out;
  }

  /** Ends the input; the document must be complete. */
  end(): GpxTrack[] {
    const s = this.state;
    const rest = binaryToBytes(s.pending);
    if (rest.some((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) throw unreadable();
    if (!s.sawRoot || !s.rootClosed) throw unreadable();
    return [];
  }

  /** Index just past the token starting at `<` = buf[i], or -1 when it is not complete yet. */
  private tokenEnd(buf: Uint8Array, i: number): number {
    const startsWith = (lit: string) => {
      for (let k = 0; k < lit.length; k++) {
        const b = buf[i + k];
        if (b === undefined) return null; // not enough bytes to tell
        if (b !== lit.charCodeAt(k)) return false;
      }
      return true;
    };
    const find = (lit: string, from: number) => {
      const first = lit.charCodeAt(0);
      for (let k = buf.indexOf(first, from); k !== -1; k = buf.indexOf(first, k + 1)) {
        let ok = true;
        for (let j = 1; j < lit.length; j++) {
          const b = buf[k + j];
          if (b === undefined) return -1;
          if (b !== lit.charCodeAt(j)) {
            ok = false;
            break;
          }
        }
        if (ok) return k + lit.length;
      }
      return -1;
    };
    const second = buf[i + 1];
    if (second === undefined) return -1;
    if (second === 0x21 /* ! */) {
      const comment = startsWith("<!--");
      if (comment === null) return -1;
      if (comment) return find("-->", i + 4);
      const cdata = startsWith("<![CDATA[");
      if (cdata === null) return -1;
      if (cdata) return find("]]>", i + 9);
      // <!DOCTYPE, <!ENTITY, <!ELEMENT ...: never allowed (defusedxml forbids DTDs).
      throw unreadable();
    }
    if (second === 0x3f /* ? */) return find("?>", i + 2);
    // A tag: '>' outside quoted attribute values.
    let quote = 0;
    for (let k = i + 1; k < buf.length; k++) {
      const b = buf[k];
      if (quote) {
        if (b === quote) quote = 0;
      } else if (b === 0x22 || b === 0x27) {
        quote = b;
      } else if (b === LT) {
        throw unreadable();
      } else if (b === GT) {
        return k + 1;
      }
    }
    return -1;
  }

  private text(bytes: Uint8Array): void {
    const s = this.state;
    const c = s.capture;
    if (c && !c.done && s.stack.length === c.depth) {
      c.text += decodeUtf8(bytes, GPX_UNREADABLE);
      return;
    }
    if (s.stack.length === 0) {
      // Outside the root only whitespace may appear.
      // A UTF-8 BOM may precede the root (its bytes can arrive in separate slices).
      const ok = (b: number) =>
        b === 0x20 ||
        b === 0x09 ||
        b === 0x0a ||
        b === 0x0d ||
        (!s.sawRoot && (b === 0xef || b === 0xbb || b === 0xbf));
      if (!bytes.every(ok)) throw unreadable();
    }
  }

  private token(bytes: Uint8Array, out: GpxTrack[]): void {
    const s = this.state;
    const second = bytes[1];
    if (second === 0x21 /* ! */) {
      if (bytes[2] === 0x5b /* [ CDATA */) {
        const c = s.capture;
        if (c && !c.done && s.stack.length === c.depth) {
          c.text += decodeUtf8(bytes.subarray(9, bytes.length - 3), GPX_UNREADABLE);
        } else if (s.stack.length === 0) {
          throw unreadable();
        }
      }
      return; // comment
    }
    if (second === 0x3f) return; // processing instruction / XML declaration
    const raw = decodeUtf8(bytes.subarray(1, bytes.length - 1), GPX_UNREADABLE);
    if (raw.startsWith("/")) {
      this.close(localName(raw.slice(1).trim()), out);
      return;
    }
    const tag = parseTag(raw);
    this.open(localName(tag.name), tag.attrs);
    if (tag.selfClosing) this.close(localName(tag.name), out);
  }

  private open(name: string, attrs: Map<string, string>): void {
    const s = this.state;
    if (s.rootClosed) throw unreadable();
    if (s.stack.length === 0) {
      if (s.sawRoot) throw unreadable();
      s.sawRoot = true;
      if (name !== "gpx") throw new FormatError(GPX_NOT_GPX);
    }
    // ElementTree's `.text` stops at the first child element.
    if (s.capture && s.stack.length === s.capture.depth) s.capture.done = true;
    const parent = s.stack[s.stack.length - 1];
    const depth = s.stack.length + 1;
    if (depth > MAX_DEPTH) throw unreadable();
    s.stack.push(name);
    const path = s.stack;
    if (depth === 2 && name === "trk") {
      s.track = { name: null, type: null, points: [] };
    } else if (depth === 3 && s.track && path[1] === "trk") {
      if ((name === "name" && s.track.name === null) || (name === "type" && s.track.type === null)) {
        s.capture = { what: name, depth, text: "", done: false };
      }
    } else if (depth === 4 && name === "trkpt" && parent === "trkseg" && s.track) {
      s.point = {
        lat: attrs.get("lat") ?? null,
        lon: attrs.get("lon") ?? null,
        ele: null,
        time: null,
        hr: null,
      };
    } else if (s.point && depth === 5 && (name === "ele" || name === "time")) {
      if (s.point[name] === null && !s.capture) s.capture = { what: name, depth, text: "", done: false };
    } else if (s.point && depth > 5 && name === "hr" && s.point.hr === null && !s.capture) {
      s.capture = { what: "hr", depth, text: "", done: false };
    }
  }

  private close(name: string, out: GpxTrack[]): void {
    const s = this.state;
    const top = s.stack.pop();
    if (top === undefined || top !== name) throw unreadable();
    const depth = s.stack.length + 1;
    const c = s.capture;
    if (c && c.depth === depth) {
      checkAmpersands(c.text);
      // ElementTree keeps empty text as None and `_text` skips elements without text.
      const value = decodeEntities(c.text).trim();
      const hasText = c.text !== "";
      s.capture = null;
      if (c.what === "name" || c.what === "type") {
        if (s.track && hasText) s.track[c.what] = value;
      } else if (s.point) {
        if (c.what === "hr")
          s.point.hr = hasText ? value : ""; // only the first <hr> counts, even empty
        else if (hasText) s.point[c.what] = value;
      }
    }
    if (depth === 4 && name === "trkpt" && s.point) {
      s.track?.points.push(s.point);
      s.point = null;
    } else if (depth === 2 && name === "trk" && s.track) {
      out.push(s.track);
      s.track = null;
    } else if (depth === 1) {
      s.rootClosed = true;
    }
  }
}

/** Parses a whole GPX file. */
export function parseGpx(bytes: Uint8Array): GpxTrack[] {
  const r = new GpxReader();
  return [...r.push(bytes), ...r.end()];
}
