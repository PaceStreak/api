/** Port of tests/test_admin_merge.py: merging one account into another. */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { auditLog, follows, profiles, sessions, users, workouts } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { signupAs } from "../fixtures/admin.ts";
import { signup } from "../fixtures/auth.ts";
import { testDb } from "../fixtures/db.ts";
import { api, expectRoundTrips, jsonOf } from "../fixtures/http.ts";

const { db } = testDb();
let seq = 1_000_000;

/** tests/test_social.py `log_session`, as rows: the training routes belong to another unit. */
async function logSession(userId: string) {
  const now = Date.now();
  await db.insert(workouts).values({
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId,
    discipline: "run",
    startedAt: now,
    localDate: "2026-10-14",
    clientUpdatedAt: now,
    seq: seq++,
  });
}

async function follow(followerId: string, followeeId: string) {
  const now = Date.now();
  await db
    .insert(follows)
    .values({ id: uuid7(now), createdAt: now, updatedAt: now, followerId, followeeId, status: "accepted" });
}

let handles = 0;
async function addProfile(userId: string): Promise<string> {
  const now = Date.now();
  const handle = `merge_${++handles}_${crypto.randomUUID().slice(0, 6)}`;
  await db.insert(profiles).values({ userId, createdAt: now, updatedAt: now, handle, onboardedAt: now });
  return handle;
}

/**
 * The merge runs on the queue in slices (the Free plan's D1 query cap): the route answers 202 and the consumer
 * (delivered by the test runtime) completes the audit row with the moved counts once the source is gone.
 */
async function merged(source: string): Promise<Record<string, number>> {
  return vi.waitFor(
    async () => {
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "user.merge"),
            sql`json_extract(${auditLog.detail}, '$.source') = ${source}`,
          ),
        );
      const moved = (rows[0]?.detail as { moved?: Record<string, number> } | null)?.moved;
      if (moved === undefined) throw new Error("merge still running");
      return moved;
    },
    { timeout: 15_000, interval: 50 },
  );
}

const scalar = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? -1;

describe("test_admin_merge", () => {
  it("merge_moves_data_drops_self_links_and_credentials", async () => {
    const old = await signup();
    const neu = await signup();
    await logSession(old.userId);
    await logSession(old.userId);
    await logSession(neu.userId);
    await follow(old.userId, neu.userId);
    await follow(neu.userId, old.userId);
    const admin = await signupAs("admin");

    const wrong = await api(`/v1/admin/users/${old.userId}/merge`, {
      json: { into: neu.userId, confirm_email: neu.email },
      token: admin.token,
    });
    expect(wrong.status).toBe(422);
    expect(await jsonOf(wrong)).toEqual({ detail: "Type the source account's email to confirm" });

    const done = await api(`/v1/admin/users/${old.userId}/merge`, {
      json: { into: neu.userId, confirm_email: old.email.toUpperCase() },
      token: admin.token,
    });
    expect(done.status, await done.clone().text()).toBe(202);
    const body = await jsonOf<{ merged_into: string; status: string }>(done);
    expect(body).toEqual({ merged_into: neu.userId, status: "queued" });
    // read, then the freeze + audit row; the merge itself runs on the queue
    expectRoundTrips(done, 2);
    const moved = await merged(old.userId);
    expect(moved.workouts).toBe(2);

    const live = await scalar(
      db
        .select({ n: count() })
        .from(workouts)
        .where(and(eq(workouts.userId, neu.userId), isNull(workouts.deletedAt))),
    );
    expect(live).toBe(3);
    // The old login is gone, and its sessions did not follow the data.
    expect((await api("/v1/auth/me", { token: old.token })).status).toBe(401);
    expect((await api("/v1/auth/me", { token: neu.token })).status).toBe(200);
    // No one follows themselves.
    expect(
      await scalar(
        db.select({ n: count() }).from(follows).where(sql`${follows.followerId} = ${follows.followeeId}`),
      ),
    ).toBe(0);
    expect(
      await scalar(db.select({ n: count() }).from(sessions).where(eq(sessions.userId, old.userId))),
    ).toBe(0);
    expect(await scalar(db.select({ n: count() }).from(users).where(eq(users.id, old.userId)))).toBe(0);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "user.merge"));
    expect(entry?.targetId).toBe(neu.userId);
    expect(entry?.detail).toEqual({ source: old.userId, source_email: old.email, moved });
  });

  it("merge_refuses_itself_and_the_acting_admin", async () => {
    const admin = await signupAs("admin");
    const other = await signup();
    const same = await api(`/v1/admin/users/${other.userId}/merge`, {
      json: { into: other.userId, confirm_email: other.email },
      token: admin.token,
    });
    expect(same.status).toBe(422);
    expect(await jsonOf(same)).toEqual({ detail: "Pick two different accounts" });
    const me = await api(`/v1/admin/users/${admin.userId}/merge`, {
      json: { into: other.userId, confirm_email: admin.email },
      token: admin.token,
    });
    expect(me.status).toBe(409);
  });

  it("merge keeps the destination's colliding rows and can keep the source profile", async () => {
    const old = await signup();
    const neu = await signup();
    const oldHandle = await addProfile(old.userId);
    await addProfile(neu.userId);
    const admin = await signupAs("admin");
    const missing = await api(`/v1/admin/users/${old.userId}/merge`, {
      json: { into: crypto.randomUUID(), confirm_email: old.email },
      token: admin.token,
    });
    expect(missing.status).toBe(404);
    const res = await api(`/v1/admin/users/${old.userId}/merge`, {
      json: { into: neu.userId, confirm_email: old.email, keep_source_profile: true },
      token: admin.token,
    });
    expect(res.status, await res.clone().text()).toBe(202);
    const moved = await merged(old.userId);
    expect(moved.profiles).toBe(1);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, neu.userId));
    expect(p?.handle).toBe(oldHandle);

    // Without keep_source_profile the destination's profile wins and the source's copy is dropped.
    const a = await signup();
    const b = await signup();
    const aHandle = await addProfile(a.userId);
    const bHandle = await addProfile(b.userId);
    const res2 = await api(`/v1/admin/users/${a.userId}/merge`, {
      json: { into: b.userId, confirm_email: a.email },
      token: admin.token,
    });
    expect(res2.status).toBe(202);
    expect((await merged(a.userId)).profiles).toBeUndefined();
    const left = await db.select().from(profiles).where(eq(profiles.userId, b.userId));
    expect(left.map((r) => r.handle)).toEqual([bHandle]);
    expect(await db.select().from(profiles).where(eq(profiles.handle, aHandle))).toEqual([]);
  });

  it("merge is admin only", async () => {
    const mod = await signupAs("moderator");
    const a = await signup();
    const res = await api(`/v1/admin/users/${a.userId}/merge`, {
      json: { into: mod.userId, confirm_email: a.email },
      token: mod.token,
    });
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ detail: "Not found" });
  });
});
