import { env } from "cloudflare:test";
import { and, eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FOLD_COLUMNS,
  rateLimitGuard,
  runBatch,
  SESSION_LOGGED_OUT,
  sessionGuard,
  TOKEN_REVOKED,
  USER_INACTIVE,
  withFold,
  withFoldPatch,
  writeBatch,
} from "../../src/db/batch.ts";
import * as schema from "../../src/db/schema/index.ts";
import {
  habits,
  notifications,
  sessions,
  syncSeq,
  userStats,
  users,
  workouts,
} from "../../src/db/schema/index.ts";
import { HttpError, isConstraintError } from "../../src/lib/errors.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { authedBatch, seedUser, type TestDb, testDb } from "../fixtures/db.ts";

let t: TestDb;
beforeEach(() => {
  t = testDb();
});

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected an HttpError");
}

describe("AuthedBatch.read", () => {
  it("prepends the auth row and costs one round trip", async () => {
    const u = await seedUser(t.db);
    t.reset();
    const [me, mine] = await authedBatch(t.db, u).read(
      t.db.select({ id: users.id }).from(users).where(eq(users.id, u.userId)),
    );
    expect(me).toMatchObject({ id: u.userId, email: u.email, role: "user", isActive: true });
    expect(mine).toEqual([{ id: u.userId }]);
    expect(t.stats).toEqual({ roundTrips: 1, statements: 2 });
  });

  it("rejects a revoked session before returning rows", async () => {
    const u = await seedUser(t.db);
    await t.db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, u.sessionId));
    const e = await rejection(authedBatch(t.db, u).read());
    expect([e.status, e.body]).toEqual([401, { detail: SESSION_LOGGED_OUT }]);
  });

  it("rejects a session id that is not this user's", async () => {
    const a = await seedUser(t.db);
    const b = await seedUser(t.db);
    const e = await rejection(authedBatch(t.db, { ...a, sessionId: b.sessionId }).read());
    expect(e.body).toEqual({ detail: SESSION_LOGGED_OUT });
  });

  it("rejects inactive and missing users, and stale token versions", async () => {
    const inactive = await seedUser(t.db, { isActive: false });
    expect((await rejection(authedBatch(t.db, inactive).read())).body).toEqual({ detail: USER_INACTIVE });
    expect((await rejection(authedBatch(t.db, { ...inactive, userId: uuid7() }).read())).body).toEqual({
      detail: USER_INACTIVE,
    });
    const u = await seedUser(t.db, { tokenVersion: 3 });
    expect((await rejection(authedBatch(t.db, { ...u, tokenVersion: 2 }).read())).body).toEqual({
      detail: TOKEN_REVOKED,
    });
  });
});

describe("AuthedBatch.write and the guards (gate G-3)", () => {
  const habit = (userId: string, name: string) =>
    withFold(habits, { userId, name, startedOn: "2026-10-18", createdAt: Date.now(), updatedAt: Date.now() });

  it("writes atomically in one round trip while the session is live", async () => {
    const u = await seedUser(t.db);
    t.reset();
    const [ins] = await authedBatch(t.db, u).write(
      t.db
        .insert(habits)
        .values(habit(u.userId, "Read"))
        .returning({ id: habits.id, nameFold: habits.nameFold }),
    );
    expect(ins).toHaveLength(1);
    expect(ins[0]?.nameFold).toBe("read");
    expect(t.stats).toEqual({ roundTrips: 1, statements: 2 });
  });

  it("a write racing a logout cannot land: the guard aborts the whole batch", async () => {
    const u = await seedUser(t.db);
    const batch = authedBatch(t.db, u);
    await t.db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, u.sessionId));
    const e = await rejection(batch.write(t.db.insert(habits).values(habit(u.userId, "Ghost"))));
    expect([e.status, e.body]).toEqual([401, { detail: SESSION_LOGGED_OUT }]);
    const rows = await t.db.select().from(habits).where(eq(habits.userId, u.userId));
    expect(rows).toEqual([]);
  });

  it("a failing guard late in a batch rolls back the statements before it", async () => {
    const u = await seedUser(t.db);
    await t.db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, u.sessionId));
    await expect(
      writeBatch(t.db, [t.db.insert(habits).values(habit(u.userId, "Early")), t.db.run(sessionGuard(u))]),
    ).rejects.toSatisfy(isConstraintError);
    expect(await t.db.select().from(habits).where(eq(habits.userId, u.userId))).toEqual([]);
  });

  it("the rate-limit guard aborts on the count an earlier statement in the batch wrote", async () => {
    const key = `test:${uuid7()}`;
    const bump = () =>
      t.db.run(sql`INSERT INTO rate_counters (key, window_start, count) VALUES (${key}, 0, 1)
        ON CONFLICT (key) DO UPDATE SET count = count + 1`);
    await writeBatch(t.db, [bump(), t.db.run(rateLimitGuard(key, 2))]);
    await writeBatch(t.db, [bump(), t.db.run(rateLimitGuard(key, 2))]);
    await expect(writeBatch(t.db, [bump(), t.db.run(rateLimitGuard(key, 2))])).rejects.toSatisfy(
      isConstraintError,
    );
    const row = await env.DB.prepare("SELECT count FROM rate_counters WHERE key = ?")
      .bind(key)
      .first<{ count: number }>();
    expect(row?.count).toBe(2); // the aborted batch's increment was rolled back with it
  });
});

