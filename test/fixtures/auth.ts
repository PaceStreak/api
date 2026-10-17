/**
 * Auth fixtures, ported from conftest.py.
 *
 * `authed()` works today: it seeds a user, profile and live session directly and returns an `AuthedBatch`, which is
 * what service-level tests need. `signup()` and `login()` drive the real HTTP routes and arrive with the AUTH unit;
 * until then they fail loudly instead of faking tokens.
 */
import type { AuthedBatch } from "../../src/db/batch.ts";
import { authedBatch, type SeededUser, type SeedUserOptions, seedUser, type TestDb, testDb } from "./db.ts";

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

export interface SignedIn {
  token: string;
  userId: string;
  email: string;
  password: string;
  cookies: Record<string, string>;
}

const PENDING = "lands with the AUTH unit: use authed() for service-level tests until then";

/** POST /v1/auth/signup (+ verification), returning a bearer token. */
export async function signup(_email?: string, _password?: string): Promise<SignedIn> {
  throw new Error(`signup() ${PENDING}`);
}

/** POST /v1/auth/login. */
export async function login(_email: string, _password: string): Promise<SignedIn> {
  throw new Error(`login() ${PENDING}`);
}
