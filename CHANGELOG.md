# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project will use [Semantic Versioning](https://semver.org/) once it ships.

## [Unreleased]

No product endpoints yet — what exists is the toolchain and the skeleton.

### Added

- **Python 3.14 and FastAPI, on the Astral toolchain**: uv for packaging and
  the interpreter, Ruff for linting and formatting, ty for type checking.
- Application skeleton in `app/`: a `create_app()` factory, environment-driven
  settings, the session-cookie helpers, `/health`, and an empty but reserved
  `/v1` router.
- **The documented constraints are now tests.** `tests/test_security.py`
  asserts the cookie's `__Secure-` prefix, `Domain`, `HttpOnly`, `Secure` and
  `SameSite=Lax`; `tests/test_cors.py` asserts an explicit credentialed origin
  and that `Settings` refuses `"*"`. 14 tests, 100% coverage.
- `Dockerfile` — multi-stage, non-root, ~55MB, built and run locally to confirm
  the health body, the production docs behaviour and the container user.
- CI: ruff, ruff format, ty, pytest, plus a job that builds the image and
  smoke-tests `/health` against the running container. Actions pinned to commit
  SHAs.
- `.pre-commit-config.yaml`, `Makefile`, `.env.example`, `.dockerignore` and
  Dependabot for uv, Actions and Docker.
- Earlier: repository scaffolding, and the constraints already settled by
  decisions elsewhere — cookie scoping, CORS, route versioning, and the CSP
  change the frontend needs before its first call to this service.

### Changed

- **Hosting is now an open decision rather than an assumption.** This file
  previously pointed at Cloudflare Workers plus D1, on the grounds that
  everything else here is free-tier serverless on Cloudflare. FastAPI closes
  that path — Cloudflare's Python Workers run under Pyodide and will not carry
  it with a real database driver. Recorded in `ARCHITECTURE.md`, including that
  this is the first component that will not be free.
- `/health` moved out from under `/v1`. It is operational, not part of the
  client contract, so the uptime monitor should not have to move when `/v2`
  ships.
- Dropped `fastapi[all]` for explicit extras. It pulled jinja2, orjson, ujson
  and python-multipart that nothing imports.
- Swapped `httpx` for `httpx2` in the dev group. Starlette's test client
  deprecated `httpx`; `filterwarnings = ["error"]` turned that into a failure
  now rather than a puzzle later.
- Earlier: the consumer of this API is `PaceStreak/app` on
  `app.pacestreak.com`, not the public site. `PaceStreak/landing` was renamed
  to `PaceStreak/web` and is now a permanently static marketing site that makes
  no authenticated requests, so the `connect-src` widening this API requires
  belongs in `app`.

### Fixed

- The health route was registered at `/heatlth`. Uptime monitoring against that
  path would have reported a permanent outage.
