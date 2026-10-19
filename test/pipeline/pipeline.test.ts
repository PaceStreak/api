import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type App, createApp } from "../../src/app.ts";
import { users } from "../../src/db/schema/index.ts";
import { HttpError, SAVED_TWICE, SERVER_ERROR } from "../../src/lib/errors.ts";
import { json } from "../../src/lib/validation.ts";

const ORIGIN = "https://app.pacestreak.com";

function testApp(): App {
  return createApp((app) => {
    app.get("/health", (c) => c.json({ status: "healthy" }));
    app.get("/v1/ok", (c) => c.json({ ok: true, rid: c.var.ctx.rid }));
    app.put("/v1/ok", (c) => c.json({ ok: "put" }));
    app.post("/v1/items", json(z.object({ name: z.string().min(1) })), (c) =>
      c.json(c.req.valid("json"), 201),
    );
    app.get("/v1/teapot", () => {
      throw new HttpError(400, "No tea today", { "X-Extra": "1" });
    });
    app.get("/v1/boom", () => {
      throw new Error("kaboom");
    });
    // test_server_errors.py's /v1/_race: a constraint violation becomes 409.
    app.post("/v1/_race", async (c) => {
      const { db } = c.var.ctx;
      const row = { email: `race-${crypto.randomUUID()}@example.com`, hashedPassword: "x" };
      await db.insert(users).values(row);
      await db.insert(users).values(row);
      return c.json({ ok: true });
    });
  });
}

async function call(app: App, path: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(`https://api.test${path}`, init, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const app = testApp();

describe("error envelopes", () => {
  it("unknown path is 404 Not Found", async () => {
    const res = await call(app, "/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });

  it("wrong method is 405 with Allow", async () => {
    const res = await call(app, "/v1/ok", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ detail: "Method Not Allowed" });
    expect(res.headers.get("Allow")).toBe("GET, HEAD, PUT");
  });

  it("HttpError renders {detail} with its status and headers", async () => {
    const res = await call(app, "/v1/teapot");
    expect([res.status, await res.json(), res.headers.get("X-Extra")]).toEqual([
      400,
      { detail: "No tea today" },
      "1",
    ]);
  });

  it("a constraint violation is 409 (test_a_lost_unique_race_is_a_409)", async () => {
    const res = await call(app, "/v1/_race", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: SAVED_TWICE });
  });

  it("an unhandled error is 500 and still carries CORS headers (test_a_500_still_carries_cors_headers)", async () => {
    const res = await call(app, "/v1/boom", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: SERVER_ERROR });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("PaceStreak-Version")).toBe("1");
  });

  it("validation failures are 422 with the version header", async () => {
    const res = await call(app, "/v1/items", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("PaceStreak-Version")).toBe("1");
  });

  it("bodies over 1 MiB are 413", async () => {
    const big = JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) });
    const res = await call(app, "/v1/items", {
      method: "POST",
      body: big,
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
  });
});

describe("version header", () => {
  it("is on /v1 responses and not on health", async () => {
    expect((await call(app, "/v1/ok")).headers.get("PaceStreak-Version")).toBe("1");
    expect((await call(app, "/v1/nope")).headers.get("PaceStreak-Version")).toBe("1");
    expect((await call(app, "/health")).headers.get("PaceStreak-Version")).toBeNull();
  });

  it("every response carries X-Request-Id, from cf-ray when present", async () => {
    const res = await call(app, "/v1/ok", { headers: { "cf-ray": "abc123-SIN" } });
    expect(res.headers.get("X-Request-Id")).toBe("abc123-SIN");
    expect(((await res.json()) as { rid: string }).rid).toBe("abc123-SIN");
  });
});

describe("CORS (Starlette semantics)", () => {
  const preflight = (origin: string) =>
    call(app, "/v1/items", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
      },
    });

  it("answers an allowed preflight with 200 OK and echoes origin and headers", async () => {
    const res = await preflight(ORIGIN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
      "access-control-allow-headers": "content-type,x-csrf-token",
      "access-control-max-age": "600",
      vary: "Origin",
      "pacestreak-version": "1",
    });
  });

  it("refuses a disallowed preflight with 400", async () => {
    const res = await preflight("https://evil.example");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Disallowed CORS origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("adds CORS headers to allowed simple requests only", async () => {
    const ok = await call(app, "/v1/ok", { headers: { Origin: ORIGIN } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(ok.headers.get("Vary")).toBe("Origin");
    expect(ok.headers.get("Access-Control-Expose-Headers")).toBe("Content-Disposition");
    const evil = await call(app, "/v1/ok", { headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(200);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(evil.headers.get("Access-Control-Expose-Headers")).toBeNull();
    const none = await call(app, "/v1/ok");
    expect(none.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("config gate", () => {
  it("a production misconfiguration answers every request with 500", async () => {
    const prod = { ...env, ENVIRONMENT: "production", COOKIE_DOMAIN: "", TURNSTILE_SECRET_KEY: "" } as Env;
    const res = await call(app, "/v1/ok", { headers: { Origin: ORIGIN } }, prod);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: SERVER_ERROR });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("PaceStreak-Version")).toBe("1");
  });
});
