/** Training fixtures: test_training.py `workout()` and test_social.py `log_session()` over HTTP. */
import { expect } from "vitest";
import { api, jsonOf, recordStatements } from "./http.ts";

const iso = (ms: number) => new Date(ms).toISOString();
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function workout(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    discipline: "strength",
    started_at: iso(now - HOUR),
    client_updated_at: iso(now),
    duration_sec: 3600,
    sets: [
      { exercise_id: "back-squat", position: 0, set_index: 0, weight_kg: 100, reps: 5, rpe: 8 },
      { exercise_id: "back-squat", position: 0, set_index: 1, weight_kg: 100, reps: 5 },
    ],
    ...extra,
  };
}

export const at = (offsetMs: number) => iso(Date.now() + offsetMs);

export function put(token: string, id: string, body: unknown): Promise<Response> {
  return api(`/v1/workouts/${id}`, { method: "PUT", json: body, token });
}

// biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely, like pytest's .json().
export type Json = any;

export async function logSession(token: string, extra: Record<string, unknown> = {}): Promise<Json> {
  const now = Date.now();
  const res = await put(token, crypto.randomUUID(), {
    discipline: "run",
    started_at: iso(now - HOUR),
    client_updated_at: iso(now),
    duration_sec: 1800,
    distance_m: 5000,
    ...extra,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return jsonOf(res);
}

export async function get(token: string, path: string): Promise<Json> {
  return jsonOf(await api(path, { token }));
}

/** Multipart upload of one file (plus text fields), as the browser sends it. */
export function upload(
  token: string,
  path: string,
  file: { name: string; data: Uint8Array | string; type?: string },
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const bytes = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
  form.append("file", new Blob([bytes], { type: file.type ?? "" }), file.name);
  return import("cloudflare:test").then(({ SELF }) =>
    SELF.fetch(`https://api.pacestreak.test${path}`, {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "10.9.9.9" },
    }).then((res) => {
      recordStatements(`POST ${path}`, res);
      return res;
    }),
  );
}
