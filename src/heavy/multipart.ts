/**
 * Streaming multipart/form-data reader (DESIGN.md §13 step 1).
 *
 * `request.formData()` buffers the whole body before we can count it; this reader scans the boundary
 * over the stream's chunks instead, so the per-route size cap is enforced while the bytes arrive and a
 * file can be handed on (to R2 staging, or a resumable parser) chunk by chunk.
 *
 * Caps follow the spec: a file part over `maxFileBytes` throws the caller's 413 (account import:
 * "That file is too large"); text fields are small and capped at `maxFieldBytes`. A body that is not
 * valid multipart is Starlette's 400 "There was an error parsing the body".
 */
import { HttpError } from "../lib/errors.ts";
import { ascii, concatBytes, decodeUtf8, indexOfBytes } from "./bytes.ts";

export const MULTIPART_PARSE_ERROR = "There was an error parsing the body";
/** spec/account.md §7. */
export const FILE_TOO_LARGE = "That file is too large";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PARTS = 64;
const CRLF2 = ascii("\r\n\r\n");

export type PartHeaders = {
  /** The form field name. */
  name: string;
  /** Present on file parts (even when empty, as browsers send for "no file chosen"). */
  filename: string | null;
  contentType: string | null;
};

export type MultipartEvent =
  | { type: "part"; headers: PartHeaders }
  | { type: "data"; chunk: Uint8Array }
  | { type: "partEnd" };

export type MultipartOptions = {
  /** Bytes allowed in any one file part. */
  maxFileBytes: number;
  /** Bytes allowed in any one non-file part. Default 64 KiB. */
  maxFieldBytes?: number;
  /** The error thrown when a part is over its cap. Default 413 "That file is too large". */
  tooLarge?: () => Error;
};

const parseError = () => new HttpError(400, MULTIPART_PARSE_ERROR);

/** The boundary from a `multipart/form-data; boundary=...` header, or a 400. */
export function boundaryOf(contentType: string | null | undefined): string {
  if (!contentType || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) throw parseError();
  const m = /;\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) throw parseError();
  return boundary;
}

/** RFC 7578 Content-Disposition params; tolerant of the quoting browsers actually send. */
function parseDisposition(value: string): { name: string | null; filename: string | null } {
  if (!/^\s*form-data\s*(;|$)/i.test(value)) throw parseError();
  const params = new Map<string, string>();
  const re = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const key = (m[1] ?? "").toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "").trim();
    if (!params.has(key)) params.set(key, raw);
  }
  let filename = params.get("filename") ?? null;
  const star = params.get("filename*");
  if (star) {
    const ext = /^utf-8''(.*)$/i.exec(star);
    if (ext?.[1] !== undefined) {
      try {
        filename = decodeURIComponent(ext[1]);
      } catch {
        // Keep the plain filename.
      }
    }
  }
  return { name: params.get("name") ?? null, filename };
}

