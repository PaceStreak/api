/** Port of tests/test_push_ssrf.py, route half (the guard cases live in test/lib/push.test.ts). */
import { describe, expect, it } from "vitest";
import { signup } from "../fixtures/auth.ts";
import { api, jsonOf } from "../fixtures/http.ts";

describe("test_push_ssrf", () => {
  it("subscribe_refuses_an_internal_endpoint", async () => {
    const me = await signup();
    const r = await api("/v1/notifications/push/subscribe", {
      token: me.token,
      json: { endpoint: "https://169.254.169.254/x", keys: { p256dh: "a", auth: "b" } },
    });
    // Push is configured in tests, so this is the 422 (Python also allowed the 404 of an unconfigured server).
    expect(r.status).toBe(422);
    expect(await jsonOf(r)).toEqual({ detail: "Unusable push endpoint" });
  });
});
