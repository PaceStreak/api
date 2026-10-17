/**
 * Zip reading and writing over fflate (DESIGN.md §13, spec/account.md §6 and the habit importer).
 *
 * Reading inflates only the entry asked for, after checking its declared size, and then checks the
 * real size too: a zip bomb can lie in its directory, so the inflated length is what counts.
 * Writing is DEFLATE (Python's ZIP_DEFLATED) with entries in the order given.
 */
import { Unzip, UnzipInflate, unzipSync, Zip, ZipDeflate, zipSync } from "fflate";
import { FormatError } from "./bytes.ts";

/** spec/habits.md §2.3 (importer._csv_text). */
export const ZIP_UNREADABLE = "That zip file can't be opened";

export type ZipEntryInfo = { name: string; size: number; compressedSize: number };

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

/** Names and declared sizes of the file entries (directories excluded), in archive order. */
export function listZip(bytes: Uint8Array): ZipEntryInfo[] {
  if (!isZip(bytes)) throw new FormatError(ZIP_UNREADABLE);
  const entries: ZipEntryInfo[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (!f.name.endsWith("/"))
          entries.push({ name: f.name, size: f.originalSize, compressedSize: f.size });
        return false; // list only, inflate nothing
      },
    });
  } catch {
    throw new FormatError(ZIP_UNREADABLE);
  }
  return entries;
}

/**
 * Inflates one entry. `tooLarge` is thrown when it is (or turns out to be) over `maxBytes`;
 * a missing entry or a damaged archive is "That zip file can't be opened".
 */
export function readZipEntry(
  bytes: Uint8Array,
  name: string,
  maxBytes: number,
  tooLarge: () => Error,
): Uint8Array {
  if (!isZip(bytes)) throw new FormatError(ZIP_UNREADABLE);
  // Directory sizes can lie (fflate's unzipSync silently truncates to the declared size), so the
  // entry is inflated as a stream and the real output is counted against the cap.
  let found = false;
  let finished = false;
  let failed = false;
  let over = false;
  let total = 0;
  const chunks: Uint8Array[] = [];
  const unzip = new Unzip((file) => {
    if (found || file.name !== name) return;
    found = true;
    if (file.originalSize !== undefined && file.originalSize > maxBytes) {
      over = true;
      return;
    }
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed = true;
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        over = true;
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) finished = true;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    if (!over) throw new FormatError(ZIP_UNREADABLE);
  }
  if (over) throw tooLarge();
  if (!found || failed || !finished) throw new FormatError(ZIP_UNREADABLE);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type ZipInput = { name: string; data: Uint8Array | string };

const toBytes = (data: Uint8Array | string) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

/** Builds a DEFLATE zip in memory, entries in the given order. For inline exports. */
export function zipFiles(entries: readonly ZipInput[]): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const e of entries) {
    if (e.name in tree) throw new Error(`duplicate zip entry ${e.name}`);
    tree[e.name] = toBytes(e.data);
  }
  return zipSync(tree, { level: 6 });
}

/**
 * A streaming zip writer: entries are deflated as they are added and the archive comes out of
 * `readable` chunk by chunk, so a large export never holds the whole zip in memory.
 * Call `add` for each entry (sequentially), then `finish`.
 */
export class ZipStream {
  readonly readable: ReadableStream<Uint8Array>;
  private readonly zip: Zip;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private failed: Error | null = null;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
    this.zip = new Zip((err, chunk, final) => {
      const c = this.controller;
      if (!c) return;
      if (err) {
        this.failed = err;
        c.error(err);
        return;
      }
      c.enqueue(chunk);
      if (final) c.close();
    });
  }

  /** Adds one entry; `chunks` may be bytes, a string, or an (async) iterable of either. */
  async add(
    name: string,
    chunks: Uint8Array | string | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  ) {
    if (this.failed) throw this.failed;
    const entry = new ZipDeflate(name, { level: 6 });
    this.zip.add(entry);
    if (typeof chunks === "string" || chunks instanceof Uint8Array) {
      entry.push(toBytes(chunks), true);
      return;
    }
    for await (const chunk of chunks) entry.push(toBytes(chunk), false);
    entry.push(new Uint8Array(0), true);
  }

  finish(): void {
    this.zip.end();
  }
}
