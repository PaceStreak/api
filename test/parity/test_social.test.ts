/** Port of tests/test_social.py (notification cases; SOCIAL adds the rest). */
import { describe, expect, it } from "vitest";
import { signUnsubscribe } from "../../src/modules/notifications/service.ts";
import { signup } from "../fixtures/auth.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { jobCtx } from "../jobs/helpers.ts";

interface Prefs {
  categories: { id: string; locked: boolean; email: boolean }[];
}

describe("test_social", () => {
  it("notification_preferences_and_unsubscribe", async () => {
    const { token } = await signup();
    let prefs = await jsonOf<Prefs>(await api("/v1/notifications/preferences", { token }));
    const security = prefs.categories.find((c) => c.id === "security");
    expect(security?.locked && security.email).toBe(true);
    await api("/v1/notifications/preferences", {
      token,
      method: "PUT",
      json: { channels: { digest: { email: false }, security: { email: false } } },
    });
    prefs = await jsonOf<Prefs>(await api("/v1/notifications/preferences", { token }));
    const byId = new Map(prefs.categories.map((c) => [c.id, c]));
    expect(byId.get("digest")?.email).toBe(false);
    expect(byId.get("security")?.email).toBe(true); // cannot be switched off

    // Python read the id from /v1/me (PROFILE-ACCOUNT); /v1/auth/me carries it too.
    const uid = (await jsonOf<{ id: string }>(await api("/v1/auth/me", { token }))).id;
    const bad = await api("/v1/notifications/unsubscribe", { json: { u: uid, c: "social", s: "nope" } });
    expect(bad.status).toBe(400);
    const good = await api("/v1/notifications/unsubscribe", {
      json: { u: uid, c: "social", s: await signUnsubscribe(jobCtx(), uid, "social") },
    });
    expect(good.status).toBe(200);
  });
});
