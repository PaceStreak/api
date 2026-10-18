/** Trash routes beyond the pytest ports: limits, expiry, Python bugs fixed, round trips. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { habits, trashItems } from "../src/db/schema/index.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import { testDb } from "./fixtures/db.ts";
import { person } from "./fixtures/game.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";
import type { Json } from "./fixtures/training.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const call = (token: string, path: string, method = "GET", json?: unknown) =>
  api(path, { token, method, ...(json === undefined ? {} : { json }) });
const body = async (res: Response) => jsonOf<Json>(res);

describe("trash", () => {
  it("changed: an expired entry cannot be restored before the sweep removes it", async () => {
    const { token } = await person();
    await call(token, `/v1/journal/${TODAY}`, "PUT", { mood: 3, note: "x" });
    const tid = (await body(await call(token, `/v1/journal/${TODAY}`, "DELETE"))).trash_id;
    await testDb()
      .db.update(trashItems)
      .set({ purgeAfter: Date.now() - 1 })
      .where(eq(trashItems.id, tid));
    expect(await body(await call(token, "/v1/trash"))).toEqual([]);
    const res = await call(token, `/v1/trash/${tid}/restore`, "POST");
    expect(res.status).toBe(404);
    expect((await body(await call(token, "/v1/journal")))[0]).toBeUndefined();
    // Emptying the trash still removes it (expired entries included, as in Python).
    const emptied = await call(token, "/v1/trash", "DELETE");
    expect(emptied.status).toBe(204);
    expectRoundTrips(emptied, 1);
    expect(await testDb().db.select().from(trashItems).where(eq(trashItems.id, tid))).toEqual([]);
  });

  it("changed: a meal whose food is gone for good restores without the link", async () => {
    const { token } = await person();
    const food = await body(await call(token, "/v1/nutrition/foods", "POST", { name: "Rice", kcal: 200 }));
    const eid = crypto.randomUUID();
    await call(token, `/v1/nutrition/entries/${eid}`, "PUT", {
      date: TODAY,
      meal: "lunch",
      food_id: food.id,
    });
    const mealTid = (await body(await call(token, `/v1/nutrition/entries/${eid}`, "DELETE"))).trash_id;
    const foodTid = (await body(await call(token, `/v1/nutrition/foods/${food.id}`, "DELETE"))).trash_id;
    expect((await call(token, `/v1/trash/${foodTid}`, "DELETE")).status).toBe(204);
    const res = await call(token, `/v1/trash/${mealTid}/restore`, "POST");
    expect(res.status).toBe(200);
    const entries = (await body(await call(token, `/v1/nutrition/days/${TODAY}`))).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].food_id).toBeNull();
    expect(entries[0].kcal).toBe(200);
  });

  it("a habit restore respects the live-habit limit", async () => {
    const me = await person();
    const h = await body(await call(me.token, "/v1/habits", "POST", { name: "Stretch" }));
    const tid = (await body(await call(me.token, `/v1/habits/${h.id}`, "DELETE"))).trash_id;
    const now = Date.now();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: uuid7(now),
      userId: me.userId,
      name: `H${i}`,
      nameFold: `h${i}`,
      startedOn: TODAY,
      createdAt: now,
      updatedAt: now,
    }));
    // D1 binds at most 100 parameters per statement.
    for (let i = 0; i < rows.length; i += 5)
      await testDb()
        .db.insert(habits)
        .values(rows.slice(i, i + 5));
    const res = await call(me.token, `/v1/trash/${tid}/restore`, "POST");
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ detail: "30 habits at once is the limit. Archive one first." });
    expect(await body(await call(me.token, "/v1/trash"))).toHaveLength(1);
  });

  it("a second restore of the same entry is a 404, and ids are validated", async () => {
    const { token } = await person();
    await call(token, `/v1/journal/${TODAY}`, "PUT", { mood: 1, note: "y" });
    const tid = (await body(await call(token, `/v1/journal/${TODAY}`, "DELETE"))).trash_id;
    expect((await call(token, `/v1/trash/${tid}/restore`, "POST")).status).toBe(200);
    expect((await call(token, `/v1/trash/${tid}/restore`, "POST")).status).toBe(404);
    expect((await call(token, `/v1/trash/${tid}`, "DELETE")).status).toBe(404);
    expect((await call(token, "/v1/trash/nope/restore", "POST")).status).toBe(422);
    const other = await person();
    await call(token, `/v1/journal/${TODAY}`, "PUT", { mood: 1, note: "z" });
    const mine = (await body(await call(token, `/v1/journal/${TODAY}`, "DELETE"))).trash_id;
    expect((await call(other.token, `/v1/trash/${mine}`, "DELETE")).status).toBe(404);
    expect((await call(other.token, "/v1/trash", "DELETE")).status).toBe(204);
    expect(await body(await call(token, "/v1/trash"))).toHaveLength(1);
  });

  it("a habit restore brings its streak back in the same request", async () => {
    const { token } = await person();
    const h = await body(await call(token, "/v1/habits", "POST", { name: "Walk" }));
    await call(token, `/v1/habits/${h.id}/days/${TODAY}`, "PUT", { amount: 1 });
    const before = await body(await call(token, "/v1/me/stats"));
    const tid = (await body(await call(token, `/v1/habits/${h.id}`, "DELETE"))).trash_id;
    expect((await call(token, `/v1/trash/${tid}/restore`, "POST")).status).toBe(200);
    expect(await body(await call(token, "/v1/me/stats"))).toEqual(before);
    const listed = await body(await call(token, "/v1/habits"));
    expect(listed.map((x: Json) => x.id)).toEqual([h.id]);
  });
});
