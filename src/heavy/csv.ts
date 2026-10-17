/**
 * Resumable CSV reader and Python-compatible CSV writer (DESIGN.md §13, spec/account.md §6).
 *
 * The reader follows Python's `csv` module with the excel dialect, which is RFC 4180 plus its
 * leniencies: a quote inside an unquoted field is literal, text after a closing quote is appended
 * (`"ab"c` reads as `abc`), and `\r\n`, `\n` or a lone `\r` ends a record. Blank lines are skipped,
 * as `csv.DictReader` does. It works on bytes: every delimiter is ASCII, so a slice may end anywhere
 * (inside a quoted field, between `\r` and `\n`, inside a UTF-8 sequence) and the next slice resumes
 * from `reader.state`, which is plain JSON.
 */
import { binaryToBytes, bytesToBinary, concatBytes, decodeUtf8, FormatError } from "./bytes.ts";

/** spec/training-a.md (importers.parse_csv). */
export const CSV_NOT_UTF8 = "CSV files need to be UTF-8.";
export const CSV_UNREADABLE = "That CSV file could not be read.";

/** Python's default `csv.field_size_limit()`. */
const DEFAULT_MAX_FIELD = 131072;

export type CsvState = {
  /** Total bytes fed so far. */
  offset: number;
  /** Bytes of the field being read (binary string). */
  field: string;
  /** Decoded fields of the record being read. */
  record: string[];
  /** 0 start of field, 1 unquoted, 2 inside quotes, 3 quote seen inside quotes, 4 after CR. */
  mode: 0 | 1 | 2 | 3 | 4;
  /** False until the first bytes are known not to be a partial BOM. */
  started: boolean;
  /** Leading bytes held while they could still be a BOM (binary string). */
  head: string;
  /** True once any field of the current record was quoted (so `""` is a record, not a blank line). */
  quoted: boolean;
};

export type CsvOptions = {
  /** One ASCII character. Default `,`. */
  delimiter?: string;
  maxFieldBytes?: number;
  /** Decodes a field's bytes. Default strict UTF-8, failing with "CSV files need to be UTF-8.". */
  decode?: (bytes: Uint8Array) => string;
};

export const initialCsvState = (): CsvState => ({
  offset: 0,
  field: "",
  record: [],
  mode: 0,
  quoted: false,
  started: false,
  head: "",
});

const QUOTE = 0x22;
const CR = 0x0d;
const BOM = [0xef, 0xbb, 0xbf];
const LF = 0x0a;

export class CsvReader {
  state: CsvState;
  private readonly delim: number;
  private readonly maxField: number;
  private readonly decode: (bytes: Uint8Array) => string;

  constructor(state: CsvState = initialCsvState(), opts: CsvOptions = {}) {
    this.state = structuredClone(state);
    const d = opts.delimiter ?? ",";
    if (d.length !== 1 || d.charCodeAt(0) > 0x7f) throw new Error("delimiter must be one ASCII character");
    this.delim = d.charCodeAt(0);
    this.maxField = opts.maxFieldBytes ?? DEFAULT_MAX_FIELD;
    this.decode = opts.decode ?? ((b) => decodeUtf8(b, CSV_NOT_UTF8));
  }

  /** Feeds the next bytes; returns the records completed by them. */
  push(chunk: Uint8Array): string[][] {
    const s = this.state;
    s.offset += chunk.length;
    let bytes: Uint8Array = chunk;
    if (!s.started) {
      // Strip a UTF-8 BOM ("utf-8-sig"), even when a slice ends inside it.
      const head = concatBytes(binaryToBytes(s.head), chunk);
      const prefix = head.subarray(0, 3).every((b, i) => b === BOM[i]);
      if (prefix && head.length < 3) {
        s.head = bytesToBinary(head);
        return [];
      }
      s.started = true;
      s.head = "";
      bytes = prefix ? head.subarray(3) : head;
    }
    return this.scan(bytes);
  }

