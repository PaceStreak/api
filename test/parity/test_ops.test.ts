/** Port of tests/test_ops.py (notification cases; OPS-ADMIN adds the rest). */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listHeaders } from "../../src/modules/notifications/service.ts";
import { signup } from "../fixtures/auth.ts";
import { BASE } from "../fixtures/http.ts";
import { jobCtx } from "../jobs/helpers.ts";

/** A mail client's RFC 8058 POST: a form body, no session, no CSRF header. */
const oneClick = (path: string) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

describe("test_ops", () => {
  it("one_click_unsubscribe", async () => {
    const me = await signup();
    const headers = await listHeaders(jobCtx(), me.userId, "digest");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const first = (headers["List-Unsubscribe"] ?? "").split(">")[0]?.replace(/^</, "") ?? "";
    const url = new URL(first);
    const path = `${url.pathname}${url.search}`;
    const ok = await oneClick(path);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const forged = await oneClick(path.replace("s=", "s=0"));
    expect(forged.status).toBe(400);
  });
});