describe("D1 batch semantics the design relies on (gate G-3, local D1)", () => {
  function upsertWorkout(userId: string, id: string, clientUpdatedAt: number, title: string) {
    const now = Date.now();
    return t.db
      .insert(workouts)
      .values({
        id,
        userId,
        discipline: "run",
        title,
        startedAt: now,
        localDate: "2026-10-18",
        clientUpdatedAt,
        createdAt: now,
        updatedAt: now,
        seq: sql`(SELECT value FROM sync_seq WHERE id = 1)`,
      })
      .onConflictDoUpdate({
        target: workouts.id,
        set: {
          title: sql`excluded.title`,
          clientUpdatedAt: sql`excluded.client_updated_at`,
          seq: sql`(SELECT value FROM sync_seq WHERE id = 1)`,
        },
        setWhere: sql`excluded.client_updated_at > ${workouts.clientUpdatedAt}`,
      })
      .returning({ id: workouts.id, seq: workouts.seq, title: workouts.title });
  }

  const bumpSeq = () =>
    t.db
      .insert(syncSeq)
      .values({ id: 1, value: 1 })
      .onConflictDoUpdate({ target: syncSeq.id, set: { value: sql`${syncSeq.value} + 1` } });

  it("LWW UPSERT ... RETURNING returns the row only when the write wins", async () => {
    const u = await seedUser(t.db);
    const id = uuid7();
    const [, first] = await writeBatch(t.db, [bumpSeq(), upsertWorkout(u.userId, id, 1000, "v1")]);
    expect(first).toHaveLength(1);
    const [, stale] = await writeBatch(t.db, [bumpSeq(), upsertWorkout(u.userId, id, 999, "old")]);
    expect(stale).toEqual([]);
    const [, newer] = await writeBatch(t.db, [bumpSeq(), upsertWorkout(u.userId, id, 2000, "v2")]);
    expect(newer[0]?.title).toBe("v2");
    expect(newer[0]?.seq).toBeGreaterThan(first[0]?.seq ?? Number.POSITIVE_INFINITY);
  });

  it("n (seq bump, row) pairs in one batch give strictly increasing seqs", async () => {
    const u = await seedUser(t.db);
    const stmts = [];
    for (let i = 0; i < 5; i++) stmts.push(bumpSeq(), upsertWorkout(u.userId, uuid7(), 1, `w${i}`));
    t.reset();
    const res = await runBatch(t.db, stmts);
    expect(t.stats.roundTrips).toBe(1);
    const seqs = res.filter((_, i) => i % 2 === 1).map((r) => (r as { seq: number }[])[0]?.seq ?? 0);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i] ?? 0).toBeGreaterThan(seqs[i - 1] ?? 0);
  });

  it("an EXISTS predicate sees the effect of an earlier statement in the same batch", async () => {
    const u = await seedUser(t.db);
    const now = Date.now();
    await t.db.insert(userStats).values({
      userId: u.userId,
      computedAt: now,
      computedFor: "2026-10-18",
      seasonId: "2026-Q4",
      createdAt: now,
      updatedAt: now,
    });
    // The recompute pattern: claim rev 0 -> 1, then write only if the claim landed.
    const claim = (rev: number) =>
      t.db
        .update(userStats)
        .set({ rev: sql`${userStats.rev} + 1` })
        .where(and(eq(userStats.userId, u.userId), eq(userStats.rev, rev)))
        .returning({ rev: userStats.rev });
    const notifyIfClaimed = (rev: number, key: string) =>
      t.db.run(sql`INSERT INTO notifications (id, created_at, updated_at, user_id, kind, category, title, dedupe_key)
        SELECT ${uuid7()}, ${now}, ${now}, ${u.userId}, 'level', 'progress', 'Level up', ${key}
        WHERE EXISTS (SELECT 1 FROM user_stats WHERE user_id = ${u.userId} AND rev = ${rev + 1})`);

    const [won] = await writeBatch(t.db, [claim(0), notifyIfClaimed(0, "a")]);
    expect(won).toEqual([{ rev: 1 }]);
    const [lost] = await writeBatch(t.db, [claim(0), notifyIfClaimed(1, "b")]);
    expect(lost).toEqual([]);
    const rows = await t.db
      .select({ key: notifications.dedupeKey })
      .from(notifications)
      .where(eq(notifications.userId, u.userId));
    expect(rows).toEqual([{ key: "a" }]);
  });

  it("ON CONFLICT DO NOTHING RETURNING yields no row on a duplicate", async () => {
    const u = await seedUser(t.db);
    const now = Date.now();
    const insert = () =>
      t.db
        .insert(notifications)
        .values({
          userId: u.userId,
          kind: "k",
          category: "c",
          title: "t",
          dedupeKey: "d1",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toEqual([]);
  });
});

describe("withFold", () => {
  it("covers exactly the schema's fold columns", () => {
    const fromSchema: Record<string, Record<string, string>> = {};
    for (const value of Object.values(schema) as unknown[]) {
      if (!is(value, SQLiteTable)) continue;
      const columns = Object.keys(getTableColumns(value)).filter((k) => k.endsWith("Fold"));
      for (const fold of columns) {
        const src = fold.slice(0, -"Fold".length);
        fromSchema[getTableName(value)] = { ...fromSchema[getTableName(value)], [src]: fold };
      }
    }
    expect(fromSchema).toEqual(FOLD_COLUMNS);
  });

  it("computes folds for inserts and for the sources a patch contains", () => {
    expect(withFold(habits, { userId: "u", name: "Ünïcode", startedOn: "2026-10-18" })).toMatchObject({
      nameFold: "unicode",
    });
    expect(withFoldPatch(habits, { emoji: "x" })).toEqual({ emoji: "x" });
    expect(withFoldPatch(schema.profiles, { handle: "AbC", bio: null })).toEqual({
      handle: "AbC",
      handleFold: "abc",
      bio: null,
    });
    expect(withFoldPatch(schema.profiles, { displayName: null })).toEqual({
      displayName: null,
      displayNameFold: null,
    });
  });
});
