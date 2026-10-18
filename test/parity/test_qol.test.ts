/** Port of tests/test_qol.py (notification cases). */
import { describe, expect, it } from "vitest";
import { signup } from "../fixtures/auth.ts";
import { api, jsonOf } from "../fixtures/http.ts";

describe("test_qol", () => {
  it("preference_updates_merge_instead_of_resetting", async () => {
    const { token } = await signup();
    const put = (json: unknown) => api("/v1/notifications/preferences", { token, method: "PUT", json });
    await put({ channels: { digest: { email: false } } });
    const got = await jsonOf<{ categories: { id: string; email: boolean }[] }>(
      await put({ channels: { backup: { email: true } } }),
    );
    const cats = new Map(got.categories.map((c) => [c.id, c]));
    expect(cats.get("backup")?.email).toBe(true);
    expect(cats.get("digest")?.email).toBe(false); // untouched by the second update
    expect(cats.get("security")?.email).toBe(true); // locked
  });
});
