# PaceStreak API on Cloudflare Workers: design proposal "maint"

Architect focus: long-term maintainability and correctness, without giving up any hard
requirement (free plan, performance, security parity, wire contract with `../app`).

Inputs read: spec/core.md, auth.md, schema.md, misc.md (§2 notifications, §4 worker, §5
hazards), gaps.md, plus targeted greps of account.md, training-a.md, game.md. Client
dependencies checked in `app/src/lib/api.ts`, `sync.ts`, `undo.ts`.

Versions below were checked against the npm registry on 2026-10-17 (`npm view`). Every one is
pinned exactly (no `^`) in `package.json`; Renovate raises bumps.

---

## 0. Decisions in one table

| Area | Decision |
| --- | --- |
| Runtime | One Worker, `api`, Hono router, `compatibility_date = "2026-10-01"`, **no `nodejs_compat`** (keeps the bundle small and forces Workers-native libs) |
| DB | D1 (one database per environment), Drizzle ORM schema as the single source of truth, drizzle-kit generates SQL, `wrangler d1 migrations apply` applies it |
| IDs | UUIDv7 as `TEXT` (the app already handles string UUIDs; time-ordered, safe tie-break) |
| Time | `TEXT` fixed-width UTC `YYYY-MM-DDTHH:MM:SS.sssZ` everywhere; dates `YYYY-MM-DD` |
| Validation / contract | Zod 4 + `@hono/zod-openapi`; every route is an OpenAPI route; FastAPI-shaped 422 |
| Passwords | PBKDF2-HMAC-SHA256, 100 000 iterations, 16-byte salt, 32-byte key, versioned encoding |
| JWT | HS256 via WebCrypto (`jose`), `kid`-selected key from a secret key ring |
| Sessions | New `sessions` table (one row per refresh family); auth = one indexed D1 query per request |
| Rate limits | Workers Rate Limiting binding for per-IP per-minute limits; D1 `rate_limits` UPSERT for per-user hour/day buckets |
| Background | `waitUntil` for request side effects; Cloudflare Queues for cron fan-out and delivery |
| Cron | 4 Cron Triggers (of 5) mapping all 12 jobs, each chunked through a Queue |
| Email | Cloudflare Email Service (`send_email` binding) behind an `EmailTransport` interface; console transport in dev/test |
| Push | Hand-written RFC 8291 + RFC 8292 on WebCrypto, verified against the RFC test vectors; host allowlist SSRF guard |
| Photos | R2 binding for head/get/delete, `aws4fetch` for presigned PUT/GET (unchanged client flow) |
| Tests | Vitest 4.1 + `@cloudflare/vitest-pool-workers`, isolated D1 per test, query-count budgets, app-contract test |
| Deploy | Workers Builds (Git-connected, like Pages): push to `main` applies migrations and deploys; custom domain `api.pacestreak.com` attached to the Worker |

---

## 1. Project layout and tooling

### 1.1 Repository

The rewrite lives in the existing `PaceStreak/api` repo on a long-lived branch `workers`, merged to
`main` at cutover (the Python tree moves to the tag `python-final` and is deleted from `main`).
Keeping the repo keeps the issue history, `SECURITY.md`, licence and the root submodule pin.

```text
api/
  package.json            pnpm, "type": "module", exact pins
  pnpm-lock.yaml
  tsconfig.json           strict app config
  tsconfig.test.json      extends, adds vitest + pool-workers types
  biome.json
  wrangler.jsonc          envs: (top-level = dev), staging, production
  drizzle.config.ts
  vitest.config.ts
  migrations/             generated SQL, committed, never hand-edited after merge
  scripts/                admin CLI (tsx scripts calling wrangler d1 execute / the admin API)
  src/
    index.ts              export default { fetch, scheduled, queue }
    app.ts                builds the Hono app (pure; tests import it)
    env.ts                Bindings + Vars types, parsed config (zod) cached per isolate
    platform/             thin wrappers; the only place that touches bindings
      db.ts               drizzle(d1), batch helpers, counted-D1 proxy for tests
      clock.ts            now(), iso(), injectable for tests
      crypto.ts           randomToken, sha256Hex, hmac, timingSafeEqual, base64url
      ratelimit.ts        ipLimit (binding), userLimit (D1)
      queue.ts            typed producers
      email/              transport.ts (interface), cloudflare.ts, console.ts, mime.ts, templates/
      push/               vapid.ts, ece.ts (RFC 8291), endpoint-guard.ts
      storage.ts          R2 head/get/delete + presign (aws4fetch)
      turnstile.ts
      tz.ts               Intl formatter cache, localDate, localHour, weekStart, isoWeek
    http/                 cross-cutting middleware and helpers
      cors.ts  version.ts  errors.ts  validation.ts  auth.ts  csrf.ts  cookies.ts  openapi.ts
    db/schema/            one file per module, re-exported from index.ts
    modules/
      <module>/
        routes.ts         createRoute() definitions + handlers (thin)
        service.ts        business logic, pure where possible, takes a Ctx {db, clock, env, defer}
        repo.ts           queries (prepared statements, batch builders)
        schemas.ts        zod request/response schemas (OpenAPI-registered)
        jobs.ts           cron/queue handlers owned by the module (if any)
        *.test.ts         colocated unit tests
    jobs/                 scheduler: cron -> queue fan-out, heartbeat
  test/
    setup.ts              apply migrations, fake email/push/turnstile/R2 presign
    helpers/              signup(), login(), authed client, soft WebAuthn authenticator, clock
    contract/             app wire-contract tests
    <area>/*.test.ts      ports of the pytest files, same names
```

Module list (matches the Python routers and the spec files): `ops`, `auth`, `passkeys`, `account`
(profile, export, import, calendar, deletion), `trash`, `training` (workouts, sync, sets,
exercises, routines, plans, gear, pauses, photos, importers), `game` (stats, snapshot,
achievements, leaderboards, recap), `habits`, `social` (follows, feed, kudos, comments, reports,
buddies, search), `groups` (groups, challenges), `nutrition`, `insights`/`coach`, `notifications`,
`admin`, `search`.

**Dependency rule** (enforced by a Biome `noRestrictedImports` config plus a 20-line script in CI
that parses imports): `modules/*` may import `platform/*`, `http/*`, `db/schema/*`, and another
module's `service.ts` only (never its `repo.ts` or `routes.ts`). `platform/*` imports nothing from
`modules/*`. Cycles fail CI (`madge --circular` is not needed; the script checks it).

### 1.2 Tooling (exact versions)

