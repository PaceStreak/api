# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project will use [Semantic Versioning](https://semver.org/) once it ships.

## [Unreleased]

### Added

- Habits can be planned for chosen weekdays (`days_mask`): the target follows
  the days, reminders fire only on them, and an off-plan day still counts.
- Pause one habit (`POST /habits/{id}/pause`, `/resume`): its streak neither
  breaks nor grows and it sends no reminders. Exported and imported.
- A refresh token reused within 30 seconds of its rotation, while its
  successor is still live, continues the session instead of revoking it:
  two quick reloads or two tabs no longer sign people out.
- Import set-by-set history from Strong, Hevy and FitNotes CSV exports.
  Names map to the library (equipment-aware); unknown ones become custom
  exercises. Idempotent, `source="import"`.
- Admin account merge (`POST /v1/admin/users/{id}/merge`), audited, driven by
  the database's own foreign keys.
- The test suite ignores `.env`, so local runs match CI and never send mail.
- The exercise library grows from 84 to 283: every common squat, hinge, lunge,
  press, row, pulldown, raise, curl, extension, core, carry and conditioning
  variation, each with muscles, a cue and search aliases.
- 16 more starter routines (24) and 18 more built-in plans (22): five by five,
  push/pull/legs, upper/lower, dumbbells, kettlebell, bodyweight, glutes,
  lift-and-run, conditioning, core, cycling, swimming, rowing, mobility,
  walking, first month in the gym, and coming back from a break.
- Six cable exercises for the three common grips: V-handle, neutral-grip
  and wide neutral-grip, each as a pulldown and a seated row (84 in all).
- Far more handles are reserved: about 280 words plus pattern rules, so
  `admin_user`, `the_admin`, `adm1n` and `run_mod_42` are refused while
  `badminton` and `model` stay available.
- `terms_version` is `2026-10-02`, so every account accepts the revised terms
  and privacy policy once.
- `AGENTS.md` with this repository's commands and rules for coding agents; the
  README and architecture notes now describe the live deployment, not a plan.
- Account recovery with a 2FA code, email change, terms versions.
- Anonymous crash reports and an admin abuse view; both swept after 30 days.
- Smart reminder timing, monthly goals, rest days.
- Supersets on sets, kilometre splits from GPX/FIT, plans as files.
- Plan challenges, coach-suggested plans, buddy at-risk nudges, group
  announcements.

- Passkeys (WebAuthn) under `/v1/auth/passkeys`; a passkey sign-in
  satisfies 2FA.
- `/health/ready` and `/health/worker`; a worker heartbeat and per-job
  results in admin metrics; `make recompute-all`.
- Opt-in monthly backup reminder (the `backup` notification category).
- Chain requirements, 12/52-week consistency, `/v1/me/review`,
  `/v1/me/records/history`, `travel` pauses.
- Workout tags and gear (`/v1/gear`), training plans (`/v1/plans`).
- Buddy streaks (`/v1/buddies`), group streaks with `streak_threshold`,
  preset encouragement; `user_stats.recent_weeks`.
- Export version 2: tags, gear, plans, requirements, buddies.

- `compose.prod.yaml`: host-agnostic production stack (required secrets,
  loopback-only API, one-shot migrations, read-only containers, limits, log
  rotation). JWT/VAPID keys can be injected as PEM environment variables.
- Hardened SMTP (implicit TLS option, retries, standard headers) and RFC 8058
  one-click unsubscribe. Production refuses the console email backend.
- `python -m app.cli` with `create-admin`, `set-password` and `set-role`.
- `scripts/backup.sh`, `restore-check.sh` and `restore.sh`.
- Group mute (`PATCH /groups/{id}/me` `{"muted": true}`), migration
  `d32eee1ab7f7`.
- GitHub Actions CI.

- Streak pauses (`/v1/pauses`): injury/illness/life breaks that shelter any
  week they cover for four days or more. Bounded (14 days back, 30 ahead, 12
  weeks each, 120 days a year, no overlap); reminders stop while one runs;
  included in export and import.
- Weekly recap (`GET /v1/me/recap`), shared with the Monday digest.
- GPX, FIT and CSV file import (`POST /v1/workouts/import`), idempotent, with
  `defusedxml` and `fitdecode`.
- Private calendar feed (`/v1/me/calendar`, `/v1/calendar/{token}.ics`) and a
  shared RFC 5545 builder for the ICS export. New setting: `PUBLIC_API_URL`.
- Official accounts (`POST /v1/admin/users/{id}/official`), `official` on
  profiles and people, and brand-impersonation checks on handles and display
  names.
- Migration `8a26a9caf99a`.
- The product backend: profiles and onboarding with age gates; training logs
  with offline-safe sync, the exercise library, routines and body metrics;
  the week-based streak engine, XP, levels, records, achievements and
  leaderboards; the social layer, groups and challenges; notifications with
  Web Push and email; export, import and deletion; admin and moderation; and
  the background worker. Migration `fd264d571db7`.

- Full auth system under `/v1/auth`: email/password signup and login, RS256
  access tokens, rotating single-use refresh tokens with reuse detection and
  session-family revocation, CSRF-protected cookie transport, email
  verification, password reset and change, remote session listing/revocation,
  and TOTP two-factor with encrypted-at-rest secrets, replay protection, and
  recovery codes.
- Redis-backed rate limiting on `/signup`, `/login`, `/2fa/verify`,
  `/forgot-password` and `/resend-verification`.
- Alembic migrations, with the initial schema for `users`, `refresh_tokens`,
  `one_time_tokens` and `recovery_codes`.
- A `Makefile` (`make dev`, `make migrate`, `make test`, `make keys`, …) and a
  pytest suite that runs against real Postgres and Redis.
- [VERSIONING.md](./VERSIONING.md): the API versioning policy - URI path
  versioning and why, the app-version/URL-version distinction, what counts as
  a breaking change, how a `/v2` gets added, and the `Deprecation`/`Sunset`/
  `Link` header policy (RFC 9745, RFC 8594, RFC 8288) for retiring one. A
  `PaceStreak-Version` response header now reports the URL version that
  served each `/v1` request.
- `app/versioning.py` and `app/v1/router.py`: the version prefix now lives in
  exactly one place. Feature routers (`app/auth/router.py`) mount unprefixed
  and are given their version by the aggregator, so adding `/v2` later is
  additive rather than a find-and-replace across every router file.
- Repository scaffolding and the constraints that were already settled by
  decisions elsewhere: cookie scoping, CORS, route versioning, and the CSP
  change the frontend needs before its first call to this service.

### Fixed

- Dev containers run as the host user, so private keys stay 0600 instead of
  being made world-readable.
- The JWT key is no longer re-read from disk for every token.

- The dev compose override now mounts `alembic/`, so the container sees every
  migration rather than the ones baked into the image at build time.

- The health check route was `/heatlth`; it is `/health` now, matching what
  `compose.yaml`'s healthcheck and `.env.example` already assumed.
- `docker/entrypoint.sh`'s `RUN_MIGRATIONS=1` opt-in previously refused to
  start ("no migration command is configured yet"); it now runs
  `alembic upgrade head`.

### Changed

- The consumer of this API is `PaceStreak/app` on `app.pacestreak.com`, not the
  public site. `PaceStreak/landing` was renamed to `PaceStreak/web` and is now
  a permanently static marketing site that makes no authenticated requests —
  so the `connect-src` widening this API requires belongs in `app`, not there.
