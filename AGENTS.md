# AGENTS.md — api (TypeScript on Cloudflare Workers)

The PaceStreak API: Hono on Cloudflare Workers, D1 through Drizzle, Zod.
**`main` is live at `api.pacestreak.com`** (since 2026-10-19). The old Python
service is on branch `old`, kept for reference: `git show old:app/<path>`.
Nothing Python applies to `main`: no `make`, Docker Compose, Postgres, Redis or
Alembic. `next` was the rewrite branch; it is retired and no longer updated. Work on `main`.

Workspace-wide rules (CSP, cookies, privacy, commit conventions, what is
already decided) live in the root
[`AGENTS.md`](https://github.com/PaceStreak/pacestreak/blob/main/AGENTS.md).
The rewrite's plan and rules are in `docs/rewrite/`:

- `OWNER-DECISIONS.md` overrides everything else.
- `DESIGN.md` is the architecture; `WORKPLAN.json` the units.
- `CONVENTIONS.md` is how to write a module, a query and a test here. Read it before coding.
- `PROGRESS.md` records how the rewrite was built (complete).
- `CHANGES-FROM-PYTHON.md` is append-only: every behaviour or contract change, why, and its test.
- `CUTOVER.md` is the deploy and retirement runbook used for the switch.

The docs site, [docs.pacestreak.com](https://docs.pacestreak.com), describes
every repository, the topology and the runbook.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev              # wrangler dev on :8787, local D1/R2/Queues in .wrangler/
pnpm typecheck        # tsc (TypeScript 7) over src, test and scripts
pnpm biome ci .       # lint + format check; `pnpm format` fixes
pnpm vitest run       # tests run inside workerd with local D1/R2/Queues
pnpm check:deps       # module boundaries (DESIGN.md §2)
pnpm check:parity     # every pytest name is ported or explicitly dropped
pnpm build            # wrangler deploy --dry-run + 400 KiB gzip budget
pnpm db:generate      # new migration from src/db/schema; then pnpm db:fk-users
pnpm types            # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm admin <cmd>      # create-admin | set-password | set-role: prints SQL for `wrangler d1 execute`
pnpm openapi          # regenerate openapi.json (the API reference) from the routes
```

A test that times out under load passes on a rerun; rerun it once before
investigating.

## Testing

Each test file gets a fresh, isolated in-memory D1 with migrations applied
(`test/setup.ts`), and bindings come only from `vitest.config.ts`. Tests
cannot touch `wrangler dev` state or any remote database, so the Python
suite's "tests truncate the database you point them at" hazard is gone. Do not
add a test path that reads `.dev.vars` or a remote binding.

## Deploy

Workers Builds: push to `main` runs `pnpm run build`, then
`pnpm wrangler d1 migrations apply pacestreak --remote && pnpm wrangler deploy`.
Staging (`pacestreak-api-staging.alzywelzy.workers.dev`) is deployed by hand
with `--env staging`. `wrangler triggers deploy` counts as a production
deployment. Migrations must stay backward compatible
(old code runs briefly on the new schema). CI (`.github/workflows/ci.yml`)
deploys nothing and needs no secrets; workflow files are pushed over SSH.

## Rules for this repo

- Pushing `main` deploys production. Unattended sessions never push `main`,
  never create Cloudflare resources and never change DNS.
- No `any`, no non-null assertions, strict TypeScript. Handlers never touch
  `env.DB`; they use `ctx.db` and `AuthedBatch` (`src/db/batch.ts`).
- One read batch and one write batch per request; tests assert round trips.
- Production is on **Workers Free** (OWNER-DECISIONS 2026-10-19). D1 allows
  50 queries per invocation there (1,000 on Paid), every statement of a batch
  counted. `PLAN` in `wrangler.jsonc` is the one switch (`src/lib/plan.ts`);
  each request and queue message stays within 90% of the cap. Route tests fail
  above it (`test/fixtures/http.ts`). Fuse bounded reads (`packReads`), write
  many rows as one `json_each` statement, and split work across queue messages
  when it cannot fit. Queue consumers take one message (`max_batch_size: 1`).
- If the API host or R2 host changes, `app/public/_headers` `connect-src`
  changes in the same commit, or every request fails silently.
- The refresh cookie is `Domain=pacestreak.com`, `__Secure-`, `SameSite=Lax`.
  Don't switch to `__Host-` or `SameSite=None`; CORS origins stay explicit.
- Habits never reach a feed, profile, group or leaderboard.
- A material `/privacy` or `/terms` change bumps `SETTINGS.termsVersion`
  (`src/env.ts`) and its test.
- Secrets live in `.dev.vars` (gitignored) and `wrangler secret`; never commit
  one, never paste one into a chat.

## Commits

Conventional commits, subject says what, body says why. Commit as
`AlzyWelzy <welzyalzy@gmail.com>`. **Never credit an AI tool**: no
`Co-Authored-By` trailer and no "Generated with" line, in commits or PRs.