function parseHeaders(block: Uint8Array): PartHeaders {
  const text = decodeUtf8(block, MULTIPART_PARSE_ERROR);
  let disposition: { name: string | null; filename: string | null } | null = null;
  let contentType: string | null = null;
  for (const line of text.split("\r\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw parseError();
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-disposition") disposition = parseDisposition(value);
    else if (key === "content-type") contentType = value;
  }
  if (!disposition?.name) throw parseError();
  return { name: disposition.name, filename: disposition.filename, contentType };
}

/**
 * Yields `part`, `data`* and `partEnd` events for each part of a multipart body, in order. Enforces
 * the caps as it goes. Consumers must drain the generator (or `return()` it) so the stream is released.
 */
export async function* readMultipart(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null | undefined,
  opts: MultipartOptions,
): AsyncGenerator<MultipartEvent> {
  const boundary = boundaryOf(contentType);
  if (!body) throw parseError();
  const maxField = opts.maxFieldBytes ?? 64 * 1024;
  const tooLarge = opts.tooLarge ?? (() => new HttpError(413, FILE_TOO_LARGE));
  // The leading CRLF lets the very first boundary (which has none before it) match the same delimiter.
  const delim = ascii(`\r\n--${boundary}`);
  let buf: Uint8Array = ascii("\r\n");
  type State = "preamble" | "afterDelim" | "headers" | "body" | "done";
  let state = "preamble" as State;
  let partBytes = 0;
  let partCap = 0;
  let parts = 0;
  const reader = body.getReader();
  let eof = false;

  try {
    while (state !== "done") {
      let progressed = true;
      while (progressed && state !== "done") {
        progressed = false;
        if (state === "preamble") {
          const at = indexOfBytes(buf, delim);
          if (at === -1) {
            buf = buf.subarray(Math.max(0, buf.length - delim.length + 1));
          } else {
            buf = buf.subarray(at + delim.length);
            state = "afterDelim";
            progressed = true;
          }
        } else if (state === "afterDelim") {
          // Transport padding (spaces/tabs) may follow a delimiter before its CRLF.
          let i = 0;
          while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09)) i++;
          if (buf.length - i < 2) {
            if (eof) throw parseError();
            break;
          }
          if (buf[i] === 0x2d && buf[i + 1] === 0x2d) {
            state = "done";
          } else if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
            buf = buf.subarray(i + 2);
            state = "headers";
            progressed = true;
          } else {
            throw parseError();
          }
        } else if (state === "headers") {
          // A part with no headers at all starts directly with the blank line.
          const at = buf[0] === 0x0d && buf[1] === 0x0a ? -2 : indexOfBytes(buf, CRLF2);
          if (at === -1) {
            if (buf.length > MAX_HEADER_BYTES) throw parseError();
            break;
          }
          const headers = parseHeaders(at === -2 ? new Uint8Array(0) : buf.subarray(0, at));
          buf = buf.subarray(at === -2 ? 2 : at + 4);
          if (++parts > MAX_PARTS) throw parseError();
          partBytes = 0;
          partCap = headers.filename !== null ? opts.maxFileBytes : maxField;
          state = "body";
          progressed = true;
          yield { type: "part", headers };
        } else if (state === "body") {
          const at = indexOfBytes(buf, delim);
          // Without a delimiter, everything but a possible delimiter prefix at the end is body.
          const end = at === -1 ? Math.max(0, buf.length - delim.length + 1) : at;
          if (end > 0) {
            partBytes += end;
            if (partBytes > partCap) throw tooLarge();
            const chunk = buf.slice(0, end);
            buf = buf.subarray(end);
            yield { type: "data", chunk };
          }
          if (at !== -1) {
            buf = buf.subarray(delim.length);
            state = "afterDelim";
            progressed = true;
            yield { type: "partEnd" };
          }
        }
      }
      if ((state as State) === "done") break;
      if (eof) throw parseError();
      const next = await reader.read();
      if (next.done) eof = true;
      else buf = concatBytes(buf, next.value);
    }
  } finally {
    // Ignore the epilogue; release the stream either way.
    await reader.cancel().catch(() => undefined);
  }
}

export type CollectedFile = { name: string; filename: string; contentType: string | null; bytes: Uint8Array };
export type CollectedForm = { fields: Map<string, string>; files: Map<string, CollectedFile> };

/**
 * Collects a whole form: text fields (UTF-8) and file parts (bytes). For inline imports; large
 * imports consume `readMultipart` directly and pipe the file part on. First occurrence of a name wins.
 */
export async function collectMultipart(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null | undefined,
  opts: MultipartOptions,
): Promise<CollectedForm> {
  const fields = new Map<string, string>();
  const files = new Map<string, CollectedFile>();
  let current: PartHeaders | null = null;
  let chunks: Uint8Array[] = [];
  for await (const ev of readMultipart(body, contentType, opts)) {
    if (ev.type === "part") {
      current = ev.headers;
      chunks = [];
    } else if (ev.type === "data") {
      chunks.push(ev.chunk);
    } else if (current) {
      const size = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      if (current.filename !== null) {
        if (!files.has(current.name)) {
          files.set(current.name, {
            name: current.name,
            filename: current.filename,
            contentType: current.contentType,
            bytes,
          });
        }
      } else if (!fields.has(current.name)) {
        fields.set(current.name, decodeUtf8(bytes, MULTIPART_PARSE_ERROR));
      }
      current = null;
    }
  }
  return { fields, files };
}
