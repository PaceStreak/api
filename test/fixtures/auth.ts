/**
 * Auth fixtures, ported from conftest.py.
 *
 * - `authed()`: a seeded user + live session + `AuthedBatch`, for service-level tests (no HTTP).
 * - `Client`: a cookie jar over `api()`, like the pytest TestClient.
 * - `signup()` / `login()`: the real HTTP flow (sign up, read the code from the console mailer, verify, sign in).
 * - `otpCode()`: the newest six-digit code mailed to an address, read from the console transport's output, the
 *   way conftest.py read it from the log. The Worker runs in the test isolate, so its console is ours.
 */
import { expect } from "vitest";
import type { AuthedBatch } from "../../src/db/batch.ts";
import {
  authedBatch,
  type SeededUser,
  type SeedUserOptions,
  seedUser,
  type TestDb,
  testDb,
  uniqueEmail,
} from "./db.ts";
import { api, type CallOptions, jsonOf, randomIp } from "./http.ts";

export interface Authed {
  user: SeededUser;
  batch: AuthedBatch;
  t: TestDb;
}

export async function authed(opts: SeedUserOptions = {}): Promise<Authed> {
  const t = testDb();
  const user = await seedUser(t.db, opts);
  t.reset();
  return { user, batch: authedBatch(t.db, user), t };
}

export const PASSWORD = "correct-horse-battery-staple";

// ---- mailbox ------------------------------------------------------------------------------------------------

export const sent: string[] = [];
const MARK = "[email:console]";
const original = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith(MARK)) sent.push(args[0]);
  else original(...args);
};

const SUBJECTS = {
  "verify-email": "subject=Confirm your PaceStreak email",
  "reset-password": "subject=Reset your",
  "confirm-email": "subject=Confirm your new",
  "sign-in": "subject=Your PaceStreak sign-in code",
} as const;

/** The newest code of `kind` mailed to `to` (conftest `otp_code`). */
export function otpCode(kind: keyof typeof SUBJECTS, to: string): string | null {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i] ?? "";
    if (!m.startsWith(`${MARK} to=${to} `) || !m.includes(SUBJECTS[kind])) continue;
    const code = /code is: (\d{6})/.exec(m);
    if (code) return code[1] ?? null;
  }
  return null;
}

// ---- client -------------------------------------------------------------------------------------------------

/** A browser-ish client: keeps cookies set by the API and sends them back, from one IP. */
export class Client {
  readonly cookies = new Map<string, string>();
  readonly ip = randomIp();

  async call(path: string, opts: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { "CF-Connecting-IP": this.ip, ...opts.headers };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await api(path, { ...opts, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split("; ");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (attrs.includes("Max-Age=0") || value === '""') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  csrf(): Record<string, string> {
    const token = this.cookies.get("csrf_token");
    expect(token, "no csrf_token cookie - log in first").toBeTruthy();
    return { "X-CSRF-Token": token ?? "" };
  }
}

export interface SignedIn {
  token: string;
  userId: string;
  email: string;
  password: string;
  client: Client;
}

/** conftest `register`: sign up and confirm the address. */
export async function register(client: Client, email = uniqueEmail(), password = PASSWORD): Promise<string> {
  const res = await client.call("/v1/auth/signup", { json: { email, password } });
  expect(res.status, await res.clone().text()).toBe(201);
  const code = otpCode("verify-email", email);
  const v = await client.call("/v1/auth/verify-email", { json: { email, code } });
  expect(v.status).toBe(200);
  return email;
}

export interface Challenge {
  mfa_required: true;
  mfa_token: string;
  expires_in: number;
  method: "totp" | "email";
  resend_in?: number;
}

/**
 * POST /v1/auth/login, returning the access token; cookies land on the client. Email codes at sign-in are on by
 * default, so an untrusted client is asked for one: it is read from the mailbox and sent, the way a person would,
 * without trusting the device (`trust` true remembers it).
 */
export async function loginToken(
  client: Client,
  email: string,
  password = PASSWORD,
  trust = false,
): Promise<string> {
  const res = await loginResponse(client, email, password, trust);
  return (await jsonOf<{ access_token: string }>(res)).access_token;
}

/** The response that finally carried the tokens: the login itself, or the email-code step after it. */
export async function loginResponse(
  client: Client,
  email: string,
  password = PASSWORD,
  trust = false,
): Promise<Response> {
  const res = await client.call("/v1/auth/login", { json: { email, password } });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await jsonOf<{ access_token: string } | Challenge>(res.clone());
  if (!("mfa_required" in body)) return res;
  expect(body.method, "a TOTP account needs its own login helper").toBe("email");
  const code = otpCode("sign-in", email);
  expect(code, "no sign-in code was mailed").toBeTruthy();
  const v = await client.call("/v1/auth/2fa/verify", {
    json: { mfa_token: body.mfa_token, code, trust_device: trust },
  });
  expect(v.status, await v.clone().text()).toBe(200);
  return v;
}

async function signedIn(client: Client, email: string, password: string): Promise<SignedIn> {
  const token = await loginToken(client, email, password);
  const me = await jsonOf<{ id: string }>(await client.call("/v1/auth/me", { token }));
  return { token, userId: me.id, email, password, client };
}

/** Sign up, verify and sign in over HTTP. */
export async function signup(email = uniqueEmail(), password = PASSWORD): Promise<SignedIn> {
  const client = new Client();
  await register(client, email, password);
  return signedIn(client, email, password);
}

/** Sign in an existing account over HTTP with a fresh client. */
export async function login(email: string, password = PASSWORD): Promise<SignedIn> {
  return signedIn(new Client(), email, password);
}
