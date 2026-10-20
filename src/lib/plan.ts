/**
 * The Cloudflare Workers plan the API runs on, and the limits that follow from it. The single switch is the `PLAN`
 * var in wrangler.jsonc ("free" or "paid"); everything sized by a plan limit reads it from here.
 *
 * Free (OWNER-DECISIONS.md, 2026-10-19: try Free first):
 * - D1: 50 queries per Worker invocation, every statement of a `batch()` counted
 *   (https://developers.cloudflare.com/d1/platform/limits/). Paid: 1,000.
 * - Workers: 10 ms CPU per invocation, no `cpu_ms` setting; 100,000 requests a day; 50 subrequests
 *   (https://developers.cloudflare.com/workers/platform/limits/).
 * - Queues: 10,000 operations a day, about three per message (https://developers.cloudflare.com/queues/platform/pricing/).
 */
export const PLANS = ["free", "paid"] as const;
export type Plan = (typeof PLANS)[number];

export const D1_QUERIES_PER_INVOCATION: Record<Plan, number> = { free: 50, paid: 1000 };

/** Share of the D1 cap that one request or queue message may plan to spend; the rest is headroom. */
export const BUDGET_SHARE = 0.9;

/** Statements one invocation may spend on `plan`: 45 on Free, 900 on Paid. */
export const d1Budget = (plan: Plan): number => Math.floor(D1_QUERIES_PER_INVOCATION[plan] * BUDGET_SHARE);

/** Outbound subrequests (fetch, SMTP sockets) per invocation (Workers limits page). Paid: 10,000 by default. */
export const SUBREQUESTS_PER_INVOCATION: Record<Plan, number> = { free: 50, paid: 10_000 };

/** Subrequests one invocation may plan to spend: 45 on Free. */
export const subrequestBudget = (plan: Plan): number =>
  Math.floor(SUBREQUESTS_PER_INVOCATION[plan] * BUDGET_SHARE);
