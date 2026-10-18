/** Port of tests/test_worker.py (notification cases; JOBS-12 adds the rest). */
import { describe, expect, it } from "vitest";
import { isQuietDay } from "../../src/modules/notifications/service.ts";

describe("test_worker", () => {
  it("quiet_days_hold_nudges_back_from_push_and_email", () => {
    const now = Date.now();
    const p = (quietDays: number | null) => ({ quietDays, timezone: "UTC", quietStart: 22, quietEnd: 7 });
    const everyDay = p(0b1111111);
    expect(isQuietDay(everyDay, "habits", now)).toBe(true);
    expect(isQuietDay(everyDay, "streak_risk", now)).toBe(true);
    // Not a nudge: security, social and backups are never held.
    expect(isQuietDay(everyDay, "security", now)).toBe(false);
    expect(isQuietDay(everyDay, "social", now)).toBe(false);
    expect(isQuietDay(p(null), "habits", now)).toBe(false);
    expect(isQuietDay(p(0), "habits", now)).toBe(false);
  });
});
