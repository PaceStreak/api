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

Push to `main`. CI publishes `ghcr.io/pacestreak/api:latest`; the GCP VM's
`autodeploy.timer` (`deploy/gcp/`) rolls it out within about two minutes and
migrations run on boot. Never change the VM's machine type or config (free
tier). Check a rollout with
`gcloud compute ssh pacestreak-api --zone us-central1-a` then
`sudo docker service ps pacestreak_api`.

## Commits

Conventional commits, subject says what, body says why. Commit as
`AlzyWelzy <welzyalzy@gmail.com>`. **Never credit an AI tool**: no
`Co-Authored-By` trailer and no "Generated with" line, in commits or PRs.
This repository is public, so never commit a secret.
