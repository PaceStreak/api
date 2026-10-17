/** Planned statements owned by the core (src/db/batch.ts), registered for the EXPLAIN lint. */

import { and, eq, sql } from "drizzle-orm";
import { rateLimitGuard, sessionGuard } from "./batch.ts";
import type { ExplainCase } from "./explain.ts";
import { sessions, users } from "./schema/index.ts";

const P = { userId: "u", sessionId: "s", tokenVersion: 0 };

export const explain: ExplainCase[] = [
  {
    name: "core.authStatement",
    build: (db) =>
      db
        .select({ id: users.id, revokedAt: sessions.revokedAt })
        .from(users)
        .leftJoin(sessions, and(eq(sessions.id, P.sessionId), eq(sessions.userId, users.id)))
        .where(eq(users.id, P.userId)),
  },
  { name: "core.sessionGuard", build: () => sessionGuard(P) },
  { name: "core.rateLimitGuard", build: () => rateLimitGuard("k", 1) },
  {
    name: "core.syncSeqBump",
    build: () =>
      sql`INSERT INTO sync_seq (id, value) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1`,
  },
];
