# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project will use [Semantic Versioning](https://semver.org/) once it ships.

## [Unreleased]

### Added

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
