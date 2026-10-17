import { describe, expect, it } from "vitest";
import { b64ToBytes, b64urlDecode, b64urlEncode, bytesToB64, hex, utf8 } from "../../src/lib/b64url.ts";
import { constraintMessage, isConstraintError } from "../../src/lib/errors.ts";
import { etagMatches, weakEtag } from "../../src/lib/etag.ts";
import { fold, likePattern } from "../../src/lib/fold.ts";
import { isoWeek, isoWeekKey, mondayOf } from "../../src/lib/isoweek.ts";
import {
  addDays,
  daysBetween,
  isIsoDate,
  isValidTimezone,
  localDate,
  localHour,
  localParts,
  monthKey,
  parseInstant,
  pyWeekday,
  seasonBounds,
  seasonId,
  toWire,
  weekStart,
  zone,
} from "../../src/lib/time.ts";
import { UUID_RE, uuid7, uuid7Time } from "../../src/lib/uuid7.ts";

describe("uuid7", () => {
  it("is a lowercase RFC 9562 v7 UUID carrying its timestamp", () => {
    const id = uuid7(1_760_000_000_123);
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
    expect(uuid7Time(id)).toBe(1_760_000_000_123);
  });

  it("is strictly increasing within one millisecond and across a clock step back", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5000; i++) ids.push(uuid7(1_760_000_000_000));
    ids.push(uuid7(1_759_999_999_000));
    for (let i = 1; i < ids.length; i++) expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
  });

  it("rejects non-v7 ids for time extraction", () => {
    expect(uuid7Time(crypto.randomUUID())).toBeNull();
  });
});

describe("b64url", () => {
  it("round-trips bytes and rejects junk", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlEncode(bytes)).not.toMatch(/[+/=]/);
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    expect(() => b64urlDecode("a+b")).toThrow();
    expect(hex(utf8("hi"))).toBe("6869");
  });
});

describe("fold", () => {
  it("is Unicode case- and accent-insensitive", () => {
    expect(fold("ÄRGER Café")).toBe("arger cafe");
    expect(fold("Ｆｕｌｌ")).toBe("full");
  });

  it("escapes LIKE wildcards in the term", () => {
    expect(likePattern("50%_off\\", "prefix")).toBe("50\\%\\_off\\\\%");
    expect(likePattern("Él", "contains")).toBe("%el%");
  });
});

describe("time", () => {
  it("formats every timestamp as ISO with ms and Z", () => {
    expect(toWire(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toWire(null)).toBeNull();
    expect(toWire(Date.UTC(2026, 9, 17, 9, 30, 0, 123))).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("parses instants with a zone only", () => {
    expect(parseInstant("2026-10-17T09:30:00+05:30")).toBe(Date.UTC(2026, 9, 17, 4, 0));
    expect(parseInstant("2026-10-17T09:30:00.123456Z")).toBe(Date.UTC(2026, 9, 17, 9, 30, 0, 123));
    expect(parseInstant("2026-10-17T09:30:00")).toBeNull();
    expect(parseInstant("nope")).toBeNull();
  });

  it("validates dates and zones, aliases included", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("US/Pacific")).toBe(true);
    expect(isValidTimezone("Mars/Base")).toBe(false);
    expect(zone("Mars/Base")).toBe("UTC");
  });

  it("computes local dates and hours, including half-hour zones and DST", () => {
    const t = Date.UTC(2026, 9, 17, 20, 0);
    expect(localDate(t, "Asia/Kolkata")).toBe("2026-10-18");
    expect(localHour(t, "Asia/Kolkata")).toBe(1);
    expect(localParts(t, "Asia/Kathmandu").minute).toBe(45);
    // New York: EDT (UTC-4) in July, EST (UTC-5) in January.
    expect(localHour(Date.UTC(2026, 6, 1, 12), "America/New_York")).toBe(8);
    expect(localHour(Date.UTC(2026, 0, 1, 12), "America/New_York")).toBe(7);
    expect(localParts(Date.UTC(2026, 9, 19, 12), "UTC").weekday).toBe(0);
  });

  it("does Python-style calendar arithmetic", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-01-01", "2026-03-01")).toBe(59);
    expect(pyWeekday("2026-10-19")).toBe(0); // Monday
    expect(weekStart("2026-10-18", 0)).toBe("2026-10-12");
    expect(weekStart("2026-10-18", 6)).toBe("2026-10-18");
    expect(weekStart("2026-10-17", 6)).toBe("2026-10-11");
    expect(monthKey("2026-10-18")).toBe("2026-10");
    expect(seasonId("2026-10-18")).toBe("2026-Q4");
    expect(seasonId("2026-03-31")).toBe("2026-Q1");
    expect(seasonBounds("2026-Q4")).toEqual(["2026-10-01", "2026-12-31"]);
    expect(seasonBounds("2028-Q1")).toEqual(["2028-01-01", "2028-03-31"]);
  });
});

describe("isoweek", () => {
  it("matches ISO-8601 week numbering at year boundaries", () => {
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(isoWeek("2026-01-01")).toEqual({ year: 2026, week: 1 });
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
    expect(isoWeekKey("2026-10-18")).toBe("2026-W42");
  });
});

describe("etag", () => {
  it("builds weak tags and matches If-None-Match lists", () => {
    const tag = weakEtag(42, "r7", null);
    expect(tag).toBe('W/"42.r7.-"');
    expect(etagMatches(undefined, tag)).toBe(false);
    expect(etagMatches('"x", W/"42.r7.-"', tag)).toBe(true);
    expect(etagMatches('"42.r7.-"', tag)).toBe(true);
    expect(etagMatches("*", tag)).toBe(true);
    expect(etagMatches('W/"43.r7.-"', tag)).toBe(false);
  });
});

describe("errors", () => {
  it("recognises D1 constraint failures, including wrapped ones", () => {
    const d1 = new Error("D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT");
    expect(isConstraintError(d1)).toBe(true);
    expect(isConstraintError(new Error("Failed query", { cause: d1 }))).toBe(true);
    expect(constraintMessage(d1)).toBe("UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT");
    expect(isConstraintError(new Error("network"))).toBe(false);
  });
});
