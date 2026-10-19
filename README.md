# PaceStreak API

Backend for [PaceStreak](https://www.pacestreak.com), a habit and streak
tracker: about 265 routes under `/v1`, a scheduler and a job queue, in one
Cloudflare Worker. TypeScript, [Hono](https://hono.dev), D1 through
[Drizzle](https://orm.drizzle.team), [Zod](https://zod.dev).

> **Branch `next` is this TypeScript service.** `main` still holds the Python
> (FastAPI) service that serves `api.pacestreak.com` until the cutover in
> [`docs/rewrite/CUTOVER.md`](./docs/rewrite/CUTOVER.md) merges `next` into
> `main`. Read the old code with `git show main:app/<path>`.

Copyright (c) 2026 PaceStreak. Licensed under [AGPL-3.0](./LICENSE): anyone
running a modified version over a network must offer its source to its users.

## Status

| | |
| --- | --- |
| Runtime | Cloudflare Workers (Paid plan), Smart Placement |
| Storage | D1 `pacestreak` (location `apac`), R2 `pacestreak-photos` and `pacestreak-staging` |
| Background work | Three cron triggers and the `pacestreak-jobs` queue (one message per invocation, DLQ `pacestreak-jobs-dlq`) |
| Mail | Off (`EMAIL_ENABLED=0`, see Email switch); Cloudflare Email Service (`send_email` binding) when on; a `console` transport in dev and tests |
| Hostname | `api.pacestreak.com`, a Workers custom domain (after cutover) |
| Consumer | [`PaceStreak/app`](https://github.com/PaceStreak/app) at `app.pacestreak.com` |
| Deploys | Workers Builds: push to `main` applies D1 migrations, then deploys; other branches deploy `--env staging` |
| Monitoring | `/health`, `/health/ready`, `/health/worker` on [`status.pacestreak.com`](https://status.pacestreak.com) |

Everything deployable is declared in [`wrangler.jsonc`](./wrangler.jsonc).

## Quick start

Needs Node 24 and pnpm (the version is pinned in `package.json`; `corepack enable`).

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars        # gitignored; fill in the secrets below
pnpm wrangler d1 migrations apply pacestreak --local
pnpm dev                              # wrangler dev on http://localhost:8787
```

Local secrets for `.dev.vars` (never reuse them anywhere else):

```bash
openssl rand -base64 32               # PEPPER, and again for DATA_KEY
printf '{"current":"k1","keys":{"k1":"%s"}}\n' "$(openssl rand -base64 32)"   # JWT_KEYS
```

`TURNSTILE_SECRET_KEY` can be Cloudflare's always-pass test secret
`1x0000000000000000000000000000000AA`; VAPID and R2 keys are optional locally
(push and photo backup then answer 503). With `EMAIL_ENABLED=1` and
`MAILER=console`, verification, reset and email-change codes print to the `wrangler dev` log.

Run the app against it with `PUBLIC_API_BASE_URL=http://localhost:8787` in
`../app`.

## Email switch

`EMAIL_ENABLED` in `wrangler.jsonc` `vars` is a capability, not a transport. It is **`"0"` in production and
staging today**: the Workers Free plan has no Cloudflare Email Service sending.

| | `EMAIL_ENABLED=0` | `EMAIL_ENABLED=1` |
| --- | --- | --- |
| Sending | Nothing is ever handed to a transport (`createMailer` drops it) | `MAILER` (`cloudflare` in production) |
| Signup | Usable at once; the response carries 10 `recovery_codes` | A 6-digit code is mailed |
| Confirmed address | Never required (sign-in, follows, groups) | Required in production and staging |
| `verify-email`, `resend-verification`, `forgot-password`, `reset-password`, `confirm-email-change` | 404 `{"detail": "Email is turned off"}` | As before |
| `change-email` | Changes at once on the current password; 409 if taken; security notice in the inbox and on push | Code to the new address |
| Lost password | `/v1/auth/recover` with a recovery code | Reset code by email, or a recovery code |
| Email notifications | Channel off everywhere (stored choices kept); push and inbox unchanged | Per-category choice |
| App | `email_enabled` in `GET /v1/config` (public) and `GET /v1/me` hides every email feature | Everything shows |

Recovery codes (`POST /v1/auth/recovery-codes` with the password, and a TOTP code when 2FA is on) work for every
account in both modes. To turn email on: onboard `pacestreak.com` for sending, set `"EMAIL_ENABLED": "1"`, deploy.
Accounts made while it was off are unconfirmed, so their next sign-in goes through the app's confirm-your-email
step once.

## Testing email locally

`wrangler dev` simulates the `send_email` binding: nothing is delivered, and each message is saved as a raw MIME
`.eml` file. To exercise the real `MAILER=cloudflare` path:

```bash
pnpm dev:email                       # wrangler dev on :8788, MAILER=cloudflare, EMAIL_ENABLED=1,
                                     # throwaway secrets and its own D1 under .wrangler/email-local
curl -s localhost:8788/v1/auth/signup -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-local-password","turnstile_token":"x"}'
pnpm email:last                      # headers and decoded text of the newest captured message
```

The log shows `send_email binding called with the following message:` and the file's path, under
`.wrangler/tmp/email/miniflare-*/email/<message-id>.eml`. `PORT=8790 pnpm dev:email` picks another port.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | `wrangler dev` with local D1, R2 and Queues under `.wrangler/` |
| `pnpm dev:email` / `pnpm email:last` | `wrangler dev` on the real mailer path, then print the newest captured email |
| `pnpm typecheck` | TypeScript 7 over `src`, `test` and `scripts` |
| `pnpm lint` / `pnpm format` | `biome ci .` / fix formatting and safe lints |
| `pnpm test` | Vitest inside `workerd` (`@cloudflare/vitest-plugin`) |
| `pnpm check:deps` | Module boundaries (`docs/rewrite/DESIGN.md` §2) |
| `pnpm check:parity` | Every pytest from the Python service is ported or explicitly dropped |
| `pnpm check:app` | The routes the app calls exist here |
| `pnpm build` | `wrangler deploy --dry-run` and the 400 KiB gzip bundle budget |
| `pnpm db:generate` | New migration from `src/db/schema`; then `pnpm db:fk-users` |
| `pnpm types` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |
| `pnpm admin ...` | Operator commands (create-admin, set-password, set-role); print SQL for `wrangler d1 execute` |
| `pnpm bench` | Benchmarks (`test/bench`) |

## Layout

```text
src/
  index.ts          Worker entry: fetch, scheduled, queue
  app.ts routes.ts  Hono app, middleware, route table
  env.ts            Config: vars and secrets parsed once by Zod; SETTINGS (terms_version, token lifetimes)
  ctx.ts            Per-request context (db, deferred work, round-trip counter)
  db/               Drizzle schema, AuthedBatch (one read batch, one write batch), guards
  modules/          auth, profile, habits, training, game, social, groups, nutrition,
                    insights, notifications, account, trash, search, admin, ops
  jobs/             Cron dispatch, leases, heartbeat, queue consumer, tasks
  heavy/            Resumable importers and exporters (CSV, GPX, FIT, ZIP, JSON)
  lib/              Crypto (PBKDF2, JWT, AES-GCM), mailer, push (RFC 8291/8292), R2, rate limits
  catalog/          Exercises, routines and plans (data)
migrations/         D1 SQL migrations (drizzle-kit), applied before every deploy
test/               Vitest suites; test/parity holds the ported pytest cases
docs/rewrite/       Owner decisions, design, conventions, workplan, progress, cutover
```

## Testing

`pnpm test` runs every suite inside `workerd`, the real Workers runtime, with
local D1, R2 and Queues provided by Miniflare. Nothing is mocked except
outbound `fetch`, which is blocked unless a test stubs it.

**There is no "tests truncate your database" hazard any more.** The Python
suite ran against whichever Postgres it was pointed at and truncated every
table, so pointing it at the dev database wiped the dev admin. Here each test
file gets its own fresh, isolated D1 with the migrations applied
(`test/setup.ts`), held in memory by the test runner. Tests read their
bindings only from `vitest.config.ts` (fixed, obviously fake secrets) and
never from `.dev.vars`, `.env` or a remote database, so they cannot reach
local `wrangler dev` state or production.

Each route has a D1 round-trip budget, asserted with `expectRoundTrips`.
`CHANGES-FROM-PYTHON.md` lists every intentional behaviour change with the
test that covers it.

## Deploy

Workers Builds deploys on push; there is no deploy workflow and CI needs no
secrets. On `main`:

```bash
pnpm wrangler d1 migrations apply pacestreak --remote && pnpm wrangler deploy
```

Migrations land before the code, and the old code briefly runs against the
new schema, so a migration must stay backward compatible (add, never rename
or drop in the same release). Roll back code with `pnpm wrangler rollback`;
roll back data with D1 Time Travel (30 days on Workers Paid). Secrets are set
with `wrangler secret put` and never committed: see
[`docs/rewrite/CUTOVER.md`](./docs/rewrite/CUTOVER.md) step 8 for the list
and how to generate each one.

## Load-bearing rules

- **The API host and the app's CSP move together.** `app/public/_headers`
  allows `connect-src https://api.pacestreak.com` (and the R2 account host in
  `R2_ACCOUNT_HOST`). If either host changes, change `_headers` in the same
  commit as the base URL, or every request fails silently.
- **The refresh cookie is `Domain=pacestreak.com`, `__Secure-`, `SameSite=Lax`,
  `Path=/v1/auth`.** `__Host-` would forbid `Domain`; `SameSite=None` would
  widen exposure for nothing (app and api are same-site). Nothing untrusted
  may ever be hosted under `pacestreak.com`.
- **CORS lists explicit origins** (`CORS_ORIGINS`); `*` is refused at startup
  because credentials are sent.
- **A production misconfiguration refuses to serve**: every request is a 500
  and the log says `refusing to start: <reason>`.
- **Habits never reach anyone else**: no feed, profile, group or leaderboard
  shows a habit's name, amounts or slips.
- **A material change to `/privacy` or `/terms` bumps `SETTINGS.termsVersion`**
  in `src/env.ts`, which makes every account accept again.
- **Do not raise the queue's `max_batch_size`**: D1 allows 1,000 statements per
  invocation, so a consumer takes one message at a time.

## More

- [`AGENTS.md`](./AGENTS.md): working rules for this repo.
- [`docs/rewrite/`](./docs/rewrite/): `OWNER-DECISIONS.md` (overrides the
  rest), `DESIGN.md`, `CONVENTIONS.md`, `CHANGES-FROM-PYTHON.md`, `CUTOVER.md`.
- [`SECURITY.md`](./SECURITY.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md).
