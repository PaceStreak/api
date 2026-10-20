/**
 * Profile/account fixtures: conftest `person()` through the real onboarding route, and multipart uploads for
 * `POST /v1/me/import`.
 */
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { type SignedIn, signup } from "./auth.ts";
import { uniqueEmail } from "./db.ts";
import { api, BASE, jsonOf, randomIp, recordStatements } from "./http.ts";

let n = 0;
export const uniqueHandle = (prefix = "p") => `${prefix}${Date.now().toString(36)}${n++}`.slice(0, 30);

/** conftest `onboard`: an adult with a public profile unless `extra` says otherwise. */
export async function onboard(token: string, handle: string, extra: Record<string, unknown> = {}) {
  const res = await api("/v1/me/onboarding", {
    token,
    json: { handle, birth_year: 1990, accept_terms: true, visibility: "public", ...extra },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return jsonOf<{ profile: Record<string, unknown> }>(res);
}

export interface Onboarded extends SignedIn {
  handle: string;
}

/** conftest `person`: sign up, verify, sign in and onboard. */
export async function person(
  handle = uniqueHandle(),
  extra: Record<string, unknown> = {},
): Promise<Onboarded> {
  const me = await signup(uniqueEmail(handle));
  await onboard(me.token, handle, extra);
  return { ...me, handle };
}

/** POST a file as multipart `file` (the pytest `files=` argument). */
export function upload(path: string, token: string, content: string | Uint8Array, filename = "export.json") {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/json" }), filename);
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": randomIp() },
    body: form,
  }).then((res) => {
    recordStatements(`POST ${path}`, res);
    return res;
  });
}
