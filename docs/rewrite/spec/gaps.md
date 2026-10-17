# Spec gaps: completeness audit against the code

Audited 2026-10-17 against `api/` HEAD and live `https://api.pacestreak.com/openapi.json`.

## Method

| Check | How | Result |
|---|---|---|
| Routes | `app.openapi()` paths (264 method+path pairs, 210 paths) plus grep for `include_in_schema=False` (2 hidden routes) = 266 `@router.*` decorators. Each normalised path (`{param}` -> `{}`, `/v1` optional) was searched in the specs on a line with its method. | All 266 covered. Live production OpenAPI is identical to local (diff empty). |
| Hidden routes | `POST /v1/notifications/unsubscribe/one-click`, `GET /v1/calendar/{token}.ics` | Both in specs (misc.md section 2, account.md item 14). |
| Framework routes | `GET /docs`, `GET /docs/oauth2-redirect`, `GET /openapi.json`, `GET /redoc` | **Missing**, see G1. |
| Modules under `app/` | Every `.py` (not `__init__`) searched by `dir/name`, `dir.name` or `name.py`; the three misses checked by content | All covered. `auth/dependencies.py` is auth.md "Auth dependency"; `common/codes.py` is core.md section 7 (`invite_code`); `training/race.py` is training-b.md 2j. |
| Worker jobs | `tick()` job list in `app/worker.py` (12 jobs) | All 12 in misc.md section 4, in the right order. |
| Env vars | Every `Settings` field and every `settings.<x>` reference | All covered. `smtp_*` appear as the grouped `SMTP_HOST/PORT/USER/PASSWORD` row in core.md section 3; `cors_origin_list` and `passkey_rp_id`/`passkey_origin` are derived properties described under CORS and `WEBAUTHN_RP_ID`/`FRONTEND_URL`. `PACESTREAK_PASSWORD` (CLI) and `PACESTREAK_ENV_FILE` covered. |
| Tables | `__tablename__` (60) vs `CREATE TABLE` in schema.md | All 60 present. schema.md adds `sync_seq` (a table emulating the PG sequence), intended. |
| Rate-limit buckets | 22 `enforce("…")` buckets + slowapi limits (`30/minute` x3, signup/login/mfa/password-email settings) | All covered. |
| Notification dedupe keys / kinds | every `dedupe_key=` and `kind=` literal | All covered. |
| Middleware / handlers | `main.py` | Covered in core.md 2.1/2.2. |
| Data migrations | alembic revisions with `op.execute`/`bulk_insert` | Covered (schema.md section 1 and open question 2). |

## G1. Auto-generated API docs are public in production (not in any spec)

`create_app()` builds `FastAPI(title=settings.app_name, version=settings.app_version, debug=settings.debug, lifespan=...)` without `docs_url=None` / `redoc_url=None` / `openapi_url=None`, so FastAPI serves four extra routes, unversioned, outside `/v1`, without auth, rate limit or `PaceStreak-Version` header (path does not start with `/v1`). Confirmed live: `https://api.pacestreak.com/docs` and `/openapi.json` return 200.

| Method | Path | Response |
|---|---|---|
| GET | `/openapi.json` | 200 `application/json`. OpenAPI `3.1.0`, `info: {title: "PaceStreak API", version: "0.1.0"}` (`APP_NAME`, `APP_VERSION` defaults; both env-overridable), 210 paths (hidden routes excluded), `components.securitySchemes.HTTPBearer = {type: "http", scheme: "bearer"}`. |
| GET | `/docs` | 200 `text/html`: Swagger UI page loading `swagger-ui-dist@5` JS/CSS from `cdn.jsdelivr.net` and favicon from `fastapi.tiangolo.com`; points at `/openapi.json`; `oauth2RedirectUrl: /docs/oauth2-redirect`. |
| GET | `/docs/oauth2-redirect` | 200 `text/html`: Swagger's static OAuth2 redirect helper. |
| GET | `/redoc` | 200 `text/html`: ReDoc page loading `redoc@2` from `cdn.jsdelivr.net`; points at `/openapi.json`. |

Who depends on it: nothing in `app/` (the frontend) reads `openapi.json` (grep found no use); no test asserts it; Upptime does not monitor it. Only `api/README.md` line 36 mentions "interactive docs at `/docs`" for local development.

Port options (owner decision; record the choice):

1. **Drop them** (simplest; README line updated). Unknown paths then return the Hono 404 `{"detail":"Not Found"}` (core.md 2.2).
2. **Keep `/openapi.json` only**, generated with `@hono/zod-openapi` from the same zod schemas used for validation, so the contract stays inspectable. Hidden routes must stay excluded. Matching the 3.1.0 document byte-for-byte is not a goal.
3. **Keep Swagger UI too** via `@hono/swagger-ui`. Note it loads from a CDN, which is fine on `api.` (no CSP header is set on API responses today) but would contradict the no-third-party-runtime stance if anyone extends CSP to the API host.

Recommendation: option 1 in production, option 2 or 3 behind `ENVIRONMENT != "production"` for local dev, matching how the README already frames `/docs` as a development aid.

## G2. Minor spec inconsistencies found (no missing behaviour)

- misc.md section 3 heading says "Admin, 9 routes"; the admin router has 8 (the note under the table already says 8). `/v1/admin/*` totals 11 because `client-errors` (GET, DELETE) and `abuse` come from `ops/router.py` (core.md 1.2).
- misc.md section 1 heading says "Nutrition, 17 routes"; there are 18 (the table and its footnote already say 18).
- misc.md section 2 says "Notifications, 11 routes": correct, it is 10 in OpenAPI plus the hidden `unsubscribe/one-click`.

## Totals for the porter

- 266 application routes = 264 in OpenAPI + 2 hidden. Plus 4 framework doc routes (G1).
- 60 tables (+ `sync_seq` helper in the D1 schema).
- 12 worker jobs, order: stats, nudges, habits, habit_snoozes, habit_summary, digest, challenges, backup, buddies, purge, housekeeping, error_alerts.
