/**
 * Port of tests/test_habits.py: smart reminder timing (the game engine's reminder helpers).
 *
 * Still owned by other units: test_profile_exposes_smart_mode (PROFILE-ACCOUNT: PATCH /v1/me/profile),
 * test_monthly_goal_counts_distinct_days and test_rest_days_are_private_and_never_count (TRAINING: /v1/me/monthly-goal
 * and /v1/me/rest-days, spec/training-b.md §1d).
 */
import { describe, expect, it } from "vitest";
import { inQuietHour, learnReminderHour, reminderHour } from "../../src/modules/game/service.ts";

describe("test_habits", () => {
  it("learns_an_hour_before_the_usual_time", () => {
    expect(learnReminderHour([7, 7, 7, 7, 18, 18], 22, 6)).toBe(6);
    // Ties go to the earlier habit.
    expect(learnReminderHour([7, 7, 7, 18, 18, 18], 22, 6)).toBe(6);
  });

  it("needs_enough_history", () => {
    expect(learnReminderHour([7, 7, 7], 22, 7)).toBeNull();
  });

  it("never_learns_a_quiet_hour", () => {
    // Usually trains at 6am; 5am is inside quiet hours 22-7, so fall back.
    expect(learnReminderHour(Array(8).fill(6), 22, 7)).toBeNull();
    expect(inQuietHour(23, 22, 7)).toBe(true);
    expect(inQuietHour(3, 22, 7)).toBe(true);
    expect(inQuietHour(12, 22, 7)).toBe(false);
    expect(inQuietHour(5, 7, 7)).toBe(false);
  });

  it("mode_chooses_the_hour", () => {
    expect(reminderHour("smart", 18, 6)).toBe(6);
    expect(reminderHour("smart", 18, null)).toBe(18);
    expect(reminderHour("fixed", 18, 6)).toBe(18);
  });
});
