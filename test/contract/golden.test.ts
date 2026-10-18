/**
 * App contract, part 2 (DESIGN.md §15): golden structural responses for the endpoints the app leans on most.
 *
 * Each response is compared by shape (keys and JSON types, test/contract/shape.ts) with test/contract/golden.json,
 * and parsed by the zod schema in test/contract/schemas.ts that is type-checked against the app's own types
 * (test/contract/app-types.ts, vendored from PaceStreak/app). A golden that is missing fails with the shape to
 * add; a changed shape is a contract change and goes in docs/rewrite/CHANGES-FROM-PYTHON.md with the app edit.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api, jsonOf } from "../fixtures/http.ts";
import { type Endpoint, endpoints } from "./endpoints.ts";
import golden from "./golden.json";
import { type Seeded, seedContract } from "./seed.ts";
import { diff, type Shape, shapeOf } from "./shape.ts";

const GOLDEN = golden as Record<string, Shape>;

describe("app contract: golden responses", () => {
  let s: Seeded;
  beforeAll(async () => {
    s = await seedContract();
  }, 60_000);

  it("covers about forty endpoints, each with a schema checked against the app's types", () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(40);
    expect(new Set(endpoints.map((e) => e.name)).size).toBe(endpoints.length);
    expect(Object.keys(GOLDEN).sort()).toEqual(endpoints.map((e) => e.name).sort());
  });

  it.each(endpoints.map((e) => [e.name, e] as [string, Endpoint]))("%s", async (name, e) => {
    const req = e.request(s);
    const res = await api(req.path, {
      ...(req.method === undefined ? {} : { method: req.method }),
      token: req.as === "other" ? s.other : s.token,
      ...(req.json === undefined ? {} : { json: req.json }),
    });
    expect(res.status, await res.clone().text()).toBe(req.status ?? 200);
    const body = await jsonOf(res);
    const parsed = e.schema.safeParse(body);
    expect(parsed.success ? [] : parsed.error.issues, `${name}: does not satisfy the app's type`).toEqual([]);
    const got = shapeOf(body);
    const want = GOLDEN[name];
    if (want === undefined) console.log(`GOLDEN-MISSING ${JSON.stringify({ [name]: got })}`);
    expect(want, `${name}: no golden shape`).toBeDefined();
    expect(diff(want as Shape, got)).toEqual([]);
  });
});
