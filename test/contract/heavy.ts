/** The seeded heavy user (5 years, 3,000 workouts, ~30,000 sets, 20 habits, 2,000 logs) signed in over HTTP. */
import { sessions } from "../../src/db/schema/index.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { accessToken } from "../../src/modules/auth/tokens.ts";
import * as game from "../../src/modules/game/service.ts";
import { testDb } from "../fixtures/db.ts";
import { seedHeavyUser } from "../fixtures/heavy-user.ts";
import type { HeavyOptions } from "../fixtures/heavy-user-data.ts";
import { jobCtx } from "../jobs/helpers.ts";

export interface HeavyUser {
  userId: string;
  token: string;
  habitId: string;
}

export async function heavyUser(opts: Partial<HeavyOptions> = {}): Promise<HeavyUser> {
  const data = await seedHeavyUser(opts);
  const userId = data.users[0]?.id as string;
  await game.rebuild(jobCtx(), userId);
  const sessionId = uuid7();
  const now = Date.now();
  await testDb()
    .db.insert(sessions)
    .values({ id: sessionId, userId, createdAt: now, expiresAt: now + 86_400_000 });
  const token = await accessToken(jobCtx(), userId, 0, sessionId);
  return { userId, token, habitId: data.habits[0]?.id as string };
}
