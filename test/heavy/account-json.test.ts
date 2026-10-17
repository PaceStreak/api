import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccountJsonEvent,
  AccountJsonReader,
  type AccountJsonState,
  accountJsonString,
  BACKUP_UNREADABLE,
  NOT_JSON,
  parseAccountJson,
  readAccountJsonLines,
} from "../../src/heavy/account-json.ts";
import { FormatError } from "../../src/heavy/bytes.ts";
import { cutsFor, enc, feedSliced } from "./helpers.ts";

const doc = {
  format: "pacestreak-export",
  version: 2,
  profile: { display_name: "Zoë", bio: 'line\nbreak, "quoted" ☕' },
  workouts: [
    { id: "a", discipline: "run", tags: ["x"], sets: [] },
    { id: "b", discipline: "strength", notes: "}\n],", sets: [{ exercise_id: "bench", reps: 5 }] },
  ],
  habits: [],
  chains: [{ name: "Everything" }],
  exported_at: "2026-10-18T00:00:00+00:00",
};

const fixture = enc(accountJsonString(doc));

describe("account json", () => {
  it("writes one top-level array element per line and stays valid JSON", () => {
    const text = accountJsonString(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.split("\n").slice(0, 7)).toEqual([
      "{",
      '"format":"pacestreak-export",',
      '"version":2,',
      `"profile":${JSON.stringify(doc.profile)},`,
      '"workouts":[',
      `${JSON.stringify(doc.workouts[0])},`,
      `${JSON.stringify(doc.workouts[1])}`,
    ]);
  });

  it("the line reader and the whole-file parser emit the same events", () => {
    const events = readAccountJsonLines(fixture);
    expect(events).toEqual(parseAccountJson(fixture));
    expect(events.filter((e) => e.type === "element" && e.key === "workouts")).toHaveLength(2);
    expect(events).toContainEqual({ type: "arrayStart", key: "habits" });
  });

  it("slice-at-any-offset equals whole-file parse (property)", () => {
    const whole = readAccountJsonLines(fixture);
    fc.assert(
      fc.property(cutsFor(fixture.length), (cuts) => {
        const { out } = feedSliced<AccountJsonState, AccountJsonEvent>(
          fixture,
          cuts,
          (st) => new AccountJsonReader(st),
        );
        expect(out).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses a reformatted or broken file on the line path", () => {
    const pretty = enc(JSON.stringify(doc, null, 2));
    expect(() => readAccountJsonLines(pretty)).toThrow(new FormatError(BACKUP_UNREADABLE));
    expect(() => readAccountJsonLines(enc(JSON.stringify(doc)))).toThrow(BACKUP_UNREADABLE);
    expect(() => readAccountJsonLines(fixture.subarray(0, fixture.length - 3))).toThrow(BACKUP_UNREADABLE);
    expect(() => readAccountJsonLines(enc('{\n"a":1\n"b":2\n}\n'))).toThrow(BACKUP_UNREADABLE);
    expect(() => readAccountJsonLines(enc('{\n"a":[\n1,\n]\n}\n'))).toThrow(BACKUP_UNREADABLE);
    // ...but the small-file path reads any layout.
    expect(parseAccountJson(pretty)).toEqual(readAccountJsonLines(fixture));
  });

  it("the small-file path says 'Not a JSON file' for non-JSON", () => {
    expect(() => parseAccountJson(enc("nope"))).toThrow(new FormatError(NOT_JSON));
    expect(() => parseAccountJson(new Uint8Array([0xff]))).toThrow(NOT_JSON);
    expect(parseAccountJson(enc("[1]"))).toEqual([]);
  });
});
