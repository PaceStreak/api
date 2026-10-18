/** PROFILE-ACCOUNT beyond the pytest ports: round-trip budgets, the queued import, the feed cache, rewrite fixes. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { importJobs, workouts } from "../src/db/schema/index.ts";
import { buildCalendar, summaryFor } from "../src/modules/account/calendar.ts";
import { cleanTags, localNoon } from "../src/modules/account/importer.ts";
import { INLINE_IMPORT_BYTES, importSlice } from "../src/modules/account/service.ts";
import { signup } from "./fixtures/auth.ts";
import { testDb } from "./fixtures/db.ts";
import { putWorkout } from "./fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";
import { person, uniqueHandle, upload } from "./fixtures/profile.ts";
import { jobCtx } from "./jobs/helpers.ts";

describe("profile routes", () => {
  it("GET /me is one round trip, creating the profile on first use", async () => {
    const { token } = await signup();
    const first = await api("/v1/me", { token });
    expectRoundTrips(first, 1);
    const body = await jsonOf<{ profile: { avatar_hue: number }; unread_notifications: number }>(first);
    expect(body.profile.avatar_hue).toBeGreaterThanOrEqual(0);
    expect(body.unread_notifications).toBe(0);
    expectRoundTrips(await api("/v1/me", { token }), 1);
  });

  it("budgets: terms 1, handle check 1, plain settings 2, week-moving settings 2", async () => {
    const { token } = await person();
    const me = await jsonOf<{ terms_version: string }>(await api("/v1/me", { token }));
    expectRoundTrips(await api("/v1/me/terms", { token, json: { version: me.terms_version } }), 1);
    expectRoundTrips(await api(`/v1/handles/${uniqueHandle()}`, { token }), 1);
    const plain = await api("/v1/me/profile", { token, method: "PATCH", json: { bio: "  hi  " } });
    expectRoundTrips(plain, 2);
    expect((await jsonOf<{ profile: { bio: string } }>(plain)).profile.bio).toBe("hi");
    const week = await api("/v1/me/profile", {
      token,
      method: "PATCH",
      json: { timezone: "Asia/Kolkata", weekly_target: 5 },
    });
    expect(week.status).toBe(200);
    expectRoundTrips(week, 2);
    expect((await jsonOf<{ profile: { timezone: string } }>(week)).profile.timezone).toBe("Asia/Kolkata");
  });

  it("changed: an explicit null for a NOT NULL setting is ignored instead of a 500", async () => {
    const { token } = await person();
    const res = await api("/v1/me/profile", {
      token,
      method: "PATCH",
      json: { reminder_hour: null, bio: "" },
    });
    expect(res.status).toBe(200);
    const p = (await jsonOf<{ profile: { reminder_hour: number; bio: null } }>(res)).profile;
    expect(p.reminder_hour).toBe(18);
    expect(p.bio).toBeNull();
  });

  it("handle taken on PATCH is 409, social settings need social age, bad zone is 422", async () => {
    const a = await person();
    const { token } = await person(uniqueHandle(), { birth_year: new Date().getUTCFullYear() - 14 });
    const taken = await api("/v1/me/profile", { token, method: "PATCH", json: { handle: a.handle } });
    expect([taken.status, await taken.json()]).toEqual([409, { detail: "That handle is taken" }]);
    const share = await api("/v1/me/profile", { token, method: "PATCH", json: { visibility: "public" } });
    expect(share.status).toBe(403);
    const tz = await api("/v1/me/profile", { token, method: "PATCH", json: { timezone: "Mars/Base" } });
    expect([tz.status, await tz.json()]).toEqual([422, { detail: "Unknown timezone" }]);
    // Onboarding with a taken handle fails on the unique index, as the spec's 409.
    const fresh = await signup();
    const clash = await api("/v1/me/onboarding", {
      token: fresh.token,
      json: { handle: a.handle, birth_year: 1990, accept_terms: true },
    });
    expect([clash.status, await clash.json()]).toEqual([409, { detail: "That handle is taken" }]);
  });
});

describe("account routes", () => {
  it("security events, cancel and calendar writes are one round trip each", async () => {
    const { token } = await person();
    expectRoundTrips(await api("/v1/me/security-events", { token }), 1);
    const cancel = await api("/v1/me/delete/cancel", { token, method: "POST" });
    expect(await cancel.json()).toEqual({ cancelled: false });
    expectRoundTrips(cancel, 1);
    const created = await api("/v1/me/calendar", { token, method: "POST" });
    expectRoundTrips(created, 1);
    const path = new URL((await jsonOf<{ url: string }>(created)).url).pathname;
    const first = await api(path);
    expect(first.status).toBe(200);
    expectRoundTrips(first, 1);
    expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await api("/v1/calendar/short.ics")).status).toBe(404);
    expect((await api("/v1/calendar/not-an-ics-file-at-all-xxxxxx")).status).toBe(404);
  });

  it("export json is two round trips and carries no habit to anyone else", async () => {
    const me = await person();
    await putWorkout(me.userId);
    const res = await api("/v1/me/export?format=json", { token: me.token });
    expectRoundTrips(res, 2);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="pacestreak-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const bad = await api("/v1/me/export?format=xml", { token: me.token });
    expect(bad.status).toBe(422);
  });

  it("import refuses non-JSON and non-exports, and needs the file field", async () => {
    const { token } = await person();
    expect(await jsonOf(await upload("/v1/me/import", token, "nope"))).toEqual({ detail: "Not a JSON file" });
    expect(await jsonOf(await upload("/v1/me/import", token, "[]"))).toEqual({
      detail: "Not a PaceStreak export",
    });
  });

  it("a file over the inline cap is staged and imported by queue slices", async () => {
    const owner = await person();
    const started = Date.now() - 86_400_000;
    const items = Array.from({ length: 1200 }, (_, i) => ({
      id: crypto.randomUUID(),
      discipline: "run",
      started_at: new Date(started - i * 3_600_000).toISOString(),
      notes: "x".repeat(900),
      distance_m: 5000,
      tags: ["Hill Reps"],
    }));
    const lines = [
      "{",
      '"format":"pacestreak-export",',
      '"version":3,',
      '"gear":[',
      '{"id":"g1","name":"Racers"}',
      "],",
      '"workouts":[',
      ...items.map((w, i) => `${JSON.stringify({ ...w, gear_id: "g1" })}${i < items.length - 1 ? "," : ""}`),
      "]",
      "}",
    ];
    let text = lines.join("\n");
    let pads = 0;
    while (text.length <= INLINE_IMPORT_BYTES)
      text = text.replace('"version":3,', `"version":3,\n"pad${pads++}":"${"p".repeat(1 << 20)}",`);
    const res = await upload("/v1/me/import", owner.token, text);
    expect(await res.json()).toEqual({ imported: 0, skipped: 0, queued: true });
    const { db } = testDb();
    const [job] = await db.select().from(importJobs).where(eq(importJobs.userId, owner.userId));
    expect(job).toBeDefined();
    for (let i = 0; i < 40; i++) {
      const [now] = await db
        .select()
        .from(importJobs)
        .where(eq(importJobs.id, job?.id ?? ""));
      if (now?.status === "done" || now?.status === "failed") break;
      await importSlice(jobCtx(), job?.id ?? "");
    }
    const [done] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job?.id ?? ""));
    expect([done?.status, done?.error]).toEqual(["done", null]);
    const rows = await db.select().from(workouts).where(eq(workouts.userId, owner.userId));
    expect(rows).toHaveLength(1200);
    expect(rows.every((r) => r.gearId !== null && r.tags[0] === "hill-reps")).toBe(true);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(1200);
  });
});

describe("account helpers", () => {
  it("cleanTags, localNoon and the calendar summary", () => {
    expect(cleanTags(["#Hill Reps", "hill-reps", "  ", "A".repeat(40)])).toEqual([
      "hill-reps",
      "a".repeat(24),
    ]);
    expect(new Date(localNoon("2026-07-01", "Asia/Kolkata")).toISOString()).toBe("2026-07-01T06:30:00.000Z");
    expect(new Date(localNoon("2026-07-01", "America/New_York")).toISOString()).toBe(
      "2026-07-01T16:00:00.000Z",
    );
    const w = {
      id: "w",
      discipline: "kite_surf",
      title: null,
      startedAt: 0,
      durationSec: null,
      distanceM: 12_345,
    };
    expect(summaryFor(w)).toBe("Kite_Surf · 12.3 km");
    const ics = buildCalendar(
      "T",
      0,
      [w],
      [{ id: "p", startsOn: "2026-01-01", endsOn: null }],
      0b101,
      "2026-01-05",
    );
    expect(ics).toContain("DURATION:PT30M");
    expect(ics).toContain("DTEND;VALUE=DATE:20260326");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
  });
});
