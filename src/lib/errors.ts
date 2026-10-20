/**
 * Error envelope (spec/core.md §2.2). Handlers throw `HttpError`; the error boundary in app.ts renders it.
 * Everything else becomes 409 (D1 constraint) or 500, never a stack trace.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const SERVER_ERROR = "Something went wrong on our side. Try again in a moment.";
export const SAVED_TWICE = "That was saved twice at once. Try again.";
export const SLOW_DOWN = "Slow down - try again in a little while.";

/** `detail` plus, on a few routes, extra fields the client acts on (e.g. a sign-in challenge that survives a 503). */
export type ErrorBody = { detail: unknown; [extra: string]: unknown } | { error: string };

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;

  /**
   * Renders `{"detail": detail}` with `status`. `detail` is usually a string; a few routes send objects or lists.
   * `body` replaces the envelope entirely: only slowapi's 429 `{"error": ...}` needs that.
   */
  constructor(
    status: ContentfulStatusCode,
    detail: unknown,
    headers: Record<string, string> = {},
    body?: ErrorBody,
  ) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body ?? { detail };
    this.headers = headers;
  }
}

export const badRequest = (detail: string) => new HttpError(400, detail);
export const unauthorized = (detail: string) => new HttpError(401, detail);
export const forbidden = (detail: string) => new HttpError(403, detail);
export const notFound = (detail = "Not found") => new HttpError(404, detail);
export const conflict = (detail: string) => new HttpError(409, detail);
/**
 * An email-only route while `EMAIL_ENABLED=0`. 404, like push routes without VAPID keys ("Push is not configured on
 * this server"): the feature is absent on this server, and nothing the caller sends would change that.
 */
export const EMAIL_OFF = "Email is turned off";
export const emailOff = () => new HttpError(404, EMAIL_OFF);
/** Per-user bucket exceeded (spec/core.md §2.3 B). */
export const slowDown = () => new HttpError(429, SLOW_DOWN);
/** Per-IP minute limit exceeded: slowapi's body shape, `{"error": "Rate limit exceeded: 10 per 1 minute"}`. */
export const ipRateLimited = (limit: number, retryAfterSec = 60) =>
  new HttpError(
    429,
    null,
    { "Retry-After": String(retryAfterSec) },
    { error: `Rate limit exceeded: ${limit} per 1 minute` },
  );

const CONSTRAINT_RE = /(UNIQUE|FOREIGN KEY|NOT NULL|CHECK) constraint failed/;

/** True for a D1/SQLite constraint violation, including one wrapped by drizzle (`cause`). */
export function isConstraintError(err: unknown): boolean {
  return constraintMessage(err) !== null;
}

/** The `... constraint failed: table.column` text of a constraint error, or null. */
export function constraintMessage(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const m = CONSTRAINT_RE.exec(e.message);
    if (m) return e.message.slice(m.index);
  }
  return null;
}
