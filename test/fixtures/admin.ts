/** Admin fixtures: promote a signed-up account (pytest `make_role`). Roles are read from D1 on every request. */
import { eq } from "drizzle-orm";
import type { UserRole } from "../../src/db/schema/index.ts";
import { users } from "../../src/db/schema/index.ts";
import { type SignedIn, signup } from "./auth.ts";
import { testDb, uniqueEmail } from "./db.ts";

export async function makeRole(userId: string, role: UserRole): Promise<void> {
  await testDb().db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function signupAs(role: UserRole, email = uniqueEmail(role)): Promise<SignedIn> {
  const who = await signup(email);
  await makeRole(who.userId, role);
  return who;
}