| Tool | Version | Why |
| --- | --- | --- |
| pnpm | 10.x via `packageManager` field + Corepack | strict, fast, lockfile-frozen CI |
| typescript | 6.0.3 | TS 7 (native) is three months old; drizzle/zod-openapi type perf on 7 is not yet proven. Upgrade is a one-line change once Renovate CI passes. |
| @cloudflare/workers-types | generated instead: `wrangler types` writes `worker-configuration.d.ts` (committed, checked in CI for drift) | types always match `wrangler.jsonc` bindings |
| wrangler | 4.151.1 | |
| @biomejs/biome | 2.5.15 | lint + format in one fast tool, no Prettier/ESLint config sprawl (owner memory: no Prettier in `app`) |
| vitest | 4.1.12 | peer range of pool-workers 0.23.0 is `^4.1.0`; do not take vitest 5 until pool-workers supports it |
| @cloudflare/vitest-pool-workers | 0.23.0 | tests run inside workerd with real D1/R2/Queues bindings |
| drizzle-kit | 0.31.11 | |

`tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`,
`module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2024"`, `lib: ["ES2024"]`,
`types: ["./worker-configuration.d.ts"]`, `noEmit` (wrangler's esbuild bundles).

Build: no separate bundler; `wrangler deploy` (esbuild) with `minify: true`, `--outdir dist` in
CI for the size check. Budget: **< 350 KiB gzipped** (free plan limit is 3 MiB; small bundles
start faster). CI fails above it.

### 1.3 Wrangler config (shape)

```jsonc
{
  "name": "pacestreak-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "minify": true,
  "placement": { "mode": "smart" },          // runs the Worker next to D1: multi-query handlers pay ~1 ms per query, not cross-ocean RTT
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "d1_databases": [{ "binding": "DB", "database_name": "pacestreak-dev", "database_id": "...", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "pacestreak-photos-dev" }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "pacestreak-jobs-dev" }, { "binding": "DELIVERY", "queue": "pacestreak-delivery-dev" }],
    "consumers": [
      { "queue": "pacestreak-jobs-dev", "max_batch_size": 1, "max_retries": 3, "dead_letter_queue": "pacestreak-dlq-dev" },
      { "queue": "pacestreak-delivery-dev", "max_batch_size": 10, "max_batch_timeout": 5, "max_retries": 5, "dead_letter_queue": "pacestreak-dlq-dev" }
    ]
  },
  "ratelimits": [
    { "name": "RL_SIGNUP", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
    { "name": "RL_LOGIN", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_MFA", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_PASSWORD_EMAIL", "namespace_id": "1004", "simple": { "limit": 3, "period": 60 } },
    { "name": "RL_30", "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } }
  ],
  "send_email": [{ "name": "EMAIL" }],
  "triggers": { "crons": ["*/5 * * * *", "2 * * * *", "17 * * * *", "40 3 * * *"] },
  "vars": { "ENVIRONMENT": "development", "COOKIE_SECURE": "false", "CORS_ORIGINS": "http://localhost:5173", "...": "..." },
  "env": {
    "staging":    { "...": "same keys, staging resources, routes: api-staging.pacestreak.com (custom_domain: true)" },
    "production": { "...": "production resources, routes: [{ pattern: 'api.pacestreak.com', custom_domain: true }], workers_dev: false, preview_urls: false" }
  }
}
```

Environments: **dev** = `wrangler dev` with local D1/R2/Queues (Miniflare), console email,
Turnstile test keys; **staging** = a real deployment from the `staging` branch used by the cutover
rehearsal and by app PR previews if wanted (its custom domain is attached only when it is first
deployed, per the "no DNS ahead of deployments" rule); **production**. Secrets
(`JWT_KEYS`, `TOTP_KEY`, `RECOVERY_PEPPER`, `UNSUBSCRIBE_KEY`, `VAPID_PRIVATE_JWK`,
`TURNSTILE_SECRET_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `IP_HASH_KEY`) are set with
`wrangler secret put --env <env>`; `.dev.vars` is gitignored and a `.dev.vars.example` is
committed. Config is parsed once per isolate by a zod schema in `env.ts`; in production the
schema enforces the old `_check_production_config` rules (secure cookie, https PUBLIC_API_URL,
Turnstile secret set, real email transport, no `*` in CORS origins) and a failure returns 500 on
every request with one log line, which Upptime catches immediately.

Plan-agnostic: nothing in code reads "the plan". Limits that depend on it (`JOB_CHUNK_SIZE`,
`DELIVERY_BATCH`, `PBKDF2_ITERATIONS` is fixed by the platform) are `vars`; moving to paid is
`"limits": {"cpu_ms": ...}` plus bigger chunk vars.

---

## 2. Libraries (runtime)

| Package | Version | Use | Workers status |
| --- | --- | --- | --- |
| hono | 4.13.12 | router, middleware, cookies, `hono/client` RPC types | first-class Workers support; 4.13.13 is a week old, take .12 (two-week rule) |
| zod | 4.6.7 | all validation, config parsing | pure JS |
| @hono/zod-openapi | 1.6.3 | typed routes + OpenAPI doc from the same schemas (peer: zod ^4, hono >=4.10) | pure JS |
| drizzle-orm | 0.45.4 | D1 driver, typed queries, `db.batch` | official D1 driver. 1.0 is RC; stay on 0.45 until 1.0 GA |
| jose | 6.2.12 | JWT sign/verify (WebCrypto only in v6) | built for Workers |
| @simplewebauthn/server | 14.0.3 | passkey registration/authentication | v13+ uses WebCrypto, no Node deps; verify in the first spike test (soft authenticator) |
| aws4fetch | 1.0.20 | SigV4 presign for R2 | last release 2024, but 6 KB, zero deps, recommended in R2 docs; stable spec, low risk |
| fflate | 0.8.3 | zip for CSV export / backup attachment, unzip on import | pure JS, streaming |
| uuidv7 | 1.2.1 | IDs | pure JS (could be 15 lines in-house; the package is tiny and tested) |

Deliberately **not** used: argon2/bcrypt WASM (CPU), `web-push` (Node-only), `nodejs_compat`
polyfills, `papaparse` (CSV parsing for importers is a 60-line RFC 4180 parser with tests; the
importers only need comma/semicolon detection), a TOTP library (30 lines on WebCrypto HMAC-SHA1),
`ipaddr.js` (not needed with the allowlist guard), any date library (Intl + 100 lines in
`platform/tz.ts`).

---

## 3. D1 schema strategy

### 3.1 Source of truth and migrations

- Drizzle schema in `src/db/schema/<module>.ts`, re-exported from `index.ts`; `schema.md` §1.2 is
  the porting checklist (60 tables + `sync_seq`).
- Since there is no data, migration `0000_init.sql` is generated fresh from the Drizzle schema.
  Afterwards: `pnpm db:generate` (drizzle-kit) writes `migrations/NNNN_name.sql`; CI runs
  `drizzle-kit check` and a "schema drift" test that applies all migrations to an empty D1 and
  compares `sqlite_master` against what drizzle-kit would generate (replaces `alembic check`).
- **Expand/contract only**: migrations apply before the new code deploys (section 12), so every
  migration must work with the currently deployed code. Destructive changes ship in two deploys.
- `PRAGMA foreign_keys` is on in D1; every FK to `users` is `ON DELETE CASCADE` (account purge
  relies on it).

### 3.2 Column conventions

| Concern | Decision | Reason |
| --- | --- | --- |
| Primary key | `id TEXT PRIMARY KEY` UUIDv7, generated in JS (`$defaultFn`) | client JSON keeps string ids; time-ordered so `ORDER BY created_at, id` is a stable tie-break |
| Timestamps | `TEXT NOT NULL`, always written by `clock.iso()` = `Date#toISOString()` (fixed-width ms, `Z`) via a Drizzle `customType` `isoTimestamp` that serialises `Date` <-> string; `updated_at` via `$onUpdate` | fixed width makes lexicographic order = time order, indexes and `<`/`>` comparisons work; human-readable in `wrangler d1 execute`; JSON output is the same string (the app parses with `Date`; pydantic's `+00:00`/µs form is not depended on, verified by grep: no format-specific parsing in `app/src/lib`) |
| Dates | `TEXT` `YYYY-MM-DD` | lexicographic = chronological |
| Enums | `TEXT` + `CHECK (col IN (...))`, Drizzle `text({ enum: [...] })` so TS gets a union | |
| Booleans | `integer({ mode: 'boolean' })` | |
| JSON | `text({ mode: 'json' }).$type<T>()`, and **a zod schema per JSON column** applied on write; reads trust the DB | no JSON operators are used in SQL (schema.md §2 #5) |
| Arrays (`ARRAY(String)`) | JSON text default `'[]'` | |
| Binary (passkey public key) | `blob({ mode: 'buffer' })` -> `Uint8Array` | |
| Lengths | zod `.max(n)` on every input mirroring the old varchar sizes; no CHECK(length) | over-length input becomes a 422 instead of the old accidental 500 (DataError) |
| Floats | `real`; output rules (Python `%g`, banker's rounding) live in `platform/format.ts` with tests | |

### 3.3 Case-insensitive search and collation

SQLite `LIKE`/`lower()` are ASCII-only. Decision: **shadow "fold" columns** maintained by the
repo layer: `email` is stored already folded (lower-cased, unique index); `profiles.handle_fold`,
`foods.name_fold`, `recipes.name_fold`, `habits.name_fold`, `routines.name_fold`,
`groups.name_fold`, `custom_exercises.name_fold` hold `s.normalize('NFKC').toLowerCase()`, each
indexed. Queries use `name_fold LIKE ? ESCAPE '\'` with the pattern folded the same way, and a
shared `likePattern(term, mode)` helper does escaping (`\`, `%`, `_`). Prefix search (`term%`)
uses the index. `ORDER BY name` becomes `ORDER BY name_fold, name` (case-insensitive, matching
what a user expects, and Unicode-correct). NULL ordering is written explicitly (`NULLS LAST` /
`NULLS FIRST`) wherever schema.md §2 #22-23 lists a nullable sort key.

### 3.4 Replacing Postgres-only behaviour

| Postgres feature | Replacement |
| --- | --- |
| Interactive transactions | **Rule: reads first, then one `db.batch([...writes])`** (atomic, one round trip). Check-then-insert races are closed by UNIQUE constraints and the global 409 mapping. A lint-ish helper `writeBatch(ctx, stmts)` is the only way modules commit, so the pattern is visible in review. |
| `pg_advisory_xact_lock` around `recompute()` | Optimistic concurrency: `user_stats.rev INTEGER`. Recompute reads stats (incl. `rev`), computes, then batches `UPDATE user_stats SET ..., rev = rev + 1 WHERE user_id = ? AND rev = ?` first and makes every following statement in the batch conditional on `changes() = 1` via `INSERT ... SELECT ... WHERE (SELECT rev FROM user_stats WHERE user_id = ?) = ? + 1`. A lost race retries once, then gives up (the next write or the hourly stats job converges). Level-up/badge notifications additionally carry dedupe keys (`level:{n}`, `badge:{id}:{tier}`) with `ON CONFLICT DO NOTHING`, so the "one level-up notification under concurrency" test holds even without the guard. No Durable Object needed. |
| Savepoint per outbox op (`/sync` flush) | Validate every op first (pure), then one `db.batch` per op; per-op errors collected into `results[]`. Ops are capped at 100 by the client; each batch is one round trip, so a 100-op flush is 100 round trips (~100 ms wall, little CPU). Optimisation once measured: group consecutive valid ops into one batch and fall back to per-op only when the group batch fails. |
| `sync_seq` sequence | Single-row table `sync_seq(id=1, value)`; every workout write batch starts with `UPDATE sync_seq SET value = value + 1 WHERE id = 1` and uses `(SELECT value FROM sync_seq WHERE id = 1)` in the workout statement (schema.md §2.1). D1 serialises writes, so it is strictly monotonic. |
| `ON CONFLICT ON CONSTRAINT name` | column-list targets (`onConflictDoUpdate({ target: [...] })`), partial-index target for single badges (`where: isNull(t.tier)`) |
| `timezone(tz, now())` in SQL | `platform/tz.ts`: `SELECT DISTINCT timezone FROM profiles` (covered by an index), compute each zone's local hour/date in JS with cached `Intl.DateTimeFormat`, then `WHERE timezone IN (...)` (chunked at 90 binds) |
| `date_trunc('week')` | `date(substr(created_at,1,10), 'weekday 0', '-6 days')` |
| catalog-driven account merge | static, generated list of `(table, column)` FKs to `users` exported from the Drizzle schema (a test asserts it matches `pragma_foreign_key_list`), then `UPDATE OR IGNORE ... ; DELETE ...` per table in one batch |
| Redis | see §6 (rate limits), §5 (session state), §7 (caches), §8 (locks) |

### 3.5 Indexes and precomputation

Every foreign key gets an index; every list endpoint has a covering composite index matching its
`WHERE user_id = ? ORDER BY ...` (e.g. `workouts(user_id, seq)`, `workouts(user_id, local_date)`,
`notifications(user_id, created_at DESC)`, `habit_logs(habit_id, day)`, `activities(user_id,
created_at)`, `profiles(timezone)`, `habits(remind_hour) WHERE remind_hour IS NOT NULL`,
`habits(snoozed_until) WHERE snoozed_until IS NOT NULL`, `profiles(deletion_scheduled_at) WHERE
... IS NOT NULL`, leaderboard `user_stats(season_xp)` etc.). A test runs `EXPLAIN QUERY PLAN` on
every prepared statement registered in repos and fails on `SCAN` of a user-data table without an
explicit `// scan-ok:` annotation.

Precomputed: `user_stats` (streaks, XP, level, `recent_weeks`) is the read model for `/me/*`,
feeds and leaderboards; it is recomputed on write (inline when cheap, see §13) and by the hourly
stats job. `personal_records` likewise.

---

## 4. Request pipeline

Order (outermost first), all in `src/http/`:

1. **`version`**: sets `PaceStreak-Version: 1` on every response whose path starts with `/v1`
   (including preflight, 422, 429, 500).
2. **`cors`** (custom, 40 lines, to match Starlette): explicit origin list from `CORS_ORIGINS`
   (zod refuses `*`); preflight 200 `OK` echoing `Access-Control-Request-Headers`, methods list,
   `Max-Age: 600`, `Vary: Origin`; disallowed preflight 400 `Disallowed CORS origin`; actual
   requests from allowed origins get `Allow-Origin` + `Allow-Credentials: true` + `Vary: Origin`.
   It wraps the error handler, so 500s carry CORS headers.
3. **`requestContext`**: request id (`cf-ray`), client IP (`CF-Connecting-IP`, truncated 45), UA
   (400 code points), `ctx.defer = (p) => executionCtx.waitUntil(p)`, `db`, `clock`, parsed config.
4. **IP rate limit** (per route, declared in route metadata, see §6).
5. **Turnstile** (per route metadata, before body parsing of the rest; token read from the
   validated body).
6. **Auth** (route metadata: `public | optional | user | dbUser | admin | moderator`).
7. **CSRF** on `/v1/auth/refresh` and `/v1/auth/logout` only (cookie vs `X-CSRF-Token`,
   constant-time; 403 `Invalid CSRF token`), runs before body/cookie checks as today.
8. **Validation** (`@hono/zod-openapi`, params/query/body), then the handler.

Error handling:

- `HttpError(status, detail, headers?)` thrown by services; `app.onError` renders
  `{"detail": ...}`.
- D1 errors whose message contains `UNIQUE constraint failed`, `FOREIGN KEY constraint failed`,
  `CHECK constraint failed` or `NOT NULL constraint failed` -> 409
  `{"detail":"That was saved twice at once. Try again."}` (route-level overrides, e.g. trash
  restore's "Something already exists in its place").
- Anything else -> log `{level:"error", msg:"Unhandled error", method, path, err}` -> 500
  `{"detail":"Something went wrong on our side. Try again in a moment."}`.
- `app.notFound` -> 404 `{"detail":"Not Found"}`; wrong method -> 405
  `{"detail":"Method Not Allowed"}` + `Allow`.
- IP limit -> 429 `{"error":"Rate limit exceeded: 10 per 1 minute"}` (kept: the app falls back to
  its own "too many" text when `detail` is absent, `api.ts:119`); user-bucket limit -> 429
  `{"detail":"Slow down - try again in a little while."}`.

**422 shape**: the `defaultHook` converts Zod issues to FastAPI's
`{"detail":[{"type","loc":["body"|"query"|"path", ...path],"msg","input"}]}`. The app only reads
`detail[0].loc` (minus `"body"`) and `detail[0].msg`, stripping a `Value error, ` prefix
(`app/src/lib/api.ts:109-117`), so messages are written for humans per field (zod `error`
option), not copied from pydantic. Unknown body keys are stripped, not rejected (pydantic default).
Lax coercions that pydantic did and the app relies on (numeric strings in query params) use
`z.coerce` only for query/path params.

OpenAPI: `/openapi.json` is generated from the routes but served **only outside production**
(gaps.md G1, option 1 in prod). No Swagger UI (it would load from a CDN).

Typed client: `export type AppType = typeof routes` is published from `src/app.ts`; the app can
adopt `hono/client` later. Not required for cutover, and the contract test (§11.4) guards the
wire meanwhile.

---

## 5. Auth design

### 5.1 Passwords

PBKDF2-HMAC-SHA256 via `crypto.subtle.deriveBits`, **100 000 iterations** (Workers' maximum),
16-byte random salt, 32-byte output. Stored as `pbkdf2-sha256$100000$<salt b64url>$<hash
b64url>` so a future change (e.g. if Workers raises the cap, or Argon2 becomes native) is a
rehash-on-login, not a migration. Verification is constant-time; unknown email still derives
against a dummy hash (timing parity). Measured budget: PBKDF2 runs in native BoringSSL, roughly
3-6 ms CPU for 100k SHA-256 iterations on Workers hardware. That is the single most expensive
operation in the API and it only happens on signup, login, change-password, reset,
delete-account and passkey registration (password re-auth). **Day-one task: a staging benchmark
route (removed after) that runs 20 derivations and logs `cpuTime` from the tail; if the p99 for
login exceeds 9 ms, drop to 60 000 iterations and record it in `DECISIONS.md`** (the
free plan's limit is enforced on average with burst headroom, so a 9 ms login is safe).
Minimum password length and the CLI rule stay as in auth.md.

### 5.2 Tokens

- **Access JWT: HS256**, 15 minutes, claims unchanged (`sub, type:"access", ver, sid, jti, iss,
  aud, iat, exp`), header `kid`. RS256 existed so other services could verify; nothing else
  verifies these tokens, and HMAC verify is ~20x cheaper than RSA on every request. Key ring
  secret `JWT_KEYS = {"current":"k2026a","keys":{"k2026a":"<b64 32 bytes>"}}`; rotation = add a
  key, switch `current`, remove the old one after 15 minutes. The app never decodes the JWT
  (only `expires_in` from the body), confirmed in `app/src/lib/api.ts`.
- **MFA challenge JWT**: same, `type:"mfa"`, 5 minutes.
- **Refresh token**: 64 random bytes base64url, stored as SHA-256 hex in `refresh_tokens`
  (`family_id`, `parent_id`, `replaced_by`, `expires_at`, `revoked_at`). Rotation and the 30 s
  reuse-grace walk are ported exactly (auth.md §4). Reuse outside grace burns the family.
  Rotation writes are one batch: revoke old + insert new + update `sessions.last_used_at`.
- **Cookies**: `__Secure-refresh_token` (HttpOnly) and `__Secure-csrf_token` (readable),
  `Path=/v1/auth`, `Domain=pacestreak.com`, `Secure`, `SameSite=Lax`, `Max-Age=604800`; bare
  names when `COOKIE_SECURE=false` (dev). Deletion emits the identical name/path/domain.

### 5.3 Sessions and revocation (replaces Redis denylist + user cache)

New table `sessions(id = family_id, user_id, created_at, last_used_at, user_agent, ip,
revoked_at)`; `refresh_tokens.family_id` references it. Logout, logout-all, rotation burn and
password change set `sessions.revoked_at` (and `users.token_version + 1` where the old code did).
The auth middleware runs **one** query on the primary:

```sql
SELECT u.id, u.email, u.role, u.is_active, u.is_verified, u.token_version, s.revoked_at
FROM users u JOIN sessions s ON s.id = ?2 AND s.user_id = u.id
WHERE u.id = ?1
```

No row / inactive / revoked / `ver` mismatch give the same 401 details as today. This is
strongly consistent (logout is immediate everywhere, which KV could not guarantee), costs one
indexed point lookup (~0.1 ms CPU), and replaces both Redis keys. No in-isolate cache: a stale
cache would reintroduce the eventual-consistency hole. `GET /v1/auth/sessions` lists `sessions`
directly instead of grouping refresh rows.

### 5.4 TOTP and recovery codes

- TOTP: SHA-1, 6 digits, 30 s, window ±1, replay guard via `totp_last_used_step` (ported
  exactly). Implemented in `modules/auth/totp.ts` on WebCrypto HMAC-SHA1, tested against RFC 6238
  vectors. Secret (20 random bytes, base32) encrypted at rest with **AES-256-GCM** (`TOTP_KEY`
  secret, 12-byte random IV, stored `v1.<iv>.<ct>`); the version prefix allows key rotation.
- Recovery codes: same format `XXXXX-XXXXX` (32-symbol alphabet, 50 bits). Because they are
  high-entropy random values, a slow hash adds nothing: store **HMAC-SHA256(RECOVERY_PEPPER,
  normalized code)** with a unique index on `(user_id, code_hash)`; verify is a single indexed
  `UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
  RETURNING id`. That replaces "up to 10 Argon2 verifies" with one query.

### 5.5 Email codes

6-digit codes, SHA-256 stored, 15/60-minute expiry as in config, issuing a new one marks older
ones used. **Fix**: the attempts counter is persisted on failure (the Python rollback made the
5-attempt limit ineffective, auth.md open question 1); after 5 failures the code is dead. Lookup
is one query joining `users` (folded email) and `one_time_tokens(user_id, purpose, used_at,
expires_at)`.

### 5.6 Passkeys

`@simplewebauthn/server` 14.0.3, `rpID = pacestreak.com` (config), `expectedOrigin =
https://app.pacestreak.com`, `requireUserVerification: true`, attestation `none`. Challenges
live in `webauthn_challenges` and are consumed with `DELETE ... RETURNING` (single use). The
Python test suite's soft authenticator is ported to `test/helpers/softAuthenticator.ts` (ES256 via
WebCrypto) so all 10 passkey tests run.

---

## 6. Rate limiting

Two mechanisms, chosen by window length, both behind `platform/ratelimit.ts`:

1. **Per-IP, per-minute (signup 5, login 10, MFA 10, password-email 3, client-errors/habit
   action/nutrition lookup 30)**: Workers **Rate Limiting binding** (`ratelimits` in wrangler; a
   namespace per limit; key = `${routeId}:${ip}` to keep slowapi's per-endpoint semantics). Zero
   storage writes, sub-millisecond, no D1 load on the hottest abuse path. It is per-location and
   approximate, which is acceptable for abuse throttling (Turnstile is the real guard on these
   routes).
2. **Per-user buckets with 10 min/1 h/1 day windows** (the 22 `enforce()` buckets): D1 table
   `rate_limits(key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER)` and one statement:

   ```sql
   INSERT INTO rate_limits(key, window_start, count) VALUES (?1, ?2, 1)
   ON CONFLICT(key) DO UPDATE SET
     count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
     window_start = excluded.window_start
   RETURNING count
   ```

   `window_start = floor(now / window)`. Strongly consistent, fixed-window like the old Redis
   code, fails open on D1 error (as before). Housekeeping deletes stale rows daily. KV is
   rejected (1000 writes/day on free, eventually consistent). These buckets sit on low-frequency
   social/write routes, so the extra round trip is acceptable; where the route already writes,
   the limiter statement is issued in a `db.batch` together with the route's reads.

`auth_failures` (abuse view) stays a D1 table written via `defer` (off the request path).

---

## 7. Caching

- **No KV** in the request path (write quota, eventual consistency). KV is not provisioned.
- **Cache API** (`caches.default`, free, per-location) for: barcode lookups against Open Food
  Facts (key = barcode, 7 days; plus the persistent `foods` table as today), leaderboards (60 s,
  key includes board and season; the caller's own row is fetched separately), the `.ics`
  calendar feed (5 min, keyed by token hash, `Cache-Control: private` to the client).
- All authenticated JSON responses send `Cache-Control: no-store`.
- Per-isolate memo (module-scope `Map`) only for immutable data: parsed config, imported
  `CryptoKey`s, `Intl.DateTimeFormat` per timezone, exercise library.

---

## 8. Background work

### 8.1 Request side effects

`ctx.defer(promise)` (= `waitUntil`) for: notification delivery triggered by a request
(push/email via `deliver(ids)`), `auth_failures` writes, security-event emails, R2 object
deletes after a row delete, activity fan-out. Rule: anything the response does not depend on is
deferred. Deferred work that may exceed the free plan's 50-subrequest budget (fan-out to many
followers' devices) enqueues to `DELIVERY` instead of sending inline.

### 8.2 Queues

- `JOBS` (batch size 1): one message = one chunk of one job (`{job, params, cursor}`). Each
  consumer invocation has its own CPU and subrequest budget, which is what makes the 12 jobs fit
  the free plan.
- `DELIVERY` (batch 10): one message = one notification id; the consumer loads the notification
  + prefs + push subscriptions in one batch query, sends push and/or email, deletes dead
  subscriptions (404/410). At-least-once is made safe by `notifications.delivered_at` (checked
  and set per channel).
- DLQ `pacestreak-dlq` is inspected via `wrangler queues` and surfaces in `/health/worker` as a
  count.

### 8.3 Cron mapping (4 of the 5 free Cron Triggers; one spare)

| Cron | Jobs (spec order kept within each tick) | Notes |
| --- | --- | --- |
| `*/5 * * * *` | habit_snoozes, error_alerts | snoozes need 5-minute resolution; error_alerts keeps its 1-hour gate via `worker_heartbeats.next_error_alert_at` |
| `2 * * * *` | nudges, habits, habit_summary, digest, backup, buddies | the local-hour jobs. Python re-fired every tick inside the hour and relied on dedupe; firing once per hour is equivalent for delivery and removes the "reminder later in the same hour after a deduped risk" quirk (misc.md §4 job 2), which is recorded as an intentional change |
| `17 * * * *` | stats (refresh_stale_stats), challenges (resolve) | |
| `40 3 * * *` | purge (deleted accounts + R2 objects), housekeeping (old notifications, trash, challenges, auth_failures, client_errors, rate_limits, expired sessions/refresh rows) | |

Scheduler flow (`src/jobs/scheduler.ts`): `scheduled(event)` maps the cron string to its job list,
computes inputs once (e.g. zones whose local hour is H, via `SELECT DISTINCT timezone`), and
enqueues chunk messages (`JOB_CHUNK_SIZE` users, default 50 on free). The consumer runs the job
for one chunk with batched reads (one `db.batch` of SELECTs for the whole chunk, never per user),
writes notifications with `INSERT ... ON CONFLICT(user_id, dedupe_key) DO NOTHING RETURNING id`,
and enqueues returned ids to `DELIVERY`. Every job is idempotent through dedupe keys
(`risk:{chain}:{date}`, `reminder:{date}`, `habit:{id}:{date}`, `habit-snooze:{id}:{dueIso}`,
`habit-summary:{date}`, `digest:{week}`, `backup:{period}`, `buddy-risk:{pair}:{buddy}:{week}`)
or natural idempotence (stats, purge, housekeeping, challenges' `resolved_at`).
No tick lock: a cron cannot overlap itself meaningfully because the scheduler only enqueues
(milliseconds), and duplicates are absorbed by dedupe keys. Heartbeat: one `worker_heartbeats`
row per cron (`last_tick_at`, `jobs` report, `failing_ticks`) updated by the scheduler and by
consumers on error. `/health/worker` reports 503 when the `*/5` row is older than 15 minutes.

---

## 9. Email

**Decision: Cloudflare Email Service (Email Sending) via the `send_email` binding**, from
`no-reply@pacestreak.com`, behind `EmailTransport { send(msg): Promise<void> }`. Reasons: the
owner wants Cloudflare where sensible, it is a binding (no secret, no SMTP from Workers), and
the domain is already on Cloudflare (SPF/DKIM records are added by the onboarding flow). Brevo
SMTP cannot be used from Workers without hand-rolled SMTP over `cloudflare:sockets`, which is
not worth maintaining. `mime.ts` builds the same message as today (text + optional HTML as
multipart/alternative, attachments as multipart/mixed, `Auto-Submitted`, `List-Unsubscribe` +
`List-Unsubscribe-Post` one-click, `Message-ID`, `Date`); templates are ported verbatim with
`APP_NAME` set to `PaceStreak` in production (the "PaceStreak API" subject default is a bug,
core.md open question 1). Console transport in dev and tests logs the old
`[email:console] to=... subject=...` line so ported tests read codes the same way.

Sends happen in `defer` (request-triggered codes) or the `DELIVERY` consumer (notifications),
so a slow provider never delays a response. Retries come from the queue (5 attempts, backoff),
not `sleep`.

Risk and fallback: verify Email Sending's free-plan quota, sending to arbitrary recipients and
attachment support during phase 0; if any blocks, the fallback is a `BrevoHttpTransport` (Brevo
transactional HTTP API, existing account and domain authentication, still 300/day), a 40-line
adapter swap. The backup attachment (zip up to 10 MiB) is the feature most likely to hit a size
limit; above the provider's limit it falls back to the existing "link" email.

---

## 10. Push, photos, imports/exports

### 10.1 Web Push

`platform/push/` implements RFC 8291 (aes128gcm: ECDH P-256, HKDF-SHA256, AES-128-GCM, one
record) and RFC 8292 (VAPID ES256 JWT, `vapid t=..., k=...`) on WebCrypto, ~200 lines, unit
tested against RFC 8291 Appendix A vectors and an end-to-end decrypt test. A fresh VAPID key is
generated (no users, no subscriptions to keep) and stored as `VAPID_PRIVATE_JWK`; the public key
is served by the existing route. Each send: `fetch(endpoint, {method:"POST", redirect:"manual",
signal: AbortSignal.timeout(10_000)})`, TTL and urgency headers as before; 404/410 deletes the
subscription.

**SSRF guard without DNS**: an endpoint is accepted only if it parses as `https:`, has no
credentials, port 443 or empty, a hostname that is **not** an IP literal, and the hostname
matches the push-service allowlist: `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`*.push.apple.com`, `*.notify.windows.com`. Rejection is 422 at subscribe. This is stricter than
the old resolve-and-check (which also allowed any public IP), needs no DoH round trip, and
Workers' `fetch` cannot reach private networks anyway. `redirect: "manual"` prevents a redirect
pivot. The allowlist lives in config so a new browser vendor is a vars change.

### 10.2 Body photos (R2)

Unchanged client flow: `POST /body-photos/{id}/upload` returns an `aws4fetch` presigned PUT
(300 s, signed `Content-Type`) to `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`;
`.../upload/complete` uses the binding: `head` (size <= 2 MiB), ranged `get` of the magic bytes,
upsert row. GET returns a 60 s presigned GET with `response-cache-control=private, no-store`.
Deletes use the binding (`delete(keys[])`, <= 1000 per call). R2 CORS on the bucket allows PUT
from `https://app.pacestreak.com` only. The app's CSP `connect-src` must add the R2 S3 host:
check `app/public/_headers` (it already allows the R2 host for the current presign flow, verify
in phase 0).

### 10.3 Exports and imports under CPU limits

- **Export JSON** (`/me/export?format=json`): all reads in one or two `db.batch` calls, rows
  written with a `ReadableStream` that serialises table by table, so peak memory and CPU per
  chunk stay small. `format=ics`: same, streamed.
- **Export CSV** (zip): fflate streaming `Zip` with `ZipDeflate` level 1 for CSV and
  `ZipPassThrough` (stored) for photos fetched from R2 as streams. Response is streamed.
  Expected CPU for a typical account is a few ms; for very large histories it can exceed 10 ms on
  free. Mitigation is staged: if Workers Logs show exports exceeding CPU, `/me/export` keeps its
  contract but the backup-email path (cron) is the one that moves to a `JOBS` consumer; the
  paid-plan switch removes the limit entirely.
- **Imports** (`/me/import`, training importers, habit importer): request parses and validates
  the whole file (size capped as in the spec), then writes in `db.batch` chunks of 100
  statements (D1 binding limit per statement: 100 bound params, so multi-row INSERTs are sized
  `floor(100 / columns)` rows each). Import is idempotent (fill-gaps-never-overwrite), so a
  timeout halfway is recoverable by retrying. If a file exceeds `IMPORT_INLINE_MAX_ROWS`
  (var, default 2000 on free), the request stores the file in R2 under `imports/{user}/{id}`,
  enqueues a `JOBS` message and returns the same 200 body with counts computed so far plus
  `"queued": true`; this is the only additive change to the wire and the app shows a toast
  for it in a follow-up (unknown keys are ignored by the current app).

---

## 11. Observability and testing

### 11.1 Observability

- Workers Logs enabled (`observability.enabled`), structured JSON lines via a 30-line logger
  (`level, msg, reqId, route, userId?, durMs, d1Queries, status`). One access log line per
  request with the D1 query count (from the counting wrapper, also used in tests), so N+1
  regressions show in production logs.
- `wrangler tail --env production --format json` for live debugging; CPU time per invocation
  is in the tail/Logs.
- `/health` (static `{"status":"healthy"}`), `/health/ready` (`SELECT 1`), `/health/worker`
  (heartbeat age, DLQ count; no `jobs` key) unchanged and still monitored by Upptime.
- `POST /v1/client-errors` and the admin views unchanged; error_alerts emails admins.
- No third-party analytics or APM.

### 11.2 Test stack

Vitest 4.1.12 + `@cloudflare/vitest-pool-workers` 0.23.0, `isolatedStorage: true` (fresh D1/R2
per test file and rolled back per test, replacing TRUNCATE). `test/setup.ts` applies
`migrations/` with `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (read in `vitest.config.ts`
via `readD1Migrations`). Outbound `fetch` (Turnstile, Open Food Facts, push services) is
intercepted with `fetchMock` from `cloudflare:test`; email uses the console transport capture;
clock is injectable (`ctx.clock`) so expiry and local-hour jobs are tested deterministically.
Cron and queue handlers are invoked directly with `createScheduledController` /
`createMessageBatch` + `getQueueResult`.

### 11.3 Porting the 285 pytest cases

Each pytest file becomes `test/<area>/<same_name>.test.ts`, test names kept (snake_case ->
sentence) so a script can diff the two lists; CI prints "ported N/285". Fixtures from
`conftest.py` become helpers (`signup`, `login`, `authed(c)`, `verifyEmail`, soft authenticator,
fake storage). Tests that asserted Postgres internals are replaced by D1 equivalents (advisory
lock -> concurrent recompute via `Promise.all` with the OCC guard; TRUNCATE helpers dropped).
Intentional behaviour changes (§14) each get a test asserting the new behaviour, named
`changed: ...`.

### 11.4 Query-count budgets and contract tests

- `platform/db.ts` wraps the D1 binding in tests and logs: counts `prepare().run/all/first` and
  `batch` (a batch counts as one round trip). Tests call `expectQueries(n, () => request)`.
  Every endpoint class has a budget (§13); a parametrised test hits each route with a seeded
  "heavy" user (500 workouts, 30 habits, 200 follows) and asserts the budget, so N+1 cannot
  creep in.
- **App contract test**: CI checks out `PaceStreak/app` at `main`; a script extracts every
  `api("/...")`/`fetch(\`${API_BASE}/v1...\`)` path+method from `app/src` (regex over the call
  sites, plus `lib/types.ts` interface names) and asserts each one is a registered route; a
  second suite validates sample responses of each route against the response zod schema and
  against the corresponding TypeScript interface in `app/src/lib/types.ts` via a generated
  `tsc` type-check (`satisfies`). This catches shape drift in both directions.
- Optional (phase 4): Playwright e2e of `../app` against `wrangler dev` with local D1.

---

## 12. CI/CD, deploy, retirement

### 12.1 CI (GitHub Actions, `api` repo)

`ci.yml` on PR and push: `pnpm install --frozen-lockfile` -> `biome ci` -> `wrangler types
--check` (binding types not stale) -> `tsc --noEmit` -> `drizzle-kit check` + migration drift
test -> `vitest run` (incl. query budgets) -> app contract job -> `wrangler deploy --dry-run
--outdir dist` + bundle size check (< 350 KiB gz) -> gitleaks. The "no AI credit in commits"
check from AGENTS.md runs as a step on the PR commits. Workflow edits are pushed over SSH
(`GITHUB_TOKEN` cannot write workflows).

### 12.2 Deploy

**Workers Builds** (Git-connected, consistent with the Pages repos, no API token in GitHub):
build command `pnpm install --frozen-lockfile && pnpm wrangler d1 migrations apply DB --remote
--env production`, deploy command `pnpm wrangler deploy --env production`; branch `main` ->
production, `staging` -> staging, other branches -> `wrangler versions upload` preview (no
custom domain). Migrations apply first, which is why they must be backward compatible (§3.1).
Rollback: `wrangler rollback` (code) plus a forward-fix migration (D1 Time Travel restores data
to any minute in the last 7 days on free, 30 on paid; this replaces Neon's 6-hour restore
history, a net improvement, and `/privacy` must say so).

### 12.3 Cutover

1. Phase 0 spike deploys to staging with a custom domain `api-staging.pacestreak.com`.
2. App: `connect-src` already allows `https://api.pacestreak.com`; nothing changes on the app.
3. Cutover: in FastAPI Cloud, detach the custom domain `api.pacestreak.com`; delete the DNS-only
   CNAME; attach the custom domain to the production Worker (`routes` with `custom_domain:
   true` creates the proxied record and certificate). Downtime of a minute is acceptable (zero
   users). Upptime confirms `/health`.
4. Retire, in order, after 7 days green: FastAPI Cloud app `pacestreak-api`; GitHub Actions
   `Worker tick`, `Migrate` and GHCR `Publish` workflows and the GHCR image; secrets
   `WORKER_ENV_JSON` and GHCR PAT (rotate-then-delete, which also closes AGENTS.md outstanding
   item 2); Neon project; Upstash database; Brevo account (only if Email Service is confirmed).
5. Docs in the same week: `infra/TOPOLOGY.md`, `RUNBOOK.md` (new failure modes: D1 overload,
   queue backlog, CPU-limit exceeded), `DECISIONS.md` (this design's choices), root `AGENTS.md`
   and `HANDOFF.md`, `api/README.md`, and `/privacy` (providers become Cloudflare only;
   this is material, so bump `terms_version`).

---

## 13. Performance budgets

Measured as Workers CPU time (p99, from Logs) and D1 round trips (tests). Wall time is dominated
by D1 RTT, kept small by Smart Placement.

| Endpoint class | Examples | CPU p99 | D1 round trips |
| --- | --- | --- | --- |
| Health | `/health` | < 0.5 ms | 0 (`/ready`: 1) |
| Authenticated read, single resource | `GET /me`, `/notifications` page | < 2 ms | 1 auth + 1 batch |
| Authenticated read, aggregate | `/me/stats`, `/me/recap`, feed, leaderboard | < 5 ms | 1 auth + <= 2 batches (reads `user_stats` read model; no replay) |
| Simple write | log a habit day, kudos, follow | < 3 ms | 1 auth + 1 read batch + 1 write batch (+1 user rate limit where used) |
| Write that recomputes game state | create/update workout, wager | < 8 ms | 1 auth + 1 read batch (history window) + 1 write batch |
| Password routes | login, signup, change password | < 9 ms (PBKDF2 dominates) | <= 3 |
| `/sync` flush | up to 100 ops | < 8 ms | 1 per op (grouped when valid) |
| Export / import | | streamed; large ones offloaded (§10.3) | batched |
| Cron scheduler | | < 3 ms | 1-2 |
| Queue chunk | 50 users | < 9 ms free | 1 read batch + 1 write batch |

The riskiest line is "write that recomputes game state": `recompute()` today replays the whole
history. The port makes it **incremental**: the week-level aggregates (`week_days` per chain,
per ISO week) are stored in a `stats_weeks(user_id, chain_id, week_start, days, ...)` table updated
by each write; streaks and XP are recomputed from weekly aggregates (hundreds of rows at most,
not thousands of workouts). Full replay remains as `recomputeFull()` used by the hourly stats job
chunked through the queue and by a test that asserts incremental == full on randomised histories
(property test).

---

## 14. Intentional behaviour changes (all invisible to the current app)

1. Passwords PBKDF2 instead of Argon2; recovery codes HMAC instead of Argon2.
2. HS256 instead of RS256 access tokens.
3. Email-code attempt counter actually persists.
4. Over-length input -> 422, not 500.
5. Push SSRF guard is an allowlist (public IP literal endpoints rejected).
6. Local-hour jobs fire once per hour.
7. `/docs`, `/redoc`, `/openapi.json` not served in production.
8. Text search and name sorting are Unicode case-insensitive.
9. Email subjects say "PaceStreak", not "PaceStreak API".
10. Optional `"queued": true` on very large imports.

---

## 15. Risks (ranked)

1. **Free-plan CPU (10 ms)** on recompute, large exports/imports and PBKDF2 login. Mitigated by
   incremental stats, queue offload and the day-one PBKDF2 benchmark; the escape hatch is the
   paid plan, which is a config change by design.
2. **Cloudflare Email Service** availability/limits on the free plan (quota, recipients,
   attachments). Fallback adapter ready (Brevo HTTP).
3. **Queues on the free plan** (daily operation quota). Each notification is ~3 operations
   (write/read/delete); at today's scale far under the limit, but heavy fan-out days could hit
   it. Mitigation: DELIVERY batches 10 ids per message when produced by cron chunks.
4. **Hand-written Web Push crypto**: mitigated with RFC vectors and a real browser
   subscription test in staging before cutover.
5. **D1 single-writer throughput** (one database, writes serialised): fine for this scale;
   sync flush writes per op. If ever a problem, shard per-user data later (not planned).
6. **`@simplewebauthn/server` 14 on workerd** without `nodejs_compat`: confirmed by the phase 0
   spike or replaced by `nodejs_compat` for that module only.
7. **OCC recompute** under heavy concurrent writes from one user could skip a recompute; the
   hourly stats job converges and notifications are deduped.
8. **Rate Limiting binding is per-location**: an attacker spread across locations gets more
   attempts; Turnstile remains the primary guard on those routes.

---

## 16. Phased build order (for parallel implementation agents)

Each item is a work package with its dependencies. Packages in the same phase run concurrently.

### Phase 0: foundation (1 agent, blocking; ~1-2 days)

- **P0.1 scaffold**: repo layout, tooling, `wrangler.jsonc` (all bindings), `env.ts` config,
  CI workflow, Biome, tsconfig, vitest pool setup, bundle check.
- **P0.2 platform core**: `db.ts` (drizzle, batch helper, counting proxy), `clock.ts`,
  `crypto.ts`, `http/` (version, CORS, errors, 422 hook, 404/405, logger, request context),
  OpenAPI route helper with route metadata (auth level, IP limit, turnstile, user bucket).
- **P0.3 schema**: full Drizzle schema for all 60 tables + `sync_seq`, `sessions`,
  `rate_limits`, `stats_weeks`; fold columns; indexes; `0000_init.sql`; FK-to-users list.
  (Done in phase 0 so every module agent codes against final types.)
- **P0.4 spikes**: PBKDF2 CPU benchmark on staging, simplewebauthn on workerd, Email Service
  send with attachment, Queue + cron round trip. Results recorded before phase 1 starts.

### Phase 1: platform services (parallel, depend on P0)

| Package | Depends on |
| --- | --- |
| P1.1 auth core: passwords, JWT key ring, sessions, auth middleware, cookies, CSRF | P0 |
| P1.2 rate limiting (binding + D1 buckets) + Turnstile | P0 |
| P1.3 email: transport interface, Cloudflare + console transports, MIME, templates, unsubscribe signing | P0 |
| P1.4 push: VAPID, RFC 8291, endpoint guard | P0 |
| P1.5 storage: R2 wrapper + presign | P0 |
| P1.6 tz + format helpers (Intl cache, week math, ISO week, `%g`, banker's round) | P0 |
| P1.7 jobs framework: scheduler, queue consumers, heartbeat, `/health/*` | P0 |
| P1.8 test helpers: signup/login, authed client, soft authenticator, seeded heavy user, contract extractor | P0 (signup/login parts after P1.1) |

### Phase 2: feature modules (parallel, depend on phase 1 pieces listed)

| Package | Routes / scope | Depends on |
| --- | --- | --- |
| P2.1 auth routes (29 incl. passkeys), ops (client-errors, abuse) | auth.md, core.md §1.2 | P1.1, P1.2, P1.3 |
| P2.2 notifications (11 routes, `notify()`, `deliver`, prefs, unsubscribe) | misc.md §2 | P1.3, P1.4, P1.7 |
| P2.3 account/profile/trash/calendar/deletion | account.md | P1.1, P1.5, P2.2 (notify API only: stub the interface first) |
| P2.4 training A (workouts, sync, sets, exercises, gear, pauses, photos, importers) | training-a.md | P1.1, P1.5, P1.6 |
| P2.5 training B (routines, plans, blocks, race, readiness) | training-b.md | P1.1, P1.6 |
| P2.6 game (snapshot, incremental stats, achievements, leaderboards, recap, wagers) | game.md | P1.6; consumed by P2.4 through `game/service.ts` interface (define the interface in phase 0 to decouple) |
| P2.7 habits | habits.md | P1.1, P1.6, P2.2 interface |
| P2.8 social + buddies + search | social.md | P1.1, P2.2 interface, P2.6 interface |
| P2.9 groups + challenges | social.md (groups) | P2.8 |
| P2.10 nutrition + insights/coach | misc.md §1 | P1.1, P1.6 |
| P2.11 admin (incl. merge) | misc.md §3 | P1.1, P0.3 FK list |

Cross-module calls go through `service.ts` interfaces declared in phase 0
(`game.recompute(ctx, userId, opts)`, `notifications.notify(ctx, input)`,
`activity.publish(...)`), so P2 agents work in parallel against stubs.

### Phase 3: worker jobs (parallel, depend on owning modules)

stats + challenges (P2.6, P2.9), nudges + digest + backup (P2.6, P2.2, P2.3), habits jobs
(P2.7), buddies (P2.8), purge + housekeeping (P2.3, P1.5), error_alerts (P2.1, P1.3).

### Phase 4: hardening and cutover (1-2 agents)

Full pytest-port completeness check (285/285 or documented replacements), query budget suite
over every route, app contract job green, staging soak with the real app (`app` pointed at
staging via its env var on a preview deployment), push/email/passkey manual checks on real
devices, security review (CORS, cookies, CSRF, SSRF, rate limits, secrets scan), cutover and
retirement (§12.3), docs and `/privacy` update.
