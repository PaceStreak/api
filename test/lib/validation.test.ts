import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../../src/lib/errors.ts";
import { json, query } from "../../src/lib/validation.ts";
import golden from "./pydantic-422.json";

/** zod twins of the pydantic models in gen_pydantic_422.py, with the same inputs. */
const CASES: Record<keyof typeof golden, [z.ZodType, unknown]> = {
  missing: [z.object({ name: z.string() }), {}],
  string_too_short_1: [z.object({ name: z.string().min(1) }), { name: "" }],
  string_too_short_3: [z.object({ name: z.string().min(3) }), { name: "ab" }],
  string_too_long_1: [z.object({ name: z.string().max(1) }), { name: "ab" }],
  string_too_long_5: [z.object({ name: z.string().max(5) }), { name: "abcdefg" }],
  ge: [z.object({ n: z.int().min(1) }), { n: 0 }],
  gt: [z.object({ n: z.int().gt(0) }), { n: 0 }],
  le: [z.object({ n: z.int().max(10) }), { n: 11 }],
  lt: [z.object({ n: z.int().lt(10) }), { n: 10 }],
  int_from_float: [z.object({ n: z.int() }), { n: 1.5 }],
  int_parsing: [z.object({ n: z.int() }), { n: "abc" }],
  int_type: [z.object({ n: z.int() }), { n: null }],
  float_parsing: [z.object({ x: z.number() }), { x: "x" }],
  float_type: [z.object({ x: z.number() }), { x: null }],
  bool_parsing: [z.object({ b: z.boolean() }), { b: "maybe" }],
  bool_type: [z.object({ b: z.boolean() }), { b: null }],
  string_type: [z.object({ name: z.string() }), { name: 5 }],
  list_type: [z.object({ items: z.array(z.int()) }), { items: "x" }],
  list_item: [z.object({ items: z.array(z.int()) }), { items: ["a"] }],
  too_short: [z.object({ items: z.array(z.int()).min(1) }), { items: [] }],
  too_long: [z.object({ items: z.array(z.int()).max(2) }), { items: [1, 2, 3] }],
  literal_3: [z.object({ kind: z.enum(["a", "b", "c"]) }), { kind: "d" }],
  literal_2: [z.object({ kind: z.literal(["a", "b"]) }), { kind: "d" }],
  literal_num: [z.object({ n: z.literal([1, 2]) }), { n: 3 }],
  email_no_at: [z.object({ email: z.email() }), { email: "nope" }],
  email_no_local: [z.object({ email: z.email() }), { email: "@example.com" }],
  email_no_period: [z.object({ email: z.email() }), { email: "a@b" }],
  custom: [z.object({ name: z.string().refine(() => false, "bad thing") }), { name: "x" }],
  nested_missing: [z.object({ inner: z.object({ x: z.int() }) }), { inner: {} }],
  model_type: [z.object({ name: z.string() }), "x"],
  multiple_of: [z.object({ n: z.int().multipleOf(5) }), { n: 7 }],
  pattern: [z.object({ code: z.string().regex(/^\d+$/) }), { code: "a" }],
};

/**
 * FastAPI validates a body model with `from_attributes`, so a non-object body reports `model_attributes_type`
 * rather than the bare-pydantic `model_type` the generator sees.
 */
const FASTAPI_OVERRIDES: Partial<Record<keyof typeof golden, { type: string; msg: string }>> = {
  model_type: {
    type: "model_attributes_type",
    msg: "Input should be a valid dictionary or object to extract fields from",
  },
};

type Detail = { type: string; loc: (string | number)[]; msg: string; input: unknown };

async function post(schema: z.ZodType, body: string, headers: Record<string, string> = {}) {
  const app = new Hono();
  app.onError((err, c) => (err instanceof HttpError ? c.json(err.body, err.status) : c.text("boom", 500)));
  app.post("/x", json(schema), (c) => c.json({ ok: true, value: c.req.valid("json") }));
  return app.request("/x", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("422 hook matches pydantic (gate G-5)", () => {
  for (const [name, [schema, input]] of Object.entries(CASES)) {
    it(name, async () => {
      const res = await post(schema, JSON.stringify(input));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: Detail[] };
      const want = golden[name as keyof typeof golden];
      const override = FASTAPI_OVERRIDES[name as keyof typeof golden];
      expect(body.detail[0]).toMatchObject({
        type: override?.type ?? want.type,
        loc: want.loc,
        msg: override?.msg ?? want.msg,
      });
    });
  }

  it("the app's own parsing of detail[0] yields the field and message", async () => {
    const res = await post(z.object({ password: z.string().min(16) }), JSON.stringify({ password: "short" }));
    const body = (await res.json()) as { detail: Detail[] };
    const first = body.detail[0];
    // app/src/lib/api.ts: loc minus "body", msg minus "Value error, ".
    expect(first?.loc.filter((p) => p !== "body").join(" ")).toBe("password");
    expect(first?.msg.replace(/^Value error, /, "")).toBe("String should have at least 16 characters");
  });
});

describe("JSON body handling", () => {
  const schema = z.object({ a: z.int() });

  it("passes valid bodies through as parsed data", async () => {
    const res = await post(schema, '{"a": 1, "extra": true}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: { a: 1 } });
  });

  it("an empty body is a missing body", async () => {
    const res = await post(schema, "");
    expect(await res.json()).toEqual({
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  });

  it("malformed JSON is json_invalid", async () => {
    const res = await post(schema, "{nope");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Detail[] };
    expect(body.detail[0]).toMatchObject({ type: "json_invalid", msg: "JSON decode error" });
  });

  it("a missing Content-Type is still parsed as JSON, like FastAPI", async () => {
    const app = new Hono();
    app.post("/x", json(schema), (c) => c.json(c.req.valid("json")));
    // A byte body gets no implicit Content-Type (a string body would get text/plain).
    const res = await app.request("/x", { method: "POST", body: new TextEncoder().encode('{"a": 2}') });
    expect(await res.json()).toEqual({ a: 2 });
  });

  it("a non-JSON Content-Type is validated as a string and rejected", async () => {
    const res = await post(schema, '{"a": 1}', { "Content-Type": "text/plain" });
    const body = (await res.json()) as { detail: Detail[] };
    expect(body.detail[0]).toMatchObject({ type: "model_attributes_type", loc: ["body"] });
  });

  it("missing fields report the parent object as input", async () => {
    const res = await post(schema, "{}");
    const body = (await res.json()) as { detail: Detail[] };
    expect(body.detail[0]?.input).toEqual({});
  });
});

describe("query validation", () => {
  it("coerces and reports loc ['query', name]", async () => {
    const app = new Hono();
    app.onError((err, c) => (err instanceof HttpError ? c.json(err.body, err.status) : c.text("boom", 500)));
    app.get("/q", query(z.object({ limit: z.coerce.number().int().max(100) })), (c) =>
      c.json(c.req.valid("query")),
    );
    expect(await (await app.request("/q?limit=5")).json()).toEqual({ limit: 5 });
    const bad = (await (await app.request("/q?limit=500")).json()) as { detail: Detail[] };
    expect(bad.detail[0]).toMatchObject({ type: "less_than_equal", loc: ["query", "limit"] });
  });
});
