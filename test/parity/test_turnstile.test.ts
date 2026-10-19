/**
 * Port of tests/test_turnstile.py at the library level: siteverify is mocked, as in Python. The signup/login/
 * resend-verification routes belong to the AUTH unit, which wires `verifyTurnstile` in front of them; these tests
 * pin our side of the contract (missing token, rejected token, Cloudflare unreachable, owner exemption).
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/lib/errors.ts";
import {
  NEED_TOKEN,
  SITEVERIFY_URL,
  turnstileExempt,
  VERIFY_FAILED,
  VERIFY_UNAVAILABLE,
  verifyTurnstile,
} from "../../src/lib/turnstile.ts";
import { mockFetch, mockJson } from "../fixtures/fetch.ts";

const SECRET = "test-secret";

async function outcome(p: Promise<void>): Promise<{ status: number; detail: unknown }> {
  try {
    await p;
    return { status: 200, detail: null };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, detail: (e.body as { detail: unknown }).detail };
    throw e;
  }
}

/** The guard as resend-verification applies it: skipped for the signed-in owner of the address. */
function resendGuard(callerEmail: string | null, email: string, token?: string) {
  if (turnstileExempt(callerEmail, email)) return Promise.resolve();
  return verifyTurnstile({ secret: SECRET, token, remoteIp: "1.2.3.4" });
}

describe("test_turnstile", () => {
  it("off_by_default", async () => {
    // No mock registered: any outbound fetch would throw.
    expect(await outcome(verifyTurnstile({ secret: null, token: undefined, remoteIp: null }))).toEqual({
      status: 200,
      detail: null,
    });
  });

  it("signup_requires_a_token_once_enabled", async () => {
    mockJson(SITEVERIFY_URL, { success: true });
    const r = await outcome(verifyTurnstile({ secret: SECRET, token: undefined, remoteIp: null }));
    expect(r).toEqual({ status: 400, detail: NEED_TOKEN });
  });

  it("signup_accepts_a_token_cloudflare_approves", async () => {
    const m = mockJson(SITEVERIFY_URL, { success: true });
    expect(
      (await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: "9.9.9.9" }))).status,
    ).toBe(200);
    const req = m.calls[0];
    expect(req?.method).toBe("POST");
    const form = new URLSearchParams(await req?.text());
    expect([form.get("secret"), form.get("response"), form.get("remoteip")]).toEqual([
      SECRET,
      "tok",
      "9.9.9.9",
    ]);
  });

  it("signup_rejects_a_token_cloudflare_declines", async () => {
    mockJson(SITEVERIFY_URL, { success: false, "error-codes": ["invalid-input-response"] });
    const r = await outcome(verifyTurnstile({ secret: SECRET, token: "bad", remoteIp: null }));
    expect(r).toEqual({ status: 400, detail: VERIFY_FAILED });
  });

  it("login_needs_a_token_too", async () => {
    mockJson(SITEVERIFY_URL, { success: true });
    expect((await outcome(verifyTurnstile({ secret: SECRET, token: "", remoteIp: null }))).status).toBe(400);
  });

  it("cloudflare_unreachable_fails_closed", async () => {
    mockFetch(SITEVERIFY_URL, () => {
      throw new TypeError("boom");
    });
    const r = await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: null }));
    expect(r).toEqual({ status: 503, detail: VERIFY_UNAVAILABLE });
  });

  it("cloudflare non-JSON answer fails closed (test_cloudflare_unreachable_fails_closed)", async () => {
    mockFetch(SITEVERIFY_URL, () => new Response("<html>", { status: 502 }));
    expect((await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: null }))).status).toBe(
      503,
    );
  });

  it("one dropped siteverify call is retried, a second fails closed", async () => {
    let calls = 0;
    mockFetch(SITEVERIFY_URL, () => {
      calls++;
      if (calls === 1) throw new TypeError("connection reset");
      return Response.json({ success: true });
    });
    expect((await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: null }))).status).toBe(
      200,
    );
    expect(calls).toBe(2);
    calls = 0;
    mockFetch(SITEVERIFY_URL, () => {
      calls++;
      throw new TypeError("down");
    });
    expect((await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: null }))).status).toBe(
      503,
    );
    expect(calls).toBe(2);
  });

  it("a definite rejection is not retried", async () => {
    let calls = 0;
    mockFetch(SITEVERIFY_URL, () => {
      calls++;
      return Response.json({ success: false });
    });
    expect((await outcome(verifyTurnstile({ secret: SECRET, token: "tok", remoteIp: null }))).status).toBe(
      400,
    );
    expect(calls).toBe(1);
  });

  it("resend_verification_needs_a_token_when_anonymous", async () => {
    mockJson(SITEVERIFY_URL, { success: true });
    expect((await outcome(resendGuard(null, "someone@example.com"))).status).toBe(400);
  });

  it("resend_verification_skips_the_token_for_the_signed_in_owner", async () => {
    mockJson(SITEVERIFY_URL, { success: true });
    const email = "resend-owner@example.com";
    expect((await outcome(resendGuard(email, " Resend-Owner@example.com "))).status).toBe(200);
  });

  it("resend_verification_cannot_be_used_to_spam_someone_elses_address", async () => {
    mockJson(SITEVERIFY_URL, { success: true });
    expect((await outcome(resendGuard("resend-owner-2@example.com", "victim@example.com"))).status).toBe(400);
  });
});
