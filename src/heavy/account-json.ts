/**
 * Account export JSON, one top-level array element per line (DESIGN.md §13, spec/account.md §6-7).
 *
 * The exporter writes:
 *
 *     {"format":"pacestreak-export",
 *     "version":2,
 *     "workouts":[
 *     {...one workout...},
 *     {...},
 *     ],
 *     ...}
 *
 * which is still ordinary JSON (the app and `JSON.parse` read it), but lets a large import be split
 * at newlines and read slice by slice: `AccountJsonReader` resumes from any byte offset and emits one
 * event per top-level member or array element. Small files go through `parseAccountJson`, which
 * accepts any JSON layout. A large file that was reformatted by hand fails with "That backup file
 * could not be read." (intentional, DESIGN.md §19).
 */
import { binaryToBytes, bytesToBinary, concatBytes, decodeUtf8, FormatError } from "./bytes.ts";

/** spec/account.md §7. */
export const NOT_JSON = "Not a JSON file";
/** DESIGN.md §13: a large file not in the line-per-element layout. */
export const BACKUP_UNREADABLE = "That backup file could not be read.";

/** A single line (one element) longer than this is refused rather than buffered. */
const MAX_LINE = 4 * 1024 * 1024;

export type AccountJsonEvent =
  /** A top-level member that is not an array (`format`, `version`, `profile` ...). */
  | { type: "member"; key: string; value: unknown }
  /** Start of a top-level array member. */
  | { type: "arrayStart"; key: string }
  /** One element of the array member `key`. */
  | { type: "element"; key: string; value: unknown }
  | { type: "arrayEnd"; key: string };

/** Serialises an export object in the line-per-element layout. Key order is the object's. */
export function* accountJsonLines(doc: Record<string, unknown>): Generator<string> {
  const keys = Object.keys(doc).filter((k) => doc[k] !== undefined);
  yield "{\n";
  for (const [k, key] of keys.entries()) {
    const comma = k < keys.length - 1 ? "," : "";
    const value = doc[key];
    const name = JSON.stringify(key);
    if (Array.isArray(value)) {
      yield `${name}:[\n`;
      // Compact JSON never contains a raw newline (strings escape it), so each element is one line.
      for (const [n, el] of value.entries()) {
        yield `${JSON.stringify(el) ?? "null"}${n < value.length - 1 ? "," : ""}\n`;
      }
      yield `]${comma}\n`;
    } else {
      yield `${name}:${JSON.stringify(value)}${comma}\n`;
    }
  }
  yield "}\n";
}

/** The whole export as one string. */
export const accountJsonString = (doc: Record<string, unknown>): string =>
  [...accountJsonLines(doc)].join("");

export type AccountJsonState = {
  offset: number;
  /** Bytes of the unfinished line (binary string). */
  pending: string;
  phase: "start" | "members" | "array" | "end";
  /** The array member being read. */
  key: string | null;
  /** Whether the previous line ended with a comma (another member/element must follow). */
  more: boolean;
  /** No member (or element, inside an array) read yet. */
  first: boolean;
  line: number;
};

export const initialAccountJsonState = (): AccountJsonState => ({
  offset: 0,
  pending: "",
  phase: "start",
  key: null,
  more: false,
  first: true,
  line: 0,
});

const bad = () => new FormatError(BACKUP_UNREADABLE);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw bad();
  }
}

/** Splits `"key":rest` at the colon after a JSON string key. */
function splitMember(line: string): { key: string; rest: string } {
  if (!line.startsWith('"')) throw bad();
  let i = 1;
  while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
  const key = parse(line.slice(0, i + 1));
  if (typeof key !== "string" || line[i + 1] !== ":") throw bad();
  return { key, rest: line.slice(i + 2) };
}

/** Removes a trailing comma, reporting whether there was one. */
function stripComma(text: string): { body: string; comma: boolean } {
  const t = text.trimEnd();
  return t.endsWith(",") ? { body: t.slice(0, -1), comma: true } : { body: t, comma: false };
}

