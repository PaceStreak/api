/**
 * App contract, part 1 (DESIGN.md §15): every API call the app makes (test/contract/app-routes.json, extracted from
 * PaceStreak/app by scripts/extract-app-routes.ts) resolves to a mounted Hono route with the same method.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { mountRoutes } from "../../src/routes.ts";
import appRoutes from "./app-routes.json";

interface Mounted {
  method: string;
  path: string;
  re: RegExp;
}

/** Hono path syntax to a regex: `:name` and `:name{re}` take one segment, a trailing `*` takes the rest. */
function compile(path: string): RegExp {
  const parts = path.split("/").map((seg) => {
    if (seg === "*") return ".*";
    const m = /^:\w+(?:\{(.+)\})?(\?)?$/.exec(seg);
    if (m) return m[1] ? `(?:${m[1]})` : "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("/")}/?$`);
}

function mounted(): Mounted[] {
  const app = createApp(mountRoutes);
  return app.routes
    .filter((r) => !(r.method === "ALL" && r.path.endsWith("*"))) // middleware
    .map((r) => ({ method: r.method, path: r.path, re: compile(r.path) }));
}

/** A concrete path for an extracted one: each `:param` becomes a plausible segment value. */
const concrete = (path: string) => path.replace(/:param/g, "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");

function resolve(routes: readonly Mounted[], method: string, path: string): Mounted | undefined {
  const sample = concrete(path);
  return routes.find(
    (r) => (r.method === method || r.method === "ALL") && (r.re.test(path) || r.re.test(sample)),
  );
}

describe("app contract: routes", () => {
  const routes = mounted();
  const calls = Object.entries(appRoutes as Record<string, string[]>);

  it("the extracted table is not empty", () => {
    expect(calls.length).toBeGreaterThan(200);
  });

  it("every app api() call site resolves to a mounted route (method + path)", () => {
    const missing = calls
      .map(([key, where]) => {
        const [method = "", path = ""] = key.split(" ");
        return resolve(routes, method, path) ? null : `${key}  (${where.join(", ")})`;
      })
      .filter((m) => m !== null);
    expect(missing).toEqual([]);
  });

  it("the resolver refuses a wrong method or an unknown path", () => {
    expect(resolve(routes, "GET", "/v1/habits")).toBeDefined();
    expect(resolve(routes, "PATCH", "/v1/feed")).toBeUndefined();
    expect(resolve(routes, "GET", "/v1/no-such-thing")).toBeUndefined();
  });
});
