/**
 * Route guards (DESIGN.md §5 step 9). They verify the access JWT only (no D1 query) and attach an `AuthedBatch`
 * whose statement 0 checks the session and user, so revocation is immediate without a cache or denylist.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv, AuthedEnv } from "../../ctx.ts";
import { AuthedBatch, type AuthUser } from "../../db/batch.ts";
import { notFound, unauthorized } from "../../lib/errors.ts";
import { readToken } from "./tokens.ts";

export const INVALID_CREDENTIALS = "Invalid authentication credentials";

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(header);
  if (m === null || m[1]?.toLowerCase() !== "bearer") return null;
  return m[2] ?? null;
}

type Require = (u: AuthUser) => void;

function guard(require?: Require): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const ctx = c.var.ctx;
    const token = bearer(c.req.header("Authorization"));
    const claims = token === null ? null : await readToken(ctx, token, "access");
    if (claims === null || claims.sessionId === null) throw unauthorized(INVALID_CREDENTIALS);
    c.set(
      "authed",
      new AuthedBatch(
        ctx.db,
        { userId: claims.userId, sessionId: claims.sessionId, tokenVersion: claims.tokenVersion },
        require,
      ),
    );
    await next();
  };
}

/** Any signed-in user (Python `get_current_user` / `get_current_db_user`). */
export const auth = (): MiddlewareHandler<AuthedEnv> => guard();

/** Moderators and admins; anyone else gets the admin router's 404 "Not found". */
export const moderator = (): MiddlewareHandler<AuthedEnv> =>
  guard((u) => {
    if (u.role !== "moderator" && u.role !== "admin") throw notFound("Not found");
  });

/** Admins only (404 "Not found" otherwise, as in Python). */
export const admin = (): MiddlewareHandler<AuthedEnv> =>
  guard((u) => {
    if (u.role !== "admin") throw notFound("Not found");
  });

/** Optional caller: `c.var.authed` is set only for a well-formed access token (Python `get_optional_user`). */
export const optionalAuth = (): MiddlewareHandler<AppEnv & { Variables: { authed?: AuthedBatch } }> => {
  return async (c, next) => {
    const token = bearer(c.req.header("Authorization"));
    const claims = token === null ? null : await readToken(c.var.ctx, token, "access");
    if (claims !== null && claims.sessionId !== null) {
      c.set(
        "authed",
        new AuthedBatch(c.var.ctx.db, {
          userId: claims.userId,
          sessionId: claims.sessionId,
          tokenVersion: claims.tokenVersion,
        }),
      );
    }
    await next();
  };
};