export class AccountJsonReader {
  state: AccountJsonState;

  constructor(state: AccountJsonState = initialAccountJsonState()) {
    this.state = structuredClone(state);
  }

  push(chunk: Uint8Array): AccountJsonEvent[] {
    const s = this.state;
    s.offset += chunk.length;
    const buf = s.pending ? concatBytes(binaryToBytes(s.pending), chunk) : chunk;
    const out: AccountJsonEvent[] = [];
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      this.line(decodeUtf8(buf.subarray(start, nl), BACKUP_UNREADABLE), out);
      start = nl + 1;
    }
    if (buf.length - start > MAX_LINE) throw bad();
    s.pending = bytesToBinary(buf.subarray(start));
    return out;
  }

  end(): AccountJsonEvent[] {
    const s = this.state;
    const out: AccountJsonEvent[] = [];
    if (s.pending) {
      const last = decodeUtf8(binaryToBytes(s.pending), BACKUP_UNREADABLE);
      s.pending = "";
      this.line(last, out);
    }
    if (s.phase !== "end") throw bad();
    return out;
  }

  private line(raw: string, out: AccountJsonEvent[]): void {
    const s = this.state;
    s.line++;
    // A BOM on the first line and CRLF line ends are tolerated; blank lines are skipped.
    const line = (s.line === 1 ? raw.replace(/^\uFEFF/, "") : raw).trim();
    if (line === "") return;
    switch (s.phase) {
      case "start":
        if (line !== "{") throw bad();
        s.phase = "members";
        s.first = true;
        return;
      case "members": {
        if (line === "}") {
          if (s.more) throw bad(); // a comma before the closing brace
          s.phase = "end";
          return;
        }
        if (!s.first && !s.more) throw bad(); // two members without a comma
        s.first = false;
        const { key, rest } = splitMember(line);
        if (rest === "[") {
          out.push({ type: "arrayStart", key });
          s.phase = "array";
          s.key = key;
          s.first = true;
          s.more = false;
          return;
        }
        const { body, comma } = stripComma(rest);
        out.push({ type: "member", key, value: parse(body) });
        s.more = comma;
        return;
      }
      case "array": {
        const key = s.key ?? "";
        if (line === "]" || line === "],") {
          if (s.more) throw bad(); // a comma before "]"
          out.push({ type: "arrayEnd", key });
          s.key = null;
          s.phase = "members";
          s.first = false;
          s.more = line === "],";
          return;
        }
        if (!s.first && !s.more) throw bad(); // two elements without a comma
        s.first = false;
        const { body, comma } = stripComma(line);
        out.push({ type: "element", key, value: parse(body) });
        s.more = comma;
        return;
      }
      case "end":
        throw bad();
    }
  }
}

/**
 * Reads a whole export of any JSON layout (small files), emitting the same events. Not JSON at all
 * is spec's 422 "Not a JSON file"; checking `format` is the importer's job.
 */
export function parseAccountJson(bytes: Uint8Array): AccountJsonEvent[] {
  let doc: unknown;
  try {
    doc = JSON.parse(decodeUtf8(bytes, NOT_JSON).replace(/^﻿/, ""));
  } catch {
    throw new FormatError(NOT_JSON);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const out: AccountJsonEvent[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (Array.isArray(value)) {
      out.push({ type: "arrayStart", key });
      for (const el of value) out.push({ type: "element", key, value: el });
      out.push({ type: "arrayEnd", key });
    } else {
      out.push({ type: "member", key, value });
    }
  }
  return out;
}

/** Reads a whole file with the streaming reader (the large-file path, in one go). */
export function readAccountJsonLines(bytes: Uint8Array): AccountJsonEvent[] {
  const r = new AccountJsonReader();
  return [...r.push(bytes), ...r.end()];
}
