# AGENTS.md — api

FastAPI backend for PaceStreak, live at `api.pacestreak.com`.

Workspace-wide rules (CSP, cookies, privacy, commit conventions, what is
already decided) live in the root
[`AGENTS.md`](https://github.com/PaceStreak/pacestreak/blob/main/AGENTS.md).
Read it first; this file only adds what is specific to this repository.

## Commands

```bash
make keys vapid   # first run only: JWT keypair and Web Push keys
make dev          # api :8000, postgres :5432, redis :6379, worker (reload)
make migrate      # apply migrations inside the containers
make migration m="what changed"   # autogenerate; Alembic is the only schema path
make lint         # ruff check + format check
```

**Tests truncate every table in the database they point at.** Never run
`make test` or `pytest` against the dev database; use `pacestreak_test` and
Redis db 15 exactly as `README.md#tests` shows. CI runs `ruff`, `alembic
upgrade head`, `alembic check` and `pytest`; all must pass.

## Rules for this repo

- Every route lives under `/v1`; see `VERSIONING.md` before changing a response.
- Nothing is mocked in tests: they run against real Postgres and Redis.
- Pure engines (`game/`, `habits/engine.py`, `training/pauses.py`,
  `training/importers.py`) do no I/O. Streaks are recomputed from the log.
- A new table holding user data must be added to both `build_export` and
  `import_data` in `app/account/router.py`.
- Habits never reach a feed, profile, group or leaderboard.
- Bump `TERMS_VERSION` in the same change as a material edit to `/terms` or
  `/privacy` on `www`.
- `scripts/loadtest.py` runs full load only against a local stack; against
  production use `--health-only` and nothing heavier. Its accounts, rate
  limits and free-tier quotas are real.
- Production config is checked at startup (`_check_production_config` in
  `app/main.py`); new required settings go there and in `compose.prod.yaml`.

## Deploying

Push to `main`. FastAPI Cloud's GitHub integration deploys the API (about two
minutes; `fastapi cloud deployments list` shows the result). `migrate.yml`
applies migrations when `alembic/**` changed, and it races the deploy, so keep
every migration compatible with the code still running (add, switch, drop
later). `publish.yml` pushes the image the five-minute `worker.yml` tick runs.
The VM and GCP project are gone; do not reintroduce a host-specific deploy.
Environment changes are `fastapi cloud env set NAME --value-stdin`, and the
worker needs the same value in the `WORKER_ENV_JSON` secret.

## Commits

Conventional commits, subject says what, body says why. Commit as
`AlzyWelzy <welzyalzy@gmail.com>`. **Never credit an AI tool**: no
`Co-Authored-By` trailer and no "Generated with" line, in commits or PRs.
This repository is public, so never commit a secret.
