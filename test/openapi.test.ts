/**
 * openapi.json (written by `pnpm openapi`, scripts/openapi.ts) against the live router. The generator needs Node's
 * module hooks, so it cannot run in workerd; this holds the committed output to the routes this build mounts, and
 * CI regenerates the file and fails on any diff.
 */
import { describe, expect, it } from "vitest";
import spec from "../openapi.json";
import { checkSpec, mountedRoutes, toOpenApiPath } from "../scripts/openapi-check.ts";
import { createApp } from "../src/app.ts";
import { mountRoutes } from "../src/routes.ts";

const mounted = mountedRoutes(createApp(mountRoutes).routes);
type Op = { parameters?: { name: string; in: string }[]; tags?: string[]; security?: unknown[] };
const operations = Object.entries(spec.paths as Record<string, Record<string, Op>>).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe("openapi.json", () => {
  it("is a structurally sound OpenAPI 3.1 document of exactly the mounted routes", () => {
    expect(checkSpec(spec, mounted)).toEqual([]);
  });

  it("has one operation per mounted route", () => {
    expect(mounted.length).toBeGreaterThan(250);
    expect(operations.length).toBe(mounted.length);
    expect(new Set(mounted.map((r) => `${r.method} ${r.path}`)).size).toBe(mounted.length);
  });

  it("declares every path parameter", () => {
    for (const { path, method, op } of operations) {
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(declared.sort(), `${method} ${path}`).toEqual(templated.sort());
    }
  });

  it("tags every operation and says how it authenticates", () => {
    for (const { path, method, op } of operations) {
      expect(op.tags?.length, `${method} ${path}`).toBe(1);
      expect(Array.isArray(op.security), `${method} ${path}`).toBe(true);
    }
  });

  it("converts Hono paths", () => {
    expect(toOpenApiPath("/v1/habits/:id/stats")).toBe("/v1/habits/{id}/stats");
    expect(toOpenApiPath("/v1/x/:day{[0-9-]+}")).toBe("/v1/x/{day}");
  });
});
