import fc from "fast-check";
import { describe, expect, it } from "vitest";
import fitnotes from "../../docs/rewrite/python-tests/fixtures/lifting/fitnotes.csv?raw";
import hevy from "../../docs/rewrite/python-tests/fixtures/lifting/hevy.csv?raw";
import strong from "../../docs/rewrite/python-tests/fixtures/lifting/strong.csv?raw";
import { FormatError } from "../../src/heavy/bytes.ts";
import { CSV_NOT_UTF8, CsvReader, type CsvState, csvRow, parseCsv } from "../../src/heavy/csv.ts";
import { cutsFor, enc, feedSliced } from "./helpers.ts";

const tricky = [
  "﻿date,title,notes\r\n",
  '2026-09-01,"Run, easy","said ""hi""\r\nthen left"\r\n',
  "\r\n",
  "2026-09-02,Ride ☕ café,\n",
  '2026-09-03,"",a"b\r',
  '2026-09-04,"ab"c,last',
].join("");

const fixtures: Record<string, Uint8Array> = {
  "strong.csv": enc(strong),
  "hevy.csv": enc(hevy),
  "fitnotes.csv": enc(fitnotes),
  tricky: enc(tricky),
};

describe("csv reader", () => {
  it("reads the lifting fixtures like Python's csv module", () => {
    const rows = parseCsv(fixtures["hevy.csv"] as Uint8Array);
    expect(rows[0]?.[0]).toBe("title");
    expect(rows[1]).toEqual([
      "Pull",
      "30 Sep 2026, 18:05",
      "30 Sep 2026, 19:10",
      "",
      "Lat Pulldown (Cable)",
      "",
      "",
      "0",
      "warmup",
      "30",
      "12",
      "",
      "",
      "",
    ]);
    expect(parseCsv(fixtures["strong.csv"] as Uint8Array)).toHaveLength(8);
    expect(parseCsv(fixtures["fitnotes.csv"] as Uint8Array)[4]).toEqual([
      "2026-09-11",
      "Treadmill",
      "Cardio",
      "",
      "",
      "5",
      "km",
      "0:30:00",
      "",
    ]);
  });

  it("handles quotes, embedded newlines, BOM, blank lines, CR endings and Python's leniencies", () => {
    expect(parseCsv(fixtures.tricky as Uint8Array)).toEqual([
      ["date", "title", "notes"],
      ["2026-09-01", "Run, easy", 'said "hi"\r\nthen left'],
      ["2026-09-02", "Ride ☕ café", ""],
      ["2026-09-03", "", 'a"b'],
      ["2026-09-04", "abc", "last"],
    ]);
  });

  it("keeps a quoted empty line as a record and ends an unterminated quote at EOF", () => {
    expect(parseCsv(enc('a\n""\n"open'))).toEqual([["a"], [""], ["open"]]);
  });

  it("supports other delimiters and rejects non-UTF-8", () => {
    expect(parseCsv(enc("a;b\n1;2"), { delimiter: ";" })).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(() => parseCsv(new Uint8Array([0x61, 0xff, 0x0a]))).toThrow(new FormatError(CSV_NOT_UTF8));
  });

  it("slice-at-any-offset equals whole-file parse (property)", () => {
    for (const [name, bytes] of Object.entries(fixtures)) {
      const whole = parseCsv(bytes);
      fc.assert(
        fc.property(cutsFor(bytes.length), (cuts) => {
          const { out } = feedSliced<CsvState, string[]>(bytes, cuts, (st) => new CsvReader(st));
          expect(out, name).toEqual(whole);
        }),
        { numRuns: 200 },
      );
    }
  });

  it("writes rows as Python's csv.writer does", () => {
    expect(csvRow(["a", 1, true, null, 'x,"y"', "line\nbreak"])).toBe(
      'a,1,True,,"x,""y""","line\nbreak"\r\n',
    );
    expect(csvRow([""])).toBe('""\r\n');
    const rows = [
      ["a", 'b"c', "d,e"],
      ["", "x\r\ny", "z"],
    ];
    expect(parseCsv(enc(rows.map(csvRow).join("")))).toEqual(rows);
  });
});
