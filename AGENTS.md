# AGENTS.md — api (branch `next`: TypeScript on Cloudflare Workers)

The PaceStreak API: Hono on Cloudflare Workers, D1 through Drizzle, Zod.
**`main` still holds the Python service until cutover**
(`docs/rewrite/CUTOVER.md`); it is the reference implementation:
`git show main:app/<path>`. Nothing Python applies on this branch: no `make`,
Docker Compose, Postgres, Redis or Alembic.

Workspace-wide rules (CSP, cookies, privacy, commit conventions, what is
already decided) live in the root
[`AGENTS.md`](https://github.com/PaceStreak/pacestreak/blob/main/AGENTS.md).
The rewrite's plan and rules are in `docs/rewrite/`:

- `OWNER-DECISIONS.md` overrides everything else.
- `DESIGN.md` is the architecture; `WORKPLAN.json` the units.
- `CONVENTIONS.md` is how to write a module, a query and a test here. Read it before coding.
- `PROGRESS.md` is the state: its `Next step:` line says where to resume.
- `CHANGES-FROM-PYTHON.md` is append-only: every behaviour or contract change, why, and its test.
- `CUTOVER.md` is the owner's deploy and retirement runbook.

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

Workers Builds: push to `main` runs
`wrangler d1 migrations apply pacestreak --remote && wrangler deploy`; other
branches deploy `--env staging`. Migrations must stay backward compatible
(old code runs briefly on the new schema). CI (`.github/workflows/ci.yml`)
deploys nothing and needs no secrets; workflow files are pushed over SSH.

## Rules for this repo

- Never deploy, never create Cloudflare resources, never change DNS and never
  push `main` from an unattended session. Push `next` only.
- No `any`, no non-null assertions, strict TypeScript. Handlers never touch
  `env.DB`; they use `ctx.db` and `AuthedBatch` (`src/db/batch.ts`).
- One read batch and one write batch per request; tests assert round trips.
- D1 allows 1,000 statements per invocation: queue consumers take one message
  (`max_batch_size: 1`) and job slices are sized in `src/jobs/dispatch.ts`.
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