  private scan(bytes: Uint8Array): string[][] {
    const s = this.state;
    const out: string[][] = [];
    // Accumulate the current field as byte ranges to avoid per-byte string building.
    let pending: Uint8Array[] = s.field ? [binaryToBytes(s.field)] : [];
    let pendingLen = pending[0]?.length ?? 0;
    let start = -1; // start of a run of plain field bytes in `bytes`
    const flushRun = (end: number) => {
      if (start !== -1 && end > start) {
        pending.push(bytes.subarray(start, end));
        pendingLen += end - start;
        if (pendingLen > this.maxField) throw new FormatError(CSV_UNREADABLE);
      }
      start = -1;
    };
    const endField = () => {
      const all = new Uint8Array(pendingLen);
      let at = 0;
      for (const p of pending) {
        all.set(p, at);
        at += p.length;
      }
      s.record.push(this.decode(all));
      pending = [];
      pendingLen = 0;
    };
    const endRecord = () => {
      const blank = s.record.length === 1 && s.record[0] === "" && !s.quoted;
      if (!blank) out.push(s.record);
      s.record = [];
      s.quoted = false;
    };

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (s.mode === 4) {
        // After CR: a following LF belongs to the same line break; anything else starts a record.
        s.mode = 0;
        if (b === LF) continue;
      }
      switch (s.mode) {
        case 0:
          if (b === QUOTE) {
            s.mode = 2;
            s.quoted = true;
          } else if (b === this.delim) {
            endField();
          } else if (b === CR || b === LF) {
            endField();
            endRecord();
            if (b === CR) s.mode = 4;
          } else {
            s.mode = 1;
            start = i;
          }
          break;
        case 1:
          if (b === this.delim || b === CR || b === LF) {
            flushRun(i);
            endField();
            s.mode = 0;
            if (b !== this.delim) {
              endRecord();
              if (b === CR) s.mode = 4;
            }
          } else if (start === -1) {
            start = i;
          }
          break;
        case 2:
          if (b === QUOTE) {
            flushRun(i);
            s.mode = 3;
          } else if (start === -1) {
            start = i;
          }
          break;
        case 3:
          if (b === QUOTE) {
            // Doubled quote: a literal quote, still inside the quoted field.
            start = i;
            s.mode = 2;
          } else if (b === this.delim) {
            endField();
            s.mode = 0;
          } else if (b === CR || b === LF) {
            endField();
            endRecord();
            s.mode = b === CR ? 4 : 0;
          } else {
            // Python appends text after a closing quote to the field.
            s.mode = 1;
            start = i;
          }
          break;
        default:
          break;
      }
    }
    flushRun(bytes.length);
    s.field = pendingLen ? bytesToBinary(concatPending(pending, pendingLen)) : "";
    return out;
  }

  /** Ends the input: returns the last record if the file had no trailing newline. */
  end(): string[][] {
    const s = this.state;
    const out: string[][] = [];
    if (!s.started) {
      // One or two bytes that looked like the start of a BOM: they are content after all.
      s.started = true;
      const head = binaryToBytes(s.head);
      s.head = "";
      out.push(...this.scan(head));
    }
    // An unterminated quoted field ends at EOF, as in Python's non-strict reader.
    if (s.mode === 1 || s.mode === 2 || s.mode === 3 || s.record.length > 0 || s.field !== "") {
      s.record.push(this.decode(binaryToBytes(s.field)));
      s.field = "";
      const blank = s.record.length === 1 && s.record[0] === "" && !s.quoted;
      if (!blank) out.push(s.record);
    }
    s.record = [];
    s.mode = 0;
    s.quoted = false;
    return out;
  }
}

function concatPending(parts: Uint8Array[], len: number): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Parses a whole CSV file. */
export function parseCsv(bytes: Uint8Array, opts: CsvOptions = {}): string[][] {
  const r = new CsvReader(initialCsvState(), opts);
  return [...r.push(bytes), ...r.end()];
}

export type CsvCell = string | number | boolean | null | undefined;

/**
 * One row as Python's `csv.writer` (excel dialect) writes it: quote only when a field holds the
 * delimiter, a quote, CR or LF; double inner quotes; `\r\n` terminator; None as empty; booleans as
 * `True`/`False`. Numbers use `String(n)`: pre-format floats where Python's repr differs (`1.0`).
 */
export function csvRow(cells: readonly CsvCell[]): string {
  if (cells.length === 1 && (cells[0] === "" || cells[0] === null || cells[0] === undefined)) {
    // Python quotes a lone empty field so the row is not read back as a blank line.
    return '""\r\n';
  }
  return `${cells.map(csvCell).join(",")}\r\n`;
}

function csvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  const text = typeof cell === "boolean" ? (cell ? "True" : "False") : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
