/**
 * Port of tests/test_features.py: the calendar feed, iCalendar folding and reserved handles (PROFILE-ACCOUNT).
 * Pauses, recaps, GPX/CSV parsing and the activity import belong to TRAINING and GAME.
 */
import { describe, expect, it } from "vitest";
import { isReserved } from "../../src/lib/handles.ts";
import { escapeText, fold } from "../../src/modules/account/calendar.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";

const pathOf = (url: string) => new URL(url).pathname;

describe("test_features", () => {
  it("calendar_feed_lifecycle", async () => {
    const { token } = await person();
    expect((await jsonOf<{ enabled: boolean }>(await api("/v1/me/calendar", { token }))).enabled).toBe(false);
    const created = await api("/v1/me/calendar", { token, method: "POST" });
    expect(created.status).toBe(201);
    const path = pathOf((await jsonOf<{ url: string }>(created)).url);

    const feed = await api(path);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toMatch(/^text\/calendar/);
    expect(feed.headers.get("cache-control")).toContain("private");
    expect(await feed.text()).toMatch(/^BEGIN:VCALENDAR\r\n/);

    const rotated = pathOf(
      (await jsonOf<{ url: string }>(await api("/v1/me/calendar", { token, method: "POST" }))).url,
    );
    expect((await api(path)).status).toBe(404);
    expect((await api(rotated)).status).toBe(200);

    expect((await api("/v1/me/calendar", { token, method: "DELETE" })).status).toBe(204);
    expect((await api(rotated)).status).toBe(404);

    const events = await jsonOf<{ kind: string }[]>(await api("/v1/me/security-events", { token }));
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["calendar_feed_created", "calendar_feed_rotated", "calendar_feed_revoked"])
      expect(kinds.has(k)).toBe(true);
  });

  it("ics_folding_and_escaping", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = fold(`SUMMARY:${"é".repeat(60)}`);
    for (const part of folded.split("\r\n"))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  });

  it("brand_names_are_reserved_however_they_are_spelled", async () => {
    const { token } = await person();
    for (const handle of ["pacestreak", "real_pacestreak", "pace_streak_hq", "pac3streak"]) {
      const res = await jsonOf<{ available: boolean }>(await api(`/v1/handles/${handle}`, { token }));
      expect(res.available, handle).toBe(false);
    }
    const name = await api("/v1/me/profile", {
      token,
      method: "PATCH",
      json: { display_name: "PaceStreak Team" },
    });
    expect(name.status).toBe(409);
  });

  it("authority_handles_are_reserved_however_they_are_dressed_up", () => {
    for (const handle of [
      "admin",
      "admin_user",
      "the_admin",
      "adm1n",
      "admin2",
      "_admin_",
      "real_moderator",
      "run_mod_42",
      "staff_sam",
      "support_team",
      "noreply",
      "webmaster3",
      "official_runner",
      "officia1",
      "unverified",
      "sysadmin_bob",
      "root",
      "null",
      "deleted_user",
      "me",
      "settings",
    ])
      expect(isReserved(handle), handle).toBe(true);
    // Ordinary words and names that merely contain one must stay available.
    for (const handle of [
      "badminton",
      "padmini",
      "model",
      "modern",
      "dev",
      "su_lin",
      "judge_dredd",
      "team_tri",
      "safety_first_runner",
      "rootsrunner",
      "supporter",
      "staffordshire",
      "lily1",
      "mike_2024",
      "8888",
    ])
      expect(isReserved(handle), handle).toBe(false);
  });
});
