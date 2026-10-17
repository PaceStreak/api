/** Port of tests/test_passkeys.py: real WebAuthn ceremonies with the soft authenticator, nothing mocked. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { totpAt } from "../../src/lib/crypto/totp.ts";
import { Client, PASSWORD, signup } from "../fixtures/auth.ts";
import { jsonOf } from "../fixtures/http.ts";
import { SoftAuthenticator } from "../soft-webauthn.ts";

// vitest.config.ts: FRONTEND_URL is http://localhost:5173.
const device = (origin = "http://localhost:5173") => new SoftAuthenticator(origin, "localhost");

interface Ceremony {
  challenge_id: string;
  options: { challenge: string; user: { id: string }; excludeCredentials?: { id: string }[] };
}

async function enrol(client: Client, token: string, d: SoftAuthenticator, name?: string) {
  const start = await client.call("/v1/auth/passkeys/register/options", {
    json: { password: PASSWORD },
    token,
  });
  expect(start.status).toBe(200);
  const body = await jsonOf<Ceremony>(start);
  const finish = await client.call("/v1/auth/passkeys/register", {
    json: { challenge_id: body.challenge_id, credential: await d.register(body.options), name },
    token,
  });
  expect(finish.status, await finish.clone().text()).toBe(201);
  return jsonOf<{ id: string; name: string }>(finish);
}

async function signIn(d: SoftAuthenticator) {
  const client = new Client();
  const options = await jsonOf<Ceremony>(
    await client.call("/v1/auth/passkeys/sign-in/options", { method: "POST" }),
  );
  return client.call("/v1/auth/passkeys/sign-in", {
    json: { challenge_id: options.challenge_id, credential: await d.authenticate(options.options) },
  });
}

describe("test_passkeys", () => {
  it("register_and_sign_in_with_a_passkey", async () => {
    const { client, token, email, userId } = await signup();
    const d = device();
    const created = await enrol(client, token, d, "Work laptop");
    expect(created.name).toBe("Work laptop");
    const listed = await jsonOf<{ id: string }[]>(await client.call("/v1/auth/passkeys", { token }));
    expect(listed.map((p) => p.id)).toEqual([created.id]);
    const res = await signIn(d);
    expect(res.status, await res.clone().text()).toBe(200);
    const access = (await jsonOf<{ access_token: string }>(res)).access_token;
    const me = await jsonOf<{ email: string }>(await client.call("/v1/auth/me", { token: access }));
    expect(me.email).toBe(email);
    // /v1/me/security-events belongs to the account module; read the rows directly.
    const kinds = await env.DB.prepare("SELECT kind FROM security_events WHERE user_id = ?")
      .bind(userId)
      .all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toContain("passkey_added");
  });

  it("registration_requires_the_password", async () => {
    const { client, token } = await signup();
    const res = await client.call("/v1/auth/passkeys/register/options", {
      json: { password: "not-the-password!!" },
      token,
    });
    expect(res.status).toBe(401);
  });

  it("a_challenge_is_single_use", async () => {
    const { client, token } = await signup();
    const d = device();
    await enrol(client, token, d);
    const anon = new Client();
    const options = await jsonOf<Ceremony>(
      await anon.call("/v1/auth/passkeys/sign-in/options", { method: "POST" }),
    );
    const payload = { challenge_id: options.challenge_id, credential: await d.authenticate(options.options) };
    expect((await anon.call("/v1/auth/passkeys/sign-in", { json: payload })).status).toBe(200);
    expect((await anon.call("/v1/auth/passkeys/sign-in", { json: payload })).status).toBe(400);
  });

  it("wrong_origin_is_refused", async () => {
    const { client, token } = await signup();
    const d = device();
    await enrol(client, token, d);
    // Same key and credential, but the browser says the page was somewhere else.
    Object.defineProperty(d, "origin", { value: "https://pacestreak.example" });
    expect((await signIn(d)).status).toBe(401);
  });

  it("user_verification_is_required", async () => {
    const { client, token } = await signup();
    const d = device();
    await enrol(client, token, d);
    const anon = new Client();
    const options = await jsonOf<Ceremony>(
      await anon.call("/v1/auth/passkeys/sign-in/options", { method: "POST" }),
    );
    const assertion = await d.authenticate(options.options);
    // Clear the UV flag (byte 32 of authenticatorData): the signature no longer matches either way.
    const raw = Uint8Array.from(
      atob(assertion.response.authenticatorData.replace(/-/g, "+").replace(/_/g, "/")),
      (ch) => ch.charCodeAt(0),
    );
    raw[32] = 0x01;
    assertion.response.authenticatorData = btoa(String.fromCharCode(...raw))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await anon.call("/v1/auth/passkeys/sign-in", {
      json: { challenge_id: options.challenge_id, credential: assertion },
    });
    expect(res.status).toBe(401);
  });

  it("unknown_credential_is_refused", async () => {
    const d = device();
    // Register locally only, so it has a key but the server has never seen it.
    await d.register({ challenge: "AAAA", user: { id: "AAAA" } });
    const res = await signIn(d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "That passkey didn't work. Try again or use your password." });
  });

  it("a_passkey_satisfies_two_factor", async () => {
    const { client, token } = await signup();
    const setup = await jsonOf<{ secret: string }>(
      await client.call("/v1/auth/2fa/setup", { method: "POST", token }),
    );
    const code = await totpAt(setup.secret, Date.now());
    expect(
      (await client.call("/v1/auth/2fa/enable", { json: { password: PASSWORD, code }, token })).status,
    ).toBe(200);
    const d = device();
    await enrol(client, token, d);
    const res = await signIn(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("access_token");
  });

  it("removing_requires_the_password_and_stops_sign_in", async () => {
    const { client, token } = await signup();
    const d = device();
    const created = await enrol(client, token, d);
    const path = `/v1/auth/passkeys/${created.id}/remove`;
    expect((await client.call(path, { json: { password: "not-the-password!!" }, token })).status).toBe(401);
    expect((await client.call(path, { json: { password: PASSWORD }, token })).status).toBe(204);
    expect((await signIn(d)).status).toBe(401);
  });

  it("someone_elses_passkey_is_invisible", async () => {
    const a = await signup();
    const b = await signup();
    const created = await enrol(a.client, a.token, device());
    const res = await b.client.call(`/v1/auth/passkeys/${created.id}`, {
      method: "PATCH",
      json: { name: "mine now" },
      token: b.token,
    });
    expect(res.status).toBe(404);
    const renamed = await a.client.call(`/v1/auth/passkeys/${created.id}`, {
      method: "PATCH",
      json: { name: "  Phone  " },
      token: a.token,
    });
    expect((await jsonOf<{ name: string }>(renamed)).name).toBe("Phone");
  });

  it("same_authenticator_cannot_register_twice", async () => {
    const { client, token } = await signup();
    const d = device();
    await enrol(client, token, d);
    const start = await jsonOf<Ceremony>(
      await client.call("/v1/auth/passkeys/register/options", { json: { password: PASSWORD }, token }),
    );
    expect(start.options.excludeCredentials?.[0]?.id).toBe(d.id);
    const again = await client.call("/v1/auth/passkeys/register", {
      json: { challenge_id: start.challenge_id, credential: await d.register(start.options) },
      token,
    });
    expect(again.status).toBe(409);
  });
});
