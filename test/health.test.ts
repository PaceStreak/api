import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("health_returns_healthy", async () => {
  const res = await SELF.fetch("https://api.test/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "healthy" });
});
