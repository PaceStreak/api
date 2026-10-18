/**
 * Port of tests/test_training.py. The GAME unit ports the recompute concurrency case; PROFILE-ACCOUNT the profile,
 * export/import and deletion cases; TRAINING ports the rest.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gear, userStats, weighIns, workouts } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { recompute } from "../../src/modules/game/service.ts";
import { login, signup } from "../fixtures/auth.ts";
import { testDb } from "../fixtures/db.ts";
import { person, putWorkout } from "../fixtures/game.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { onboard, person as onboarded, uniqueHandle, upload } from "../fixtures/profile.ts";
import { jobCtx } from "../jobs/helpers.ts";

describe("test_training", () => {
  it("recompute_is_serialized_across_concurrent_calls", async () => {
    const me = await person();
    await putWorkout(me.userId);
    await Promise.all([
      recompute(jobCtx(), me.userId, { notify: false }),
      recompute(jobCtx(), me.userId, { notify: false }),
    ]);
    const rows = await testDb().db.select().from(userStats).where(eq(userStats.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessions).toBe(1);
    expect(rows[0]?.currentStreak).toBe(0);
  });

  // ---- PROFILE-ACCOUNT ------------------------------------------------------------------------------------
  // Workouts, gear and weigh-ins are seeded straight into D1 (TRAINING owns their routes) and read back from D1.

  it("me_reports_onboarding_needed", async () => {
    const { token } = await signup();
    const me = await jsonOf<{ needs_onboarding: boolean; profile: { handle: string | null } }>(
      await api("/v1/me", { token }),
    );
    expect(me.needs_onboarding).toBe(true);
    expect(me.profile.handle).toBeNull();
  });

  it("onboarding_refuses_under_thirteen", async () => {
    const { token } = await signup();
    const res = await api("/v1/me/onboarding", {
      token,
      json: { handle: uniqueHandle("kid"), birth_year: new Date().getUTCFullYear() - 10, accept_terms: true },
    });
    expect(res.status).toBe(403);
  });

  it("teen_is_forced_private", async () => {
    const { token } = await signup();
    const out = await onboard(token, uniqueHandle("teen"), {
      birth_year: new Date().getUTCFullYear() - 14,
      visibility: "public",
    });
    expect(out.profile.visibility).toBe("private");
    const me = await jsonOf<{ social_allowed: boolean }>(await api("/v1/me", { token }));
    expect(me.social_allowed).toBe(false);
  });

  it("handles_are_unique_and_validated", async () => {
    const taken = await onboarded(uniqueHandle("taken"));
    const { token } = await signup();
    const avail = async (h: string) =>
      (await jsonOf<{ available: boolean }>(await api(`/v1/handles/${encodeURIComponent(h)}`, { token })))
        .available;
    expect(await avail(taken.handle)).toBe(false);
    expect(await avail("Bad Handle")).toBe(false);
    expect(await avail("admin")).toBe(false);
    expect(await avail(uniqueHandle("free_"))).toBe(true);
  });

  it("export_and_import_roundtrip", async () => {
    const me = await onboarded();
    await putWorkout(me.userId);
    const exported = await api("/v1/me/export?format=json", { token: me.token });
    expect(exported.status).toBe(200);
    const data = await jsonOf<{ format: string; workouts: { id: string }[] }>(exported);
    expect(data.format).toBe("pacestreak-export");
    expect(data.workouts).toHaveLength(1);
    const csv = await api("/v1/me/export?format=csv", { token: me.token });
    expect(csv.headers.get("content-type")).toBe("application/zip");
    const ics = await api("/v1/me/export?format=ics", { token: me.token });
    expect(await ics.text()).toContain("BEGIN:VEVENT");

    // Importing someone else's export re-mints the ids and never touches theirs.
    const other = await onboarded();
    const res = await upload("/v1/me/import", other.token, JSON.stringify(data));
    expect(await res.json()).toEqual({ imported: 1, skipped: 0 });
    const theirs = await testDb().db.select().from(workouts).where(eq(workouts.userId, other.userId));
    expect(theirs[0]?.source).toBe("import");
    expect(theirs[0]?.id).not.toBe(data.workouts[0]?.id);
    // Importing it again is a no-op for the original owner.
    const again = await upload("/v1/me/import", me.token, JSON.stringify(data));
    expect(await again.json()).toEqual({ imported: 0, skipped: 1 });
  });

  it("weigh_ins_export_and_import_including_legacy_daily_weight", async () => {
    const me = await onboarded();
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const legacy = {
      format: "pacestreak-export",
      version: 2,
      workouts: [],
      body_metrics: [{ date: day, weight_kg: 79.9, sleep_hours: 8 }],
      weigh_ins: [{ id: crypto.randomUUID(), weighed_at: at, moment: "waking", weight_kg: 79.5 }],
    };
    const send = async (data: unknown, token: string) =>
      expect((await upload("/v1/me/import", token, JSON.stringify(data))).status).toBe(200);
    await send(legacy, me.token);
    await send(legacy, me.token); // twice: no duplicates
    const { db } = testDb();
    const mine = await db.select().from(weighIns).where(eq(weighIns.userId, me.userId));
    expect(mine.map((w) => `${w.moment}:${w.weightKg}`).sort()).toEqual(["other:79.9", "waking:79.5"]);
    expect(mine.find((w) => w.moment === "other")?.localDate).toBe(day);

    const exported = await jsonOf<{
      version: number;
      weigh_ins: unknown[];
      body_metrics: Record<string, unknown>[];
    }>(await api("/v1/me/export?format=json", { token: me.token }));
    expect(exported.version).toBe(3);
    expect(exported.weigh_ins).toHaveLength(2);
    expect(exported.body_metrics[0]?.sleep_hours).toBe(8);
    expect("weight_kg" in (exported.body_metrics[0] ?? {})).toBe(false);
    // Someone else importing it gets their own copies, and the owner keeps theirs.
    const other = await onboarded();
    await send(exported, other.token);
    const theirs = await db.select().from(weighIns).where(eq(weighIns.userId, other.userId));
    expect(theirs).toHaveLength(2);
    const ids = new Set(mine.map((w) => w.id));
    expect(theirs.some((w) => ids.has(w.id))).toBe(false);
  });

  it("account_deletion_is_scheduled_and_cancellable", async () => {
    const me = await onboarded();
    const res = await api("/v1/me/delete", { token: me.token, json: { password: me.password } });
    expect(res.status).toBe(200);
    // Every session was ended...
    expect((await api("/v1/me", { token: me.token })).status).toBe(401);
    // ...and signing back in is how it gets cancelled.
    const back = await login(me.email);
    const now = await jsonOf<{ profile: { deletion_scheduled_at: string | null } }>(
      await api("/v1/me", { token: back.token }),
    );
    expect(now.profile.deletion_scheduled_at).not.toBeNull();
    expect(await jsonOf(await api("/v1/me/delete/cancel", { token: back.token, method: "POST" }))).toEqual({
      cancelled: true,
    });
    const events = await jsonOf<{ kind: string }[]>(
      await api("/v1/me/security-events", { token: back.token }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("deletion_scheduled");
    expect(kinds).toContain("login");
  });

  it("export_carries_tags_and_gear_and_import_restores_them", async () => {
    const me = await onboarded();
    const { db } = testDb();
    const now = Date.now();
    const shoes = uuid7(now);
    await db.insert(gear).values({
      id: shoes,
      userId: me.userId,
      name: "Racers",
      limitM: 400_000,
      createdAt: now,
      updatedAt: now,
    });
    const w = await putWorkout(me.userId, { discipline: "run", distanceM: 5000, sets: [] });
    await db
      .update(workouts)
      .set({ tags: ["race"], gearId: shoes })
      .where(eq(workouts.id, w.id));
    const exported = await jsonOf<{
      version: number;
      gear: { name: string }[];
      workouts: { tags: string[] }[];
    }>(await api("/v1/me/export?format=json", { token: me.token }));
    expect(exported.version).toBe(3);
    expect(exported.gear[0]?.name).toBe("Racers");
    expect(exported.workouts[0]?.tags).toEqual(["race"]);

    const other = await onboarded();
    const res = await upload("/v1/me/import", other.token, JSON.stringify(exported));
    expect((await jsonOf<{ imported: number }>(res)).imported).toBe(1);
    const theirGear = await db.select().from(gear).where(eq(gear.userId, other.userId));
    expect(theirGear.map((g) => g.name)).toEqual(["Racers"]);
    const linked = await db
      .select()
      .from(workouts)
      .where(and(eq(workouts.userId, other.userId), eq(workouts.gearId, theirGear[0]?.id ?? "")));
    expect(linked.map((x) => x.distanceM)).toEqual([5000]);
    // Importing twice never duplicates the gear.
    await upload("/v1/me/import", other.token, JSON.stringify(exported));
    expect(await db.select().from(gear).where(eq(gear.userId, other.userId))).toHaveLength(1);
  });
});
