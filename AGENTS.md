# AGENTS.md — api (branch `next`: TypeScript rewrite)

The PaceStreak API, being rewritten as Hono on Cloudflare Workers with D1,
Drizzle and Zod. `main` still holds the Python service, which is the reference
implementation: read old code with `git show main:app/<path>`.

Workspace-wide rules (CSP, cookies, privacy, commit conventions, what is
already decided) live in the root
[`AGENTS.md`](https://github.com/PaceStreak/pacestreak/blob/main/AGENTS.md).
The rewrite's plan and rules are in `docs/rewrite/`:

- `OWNER-DECISIONS.md` overrides everything else.
- `DESIGN.md` is the architecture; `WORKPLAN.json` the units.
- `CONVENTIONS.md` is how to write a module, a query and a test here. Read it before coding.
- `PROGRESS.md` is the state: its `Next step:` line says where to resume.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # tsc (TypeScript 7) over src, test and scripts
pnpm biome ci .       # lint + format check; `pnpm format` fixes
pnpm vitest run       # tests run inside workerd with local D1/R2/Queues
pnpm check:deps       # module boundaries (DESIGN.md §2)
pnpm check:parity     # every pytest name is ported or explicitly dropped
pnpm build            # wrangler deploy --dry-run + 400 KiB gzip budget
pnpm db:generate      # new migration from src/db/schema; then pnpm db:fk-users
pnpm types            # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

## Rules for this repo

- Never deploy, never create Cloudflare resources and never push `main` from an
  unattended session. Push `next` only.
- No `any`, no non-null assertions, strict TypeScript. Handlers never touch
  `env.DB`; they use `ctx.db` and `AuthedBatch` (`src/db/batch.ts`).
- One read batch and one write batch per request; tests assert round trips.
- Habits never reach a feed, profile, group or leaderboard.
- Secrets live in `.dev.vars` (gitignored) and `wrangler secret`; this
  repository is public.

## Commits

Conventional commits, subject says what, body says why. Commit as
`AlzyWelzy <welzyalzy@gmail.com>`. **Never credit an AI tool**: no
`Co-Authored-By` trailer and no "Generated with" line, in commits or PRs.
