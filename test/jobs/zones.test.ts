import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atLocalHour, groupByLocalHour, hoursByZone, zonesAtHour } from "../../src/jobs/zones.ts";

/** Fixed-offset zones, in minutes east of UTC: the oracle is plain arithmetic. */
const FIXED: Record<string, number> = {
  UTC: 0,
  "Asia/Kolkata": 330,
  "Asia/Kathmandu": 345,
  "Asia/Tokyo": 540,
  "Pacific/Kiritimati": 840,
  "Pacific/Pago_Pago": -660,
  "Etc/GMT+5": -300,
  "Asia/Kabul": 270,
};
const DST_ZONES = [
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "America/St_Johns",
  "Europe/Berlin",
];
const ALL = [...Object.keys(FIXED), ...DST_ZONES];

const instant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) });

/** Independent oracle for any zone: a different Intl entry point than lib/time's formatter. */
function oracleHour(ms: number, tz: string): number {
  return Number(new Date(ms).toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }));
}

describe("zones", () => {
  it("fixed-offset zones (+5:30, +5:45, +4:30, -11, +14) match offset arithmetic", () => {
    fc.assert(
      fc.property(instant, fc.constantFrom(...Object.keys(FIXED)), (ms, tz) => {
        const offset = FIXED[tz] ?? 0;
        const expected = new Date(ms + offset * 60_000).getUTCHours();
        expect(hoursByZone([tz], ms).get(tz)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("every row lands in its zone's local hour, DST zones included", () => {
    const rows = fc.array(fc.record({ id: fc.uuid(), tz: fc.constantFrom(...ALL) }), { maxLength: 60 });
    fc.assert(
      fc.property(instant, rows, (ms, rs) => {
        const groups = groupByLocalHour(rs, (r) => r.tz, ms);
        let total = 0;
        for (const [hour, list] of groups) {
          expect(list.length).toBeGreaterThan(0);
          for (const r of list) expect(oracleHour(ms, r.tz)).toBe(hour);
          total += list.length;
        }
        expect(total).toBe(rs.length);
      }),
      { numRuns: 300 },
    );
  });

  it("atLocalHour keeps exactly the rows whose target is their local hour", () => {
    const rows = fc.array(
      fc.record({ tz: fc.constantFrom(...ALL), hour: fc.option(fc.integer({ min: 0, max: 23 })) }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(instant, rows, (ms, rs) => {
        const kept = atLocalHour(
          rs,
          (r) => r.tz,
          (r) => r.hour,
          ms,
        );
        const expected = rs.filter((r) => r.hour !== null && oracleHour(ms, r.tz) === r.hour);
        expect(kept).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("zonesAtHour agrees with the oracle", () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 0, max: 23 }), (ms, hour) => {
        const want = ALL.filter((tz) => oracleHour(ms, tz) === hour);
        expect(zonesAtHour(ALL, hour, ms).sort()).toEqual(want.sort());
      }),
    );
  });

  it("follows DST transitions", () => {
    const h = (tz: string, ms: number) => hoursByZone([tz], ms).get(tz);
    // 2026-03-08: New York springs forward at 07:00 UTC (EST -5 -> EDT -4).
    expect(h("America/New_York", Date.UTC(2026, 2, 8, 6, 30))).toBe(1);
    expect(h("America/New_York", Date.UTC(2026, 2, 8, 7, 30))).toBe(3);
    // 2026-10-25: London falls back at 01:00 UTC, so local 01:xx happens twice.
    expect(h("Europe/London", Date.UTC(2026, 9, 25, 0, 30))).toBe(1);
    expect(h("Europe/London", Date.UTC(2026, 9, 25, 1, 30))).toBe(1);
    // Lord Howe shifts by 30 minutes: +10:30 in winter, +11 in summer.
    expect(h("Australia/Lord_Howe", Date.UTC(2026, 6, 1, 0, 0))).toBe(10);
    expect(h("Australia/Lord_Howe", Date.UTC(2026, 0, 1, 0, 0))).toBe(11);
  });

  it("invalid and missing zones count as UTC", () => {
    const ms = Date.UTC(2026, 9, 14, 9, 10);
    const groups = groupByLocalHour([{ tz: "Not/AZone" }, { tz: null }, { tz: "UTC" }], (r) => r.tz, ms);
    expect([...groups.keys()]).toEqual([9]);
    expect(groups.get(9)).toHaveLength(3);
  });
});
