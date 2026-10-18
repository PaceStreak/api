# Cutover runbook: Python on FastAPI Cloud → TypeScript on Cloudflare Workers

The owner's step-by-step plan for moving `api.pacestreak.com` from the Python
service (`main`) to the Workers rewrite (`next`). Every step has a **Check**
(how you know it worked) and a **Rollback** (how to undo it). Do them in order;
nothing before step 14 touches production traffic.

Written 2026-10-18 against `next` at the end of the CONTRACT unit. Unattended
sessions did none of this: no resource was created, nothing was deployed.

Ground rules carried from the workspace `AGENTS.md`:

- **Never create a DNS record by hand ahead of a deployment** (a proxied record
  with nothing behind it answers 522). The custom domain swap in step 15 lets
  Wrangler create the record against a running Worker.
- **Verify after propagation**, not seconds after a change.
- The shell is fish. Commands below avoid bash-only syntax; `(cmd)` is fish's
  command substitution.
- Run every `pnpm wrangler` command from `api/` on branch `next` (later
  `main`), so `wrangler.jsonc` is the one being read.

Contents:

1. [Before you start](#0-before-you-start)
2. [Resources](#1-workers-paid-plan) (steps 1–7)
3. [Secrets](#8-secrets) (step 8)
4. [Email Service](#9-cloudflare-email-service-sending-domain) (step 9)
5. [Workers Builds and staging](#10-workers-builds) (steps 10–13)
6. [Production and the domain swap](#14-production-worker-without-a-route) (steps 14–16)
7. [Merges](#17-merge-the-branches) (step 17)
8. [The first week](#18-the-first-week-watch-queues-crons-and-limits) (step 18)
9. [Retirement](#19-retire-the-old-stack-after-one-clean-week) (step 19)
10. [Proposed documentation edits](#proposed-edits-in-other-repositories) (infra, root `AGENTS.md`, status)
11. [Proposed `/privacy` and `/terms` text](#proposed-privacy-and-terms-text)
12. [Limits to check](#limits-to-check)

---

## 0. Before you start

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm check:parity && pnpm build`
  on `next` is green, and CI on `next` is green.
- `pnpm wrangler login` as the account that owns `pacestreak.com`
  (`fef2509f0377fba1f3201a655090ec0a`, the R2 host in `wrangler.jsonc`).
  The existing `zone:read` token cannot do any of this.
- A password manager entry ready for the new secrets (step 8).
- **Known fix needed in `wrangler.jsonc` before staging works:**
  `env.staging.vars.PUBLIC_API_URL` is `https://pacestreak-api-staging.workers.dev`,
  but a workers.dev URL includes the account subdomain:
  `https://pacestreak-api-staging.<subdomain>.workers.dev`. Read the subdomain
  in the dashboard (Workers & Pages → Overview, right-hand side) and fix the
  var in the same commit as the database ids (step 2).

## 1. Workers Paid plan

Workers & Pages → Plans → **Workers Paid** ($5/month). `OWNER-DECISIONS.md`
fixes this: PBKDF2 at 100,000 iterations and the 30 s `cpu_ms` limit in
`wrangler.jsonc` need it, and Queues, Email Service and the 30-day D1 Time
Travel window come with it.

- **Check:** the Plans page shows Workers Paid; `pnpm wrangler whoami` lists the account.
- **Rollback:** downgrade on the same page (only after step 19 has been undone,
  since the Worker will not fit the free plan).

## 2. D1 databases (location `apac`)

```fish
pnpm wrangler d1 create pacestreak --location apac
pnpm wrangler d1 create pacestreak-staging --location apac
```

The location hint is given once, at creation; it is not in `wrangler.jsonc`.
Copy each printed `database_id` into `wrangler.jsonc`, replacing
`00000000-0000-0000-0000-000000000000` (production) and
`...0001` (`env.staging`). Database ids are not secrets. Commit on `next`:
`chore(wrangler): real D1 ids and the staging workers.dev URL`.

- **Check:** `pnpm wrangler d1 info pacestreak` and `... pacestreak-staging`
  print the ids you pasted; the dashboard (Storage & Databases → D1) shows the
  region as an APAC location.
- **Rollback:** `pnpm wrangler d1 delete <name>` (nothing is in them yet).

Then apply the migrations to **staging** only (production gets them in step 14):

```fish
pnpm wrangler d1 migrations apply pacestreak-staging --remote --env staging
```

- **Check:** `pnpm wrangler d1 migrations list pacestreak-staging --remote --env staging` says no migrations to apply.
- **Rollback:** delete and recreate the staging database.

## 3. KV: none needed

`wrangler.jsonc` has **no KV namespace**. Rate limits use the Rate Limiting
binding (`ratelimits`, nothing to create) and the `rate_counters` D1 table
(DESIGN.md §7); caching uses the Cache API. Do not create a KV namespace.

- **Check:** `grep -c kv_namespaces wrangler.jsonc` prints 0.

The `ratelimits` namespace ids (`1001`–`1006`, `2001`–`2006`) are
account-scoped integers you choose, not resources; they only must not collide
with another Worker's. Nothing to create.

## 4. Queues with dead-letter queues

```fish
pnpm wrangler queues create pacestreak-jobs
pnpm wrangler queues create pacestreak-jobs-dlq
pnpm wrangler queues create pacestreak-jobs-staging
pnpm wrangler queues create pacestreak-jobs-staging-dlq
```

The consumer settings (`max_batch_size: 1`, `max_retries: 5`, the DLQ name)
come from `wrangler.jsonc` on the first deploy; no flags here. The DLQs have
no consumer on purpose: a message there is a job that failed six times and
waits for a human (step 18).

- **Check:** `pnpm wrangler queues list` shows all four.
- **Rollback:** `pnpm wrangler queues delete <name>`.

## 5. R2 buckets

```fish
pnpm wrangler r2 bucket create pacestreak-photos --location apac
pnpm wrangler r2 bucket create pacestreak-staging --location apac
pnpm wrangler r2 bucket create pacestreak-photos-staging --location apac
pnpm wrangler r2 bucket create pacestreak-staging-staging --location apac
```

`PHOTOS` holds progress photos; `STAGING` holds import and export files in
flight (housekeeping deletes them after a week). If an R2 bucket for the
Python service's photos exists, leave it until step 19 (there are no users, so
nothing moves across).

Photo uploads and downloads go straight from the browser to R2 with presigned
URLs, so the photo bucket needs CORS for the app origin:

```fish
# cors.json: [{"AllowedOrigins":["https://app.pacestreak.com"],"AllowedMethods":["GET","PUT"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3600}]
pnpm wrangler r2 bucket cors set pacestreak-photos --file cors.json
# staging: AllowedOrigins ["http://localhost:5173"]
pnpm wrangler r2 bucket cors set pacestreak-photos-staging --file cors-staging.json
```

Create an **R2 API token** (R2 → Manage API tokens → Object Read & Write,
restricted to the two photo buckets of each environment). Its access key id and
secret become `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in step 8. Do not
paste them into any chat.

- **Check:** `pnpm wrangler r2 bucket list` shows the four; `pnpm wrangler r2 bucket cors list pacestreak-photos`.
- **Rollback:** `pnpm wrangler r2 bucket delete <name>` (empty buckets only); revoke the token.

## 6. Cron triggers

Nothing to create: the three triggers are in `wrangler.jsonc`
(`*/5 * * * *`, `2,17,32,47 * * * *`, `23 3 * * *`) and are registered by
each deploy. They must match `src/jobs/scheduled.ts` `CRONS` exactly; a test
enforces that.

- **Check (after step 12 / 14):** Workers → the Worker → Settings → Triggers lists three crons; `GET /health/worker` turns 200 within 15 minutes.
- **Rollback:** remove them from `wrangler.jsonc` and deploy, or delete in the dashboard.

## 7. Email routing: unchanged

Inbound mail to `hello@pacestreak.com` stays on Zoho. Nothing here touches MX.

## 8. Secrets

Generate each value **locally**, store it in the password manager, then paste
it at Wrangler's hidden prompt, so it never lands in shell history or in any
chat transcript. Production and staging get **different** values.

| Secret | Format | Generate |
| --- | --- | --- |
| `JWT_KEYS` | JSON `{"current": kid, "keys": {kid: base64}}`, each key ≥ 32 bytes (HS256) | `printf '{"current":"k1","keys":{"k1":"%s"}}' (openssl rand -base64 32)` |
| `PEPPER` | base64, ≥ 32 bytes | `openssl rand -base64 32` |
| `DATA_KEY` | base64, **exactly** 32 bytes (AES-256-GCM: TOTP secrets) | `openssl rand -base64 32` |
| `TURNSTILE_SECRET_KEY` | Turnstile widget secret | Reuse the existing widget's secret for production (same site key in the app); staging uses the always-pass test secret `1x0000000000000000000000000000000AA` |
| `VAPID_PRIVATE_JWK` / `VAPID_PUBLIC_KEY` | P-256 private JWK (JSON) / raw public key, base64url | Node one-liner below. A **new** pair (no existing subscriptions) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token from step 5 | Dashboard |

```fish
node -e 'const s=crypto.subtle;(async()=>{const k=await s.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);console.log(JSON.stringify(await s.exportKey("jwk",k.privateKey)));console.log(Buffer.from(await s.exportKey("raw",k.publicKey)).toString("base64url"))})()'
```

Set them (repeat with `--env staging` and staging values):

```fish
pnpm wrangler secret put PEPPER              # paste at the prompt
pnpm wrangler secret put JWT_KEYS
pnpm wrangler secret put DATA_KEY
pnpm wrangler secret put TURNSTILE_SECRET_KEY
pnpm wrangler secret put VAPID_PRIVATE_JWK
pnpm wrangler secret put VAPID_PUBLIC_KEY
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
```

`secret put` on a Worker that does not exist yet creates an empty one with
the secret. That is harmless (no route, no workers.dev in production because
`workers_dev: false`), but if you prefer, set them right after step 14's first
deploy instead; the Worker answers 500 `refusing to start` until they exist.

Rotation, later: add a new kid to `JWT_KEYS`, make it `current`, keep the old
kid until the longest token (7-day refresh) has expired, then drop it.
**`PEPPER` and `DATA_KEY` cannot be rotated** without invalidating every
password hash, email code and TOTP secret; keep them safe.

- **Check:** `pnpm wrangler secret list` (and `--env staging`) lists all eight names. After a deploy, `GET /health/ready` is 200 (a config error makes every request a 500 and the log says `refusing to start: <reason>`).
- **Rollback:** `pnpm wrangler secret delete <NAME>`; a wrong value is replaced with another `secret put`.

## 9. Cloudflare Email Service: sending domain

The Worker sends with the `send_email` binding `EMAIL` (`MAILER=cloudflare`).

1. Dashboard → **Compute & AI → Email Service → Email Sending** → *Onboard
   domain* → `pacestreak.com`. (CLI equivalent per DESIGN.md §10:
   `pnpm wrangler email sending enable pacestreak.com`; use the dashboard if
   your Wrangler version lacks it.)
2. Let Cloudflare add the records it lists (DKIM, and the SPF/return-path
   records on its **bounce subdomain**). They live on subdomains, so the
   apex SPF (`include:zoho.in` only) and Zoho's MX stay as they are. If the
   wizard proposes editing the apex SPF or MX, stop: Zoho receives
   `hello@`.
3. Keep DMARC as it is. Leave the Brevo DKIM records until step 19.
4. Confirm `hello@pacestreak.com` (the `MAIL_FROM`) is an allowed sender.

- **Check:** the domain shows *Verified*; after step 12, sign up on staging with
  a real address and receive the 6-digit code. Inspect the headers:
  `dkim=pass header.d=pacestreak.com`, `spf=pass`, `dmarc=pass`, no tracking
  links.
- **Rollback:** off-board the domain in the same page; the records it added
  are removed with it (check the DNS tab).

## 10. Workers Builds

Workers & Pages → `pacestreak-api` → Settings → **Builds** → connect
`PaceStreak/api`.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` |
| Deploy command | `pnpm wrangler d1 migrations apply pacestreak --remote && pnpm wrangler deploy` |
| Non-production branch deploy command | `pnpm wrangler d1 migrations apply pacestreak-staging --remote --env staging && pnpm wrangler deploy --env staging` |
| Root directory | `/` |
| Build variables | `NODE_VERSION=24` (pnpm comes from `packageManager` via corepack) |

**Migrations run before the deploy**, in the same command, so the new code
never sees an old schema; if a migration fails, `&&` stops the deploy. The
old code keeps running against the new schema for the seconds in between,
so migrations must stay backward compatible (add, never rename or drop in the
same release), exactly as with the `Migrate` workflow today.

Until step 17, `main` still holds the Python service: **leave Builds
disconnected from production, or point the production branch at `next`
temporarily**, and deploy production by hand in step 14. Recommended: connect
Builds only after the merge in step 17, and use manual deploys until then.

The Builds API token it creates needs D1 edit; the default "Workers Builds"
token has it.

- **Check:** a push to `next` (after step 17: to `main`) shows a green build with both commands in the log; `pnpm wrangler deployments list` shows it.
- **Rollback:** disconnect the repository in the same page; `pnpm wrangler rollback` for a bad version.

## 11. First staging deploy

```fish
pnpm wrangler deploy --env staging
```

- **Check:** `curl https://pacestreak-api-staging.<subdomain>.workers.dev/health`
  → `{"status":"healthy"}`; `/health/ready` → 200 `ready`; within 15 minutes
  `/health/worker` → 200. Settings → Triggers shows three crons; Queues shows
  the staging consumer.
- **Rollback:** `pnpm wrangler rollback --env staging`, or `pnpm wrangler delete --env staging`.

Owed checks from earlier units (PROGRESS.md), run now against staging:

- **G-1:** PBKDF2 CPU time. `pnpm wrangler tail --env staging --format json`
  while signing in; `cpuTime` on `/v1/auth/login` should be well under the
  30,000 ms limit (expect tens of ms).
- **G-3:** the D1 batch tests against a remote D1 (staging).

## 12. App e2e against staging (app branch `api-next`)

The app's Playwright suite reads 6-digit codes from the API log and uses
Turnstile's always-pass key. Two traps decide how to run it:

- A deployed staging app on `*.pages.dev` calling `*.workers.dev` is
  **cross-site**: the `SameSite=Lax` refresh cookie is not sent, so reloads
  log you out. That is correct behaviour, not a bug; do not loosen SameSite.
- Production has `MAILER=cloudflare`, so codes are not printed.

So run the browser on `localhost` against the Worker running **locally on
staging's remote bindings** (`localhost:5173` and `localhost:8787` are
same-site; ports do not count):

```fish
# terminal 1, in api/
pnpm wrangler dev --env staging --remote --port 8787 \
  --var MAILER:console --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA \
  --var PUBLIC_API_URL:http://localhost:8787 2>&1 | tee /tmp/api-staging.log
# terminal 2, in app/ on branch api-next
git switch api-next
npm ci && npx playwright install chromium
env PUBLIC_API_BASE_URL=http://localhost:8787 E2E_API=http://localhost:8787/v1 \
    E2E_API_LOG=/tmp/api-staging.log npx playwright test
```

If `wrangler dev --remote` refuses a binding (rate-limit bindings have been
local-only in some Wrangler versions), run the same command without
`--remote`: the local D1/R2/Queues are then used, which still exercises the
real Worker code end to end. Staging's `RL_SIGNUP` is 5 a minute per IP;
the suite signs up more often than that, so if signups 429, raise the staging
limits temporarily in `wrangler.jsonc` (`env.staging.ratelimits`) and revert.

`playwright.config.ts` hardcodes `PUBLIC_API_BASE_URL: http://localhost:8000`
in `webServer.env`. If the env override above does not win, change that one
value on `api-next` for the run, or (better) make it
`process.env.PUBLIC_API_BASE_URL ?? "http://localhost:8000"` in a commit on
`api-next`.

- **Check:** every spec passes; also do one manual pass in the browser:
  signup with a real address on staging (Email Service delivers), passkey,
  TOTP, a photo upload (R2 CORS), push subscribe, export, import, trash undo.
- **Rollback:** nothing to undo; fix on `next`/`api-next` and repeat.

## 13. Load and limits smoke test on staging

`pnpm seed:heavy` (see the script header) against staging, then hit the
heavy routes and watch `wrangler tail --env staging` for `cpuTime`,
`exceededCpu`, D1 `rows_read` and `Too many API requests by single worker
invocation`. Trigger the daily jobs by waiting for `23 3 * * *` UTC or with
`curl "http://localhost:8787/__scheduled?cron=23+3+*+*+*"` under `wrangler dev --test-scheduled`.

- **Check:** no CPU-limit errors, no D1 overload errors, the DLQ stays empty.
- **Rollback:** fix on `next`.

## 14. Production Worker without a route

Deploy production **with no route**, so the Python service keeps serving
`api.pacestreak.com`:

```fish
pnpm wrangler d1 migrations apply pacestreak --remote
# local, uncommitted edit of wrangler.jsonc: "routes": [] and "workers_dev": true
pnpm wrangler deploy
git restore wrangler.jsonc
```

Production stays reachable on workers.dev only until step 15, whose deploy
restores `workers_dev: false`.

- **Check:** `curl https://pacestreak-api.<subdomain>.workers.dev/health` → healthy; `/health/ready` 200; `/health/worker` 200 within 15 minutes; `pnpm wrangler secret list` complete; Settings → Triggers shows three crons. The production crons now run against an empty database, which is harmless.
- **Rollback:** `pnpm wrangler delete` (the Worker has no route; nothing else depends on it).

Create the admin account now (the Python dev admin does not carry over):

```fish
env PEPPER=<production pepper> pnpm admin create-admin admin@pacestreak.com > /tmp/op.sql
pnpm wrangler d1 execute pacestreak --remote --file /tmp/op.sql; and rm /tmp/op.sql
```

## 15. Swap the custom domain without a 522 window

`api` today is a **DNS-only CNAME** to FastAPI Cloud plus three validation
records (`_fc-dcv.api`, `_cf-custom-hostname.api` TXT, `_acme-challenge.api`
CNAME). A Workers custom domain needs the name free. Do this in one sitting,
in a quiet hour:

1. Have `wrangler.jsonc` as committed (`routes: [{pattern: "api.pacestreak.com", custom_domain: true}]`, `workers_dev: false`) and the deploy command ready in a terminal.
2. FastAPI Cloud: `fastapi cloud domains list`, then remove the `api.pacestreak.com` domain (dashboard or `fastapi cloud domains remove api.pacestreak.com`).
3. Cloudflare DNS: delete the `api` CNAME and the three validation records.
4. Immediately: `pnpm wrangler deploy`. Wrangler attaches the custom domain to
   the running Worker and creates a **proxied** record and an edge
   certificate itself. Never create the `api` record by hand.

The gap is between 3 and 4: `api.pacestreak.com` does not resolve (NXDOMAIN,
a fetch error in the app) for the few seconds the deploy takes, plus
negative-cache time at resolvers (the zone's SOA minimum, at most a few
minutes). That is not a 522, and with no users it is acceptable. A zero-gap
alternative is not available because the name cannot point at two places.

- **Check (after a few minutes, not seconds):**
  `curl -sI https://api.pacestreak.com/health` → 200 with `server: cloudflare`;
  `dig api.pacestreak.com` shows Cloudflare anycast IPs (not a CNAME chain);
  `/health/ready` and `/health/worker` 200; the certificate is Cloudflare's
  edge certificate; in the live app, sign up with a real address, verify,
  sign out, sign in, reload (refresh cookie on `Domain=pacestreak.com`
  works), log a habit, upload a photo.
- **Rollback:** `pnpm wrangler deploy` with `routes: []` (detaches the domain
  and removes its record), then in FastAPI Cloud `fastapi cloud domains add
  api.pacestreak.com --standard` and recreate the four records it prints
  (values in `infra/TOPOLOGY.md`). The Python app is still deployed, so this
  restores the old state in minutes. Keep it deployed until step 19.

The app needs **no change** for this: same API host, same R2 account host, so
`app/public/_headers` `connect-src` is already right (DESIGN.md §16).

## 16. Turn off the old scheduler

As soon as step 15 is verified, disable (do not delete) the `Worker tick`
and `Migrate` workflows on `PaceStreak/api`, so the Python worker stops
sending mail from Brevo while the Workers crons run:

```fish
gh workflow disable "Worker tick" -R PaceStreak/api
gh workflow disable Migrate -R PaceStreak/api
```

- **Check:** `gh workflow list -R PaceStreak/api` shows both disabled.
- **Rollback:** `gh workflow enable ...`.

## 17. Merge the branches

Order matters: the app's `api-next` speaks the new contract, and `main` of
`api` must hold the code that is actually serving.

1. **api `next` → `main`** first. Open a PR from `next`, let CI pass, merge
   (merge commit; `next` has a long history worth keeping). This replaces
   the Python tree on `main`, and FastAPI Cloud's GitHub integration would
   try to deploy it: **disconnect FastAPI Cloud's GitHub integration before
   merging** (FastAPI Cloud dashboard → app → Git), or the push fails a
   Python build there (harmless but noisy).
2. Connect Workers Builds to `main` now (step 10). The merge push builds and
   deploys the same code that is already live; check the build log shows
   "No migrations to apply" and a deploy.
3. **app `api-next` → `main`** second. Cloudflare Pages deploys it to
   `app.pacestreak.com`. The app's CI e2e job starts the API from
   `PaceStreak/api` `main`; after step 1 that is the Workers API, so that job
   must already be updated for `wrangler dev` (no `make keys`, no Postgres or
   Redis). If `api-next` still runs the Python API in CI, update
   `app/.github/workflows/ci.yml` on `api-next` first, **over SSH** (a
   `GITHUB_TOKEN` cannot write workflows).
4. Root repo: `git add api app` and commit the new pins (`chore: pin api and
   app for the Workers cutover`). Push submodules before the root.

- **Check:** both `main` CIs green; Workers Builds green; Pages deployment
  green; the live app passes the manual pass from step 15 again.
- **Rollback:** revert the merge commits on `main` (`git revert -m 1 <sha>`)
  in the reverse order (app first, then api); the Worker keeps serving the
  version already deployed until you `wrangler rollback` or redo step 15's
  rollback.

## 18. The first week: watch queues, crons and limits

The consumer takes **one message per invocation** (`max_batch_size: 1`)
because D1 counts every statement against 1,000 queries per invocation
(`src/jobs/dispatch.ts`). Throughput therefore comes from **concurrency**,
not batch size: Queues autoscales consumer invocations with backlog.

Daily, for a week:

- **Backlog:** dashboard → Queues → `pacestreak-jobs` → Metrics: *backlog*
  should return to 0 within a few minutes of each `*/5` and `:02/:17/:32/:47`
  tick. A backlog that grows across ticks means consumers are not keeping up:
  check *concurrent consumers* (it should rise above 1 under load); if it is
  stuck at 1, look for `max_concurrency` in the dashboard settings and leave it
  unset (automatic).
- **DLQ:** `pacestreak-jobs-dlq` must stay empty. A message there failed six
  times. Read it with the dashboard's *List messages*, find the cause in
  `wrangler tail` / Workers Logs (search `job failed`), fix, then re-send the
  body to `pacestreak-jobs` (`pnpm wrangler queues ...` or the dashboard
  *Send message*).
- **Crons:** `GET /health/worker` stays 200 (503 after 900 s without a tick).
  Upptime can watch it (proposed below).
- **Errors:** Workers Logs (observability is on, `head_sampling_rate: 1`):
  filter `$metadata.error` and `exceededCpu`; D1 dashboard: *query
  duration*, *rows read*, any `D1_ERROR overloaded`.
- **Mail:** Email Service → Sending → activity: bounces and rejections.

- **Rollback (any time this week):** step 15's rollback, then
  `gh workflow enable` the two workflows. No data moves back (there are no
  users); anything written to D1 meanwhile stays in D1.

## 19. Retire the old stack after one clean week

"Clean" means: no DLQ messages, `/health/worker` never red, no 5xx spikes,
mail delivered. Then, in this order:

1. **FastAPI Cloud:** delete app `pacestreak-api` (`fastapi cloud` dashboard). Remove `.fastapicloud/` from the api repo in a commit.
2. **Actions:** delete `Worker tick`, `Migrate` and the image publish workflow (`publish.yml`) from `main` if the merge did not already (it did, since `next` has only `ci.yml`; confirm with `gh workflow list -R PaceStreak/api`). Delete the repository secret `WORKER_ENV_JSON` and any FastAPI Cloud token secrets: `gh secret list -R PaceStreak/api`.
3. **GHCR:** delete the `api` container package: GitHub → PaceStreak org → Packages → `api` → Package settings → Delete. `gh` needs `delete:packages` scope for the API route.
4. **Neon:** delete the project (Neon console → Settings → Delete project). Its 6-hour restore history goes with it; there is no data to keep.
5. **Upstash:** delete the Redis database.
6. **Brevo:** delete the SMTP key, then the account (or leave it dormant). Remove the Brevo DNS records: `brevo1._domainkey`, `brevo2._domainkey` CNAMEs and the `brevo-code:` TXT at the apex.
7. **Old keys:** the RS256 keypair, the old VAPID pair and the Fernet key are dead; delete them from the password manager and the local `api/keys/` (gitignored) and `api/.env`.
8. **Old R2 photo bucket**, if the Python service used a different bucket name from step 5: delete it.
9. **Rotate anything ever pasted into a chat** (root `AGENTS.md` "What's left" item 2): the Cloudflare token, R2 keys, GHCR PAT. Most die with steps 3–7.

- **Check:** `gh workflow list -R PaceStreak/api` shows only CI; `gh secret list -R PaceStreak/api` has no worker/deploy secrets; DNS has no `brevo`/`_fc-dcv`/`_cf-custom-hostname.api`/`_acme-challenge.api` records; Neon, Upstash and FastAPI Cloud dashboards are empty.
- **Rollback:** none after this step; that is why it waits a week.

Then apply the documentation edits below and publish the `/privacy` and
`/terms` change (it must go live **on the day** the new `terms_version`
ships; see that section).

---

## Proposed edits in other repositories

These repos were not touched (they are the owner's to change; pushing
`web` `main` deploys the live site). Apply after step 19, or the privacy
change on the day of step 17.

### infra/TOPOLOGY.md

DNS table, replace the `api` row with:

```markdown
| `api` | Workers custom domain | `pacestreak-api` Worker | Proxied | Created by `wrangler deploy` from the `custom_domain` route in `api/wrangler.jsonc`; never create it by hand. |
```

Delete the two Brevo rows (`brevo1._domainkey`, `brevo2._domainkey`, and the
`brevo-code:` TXT) and add the records Email Service added in step 9:

```markdown
| (bounce subdomain and DKIM records listed under Email Service → Email Sending → pacestreak.com) | as listed | Cloudflare Email Service | DNS only | Outbound account mail from the API Worker (`send_email` binding). Added by onboarding; edit only through that page. |
```

In "Two senders, one SPF record", replace "Brevo" with "Cloudflare Email
Service, which sends from its own bounce subdomain" and keep the conclusion
(apex SPF lists only Zoho).

Replace the section `### api.pacestreak.com: FastAPI Cloud, not Pages` with:

```markdown
### `api.pacestreak.com`: a Worker with a custom domain

Since <cutover date> the API is the `pacestreak-api` Cloudflare Worker
(TypeScript, Hono), on the Workers Paid plan, with D1 `pacestreak` (location
hint `apac`), R2 buckets `pacestreak-photos` and `pacestreak-staging`, the
queue `pacestreak-jobs` with dead-letter queue `pacestreak-jobs-dlq`, three
cron triggers, and Cloudflare Email Service for mail. All of it is declared in
`api/wrangler.jsonc`.

The hostname is a Workers **custom domain**: `wrangler deploy` created the
proxied record and the certificate when it attached the route to a running
Worker. Unlike the old DNS-only CNAME, `dig api.pacestreak.com` shows
Cloudflare's anycast IPs and the API sits behind Cloudflare's edge.

Deploys: Workers Builds on every push to `api` `main` runs
`wrangler d1 migrations apply pacestreak --remote && wrangler deploy`;
migrations land before the code. Other branches deploy the `staging`
environment (`pacestreak-api-staging` on workers.dev). The scheduler is the
cron triggers plus the queue consumer, inside the same Worker; there is no
GitHub Actions worker any more.

History: GCP `e2-micro` VM (2026-09-27), FastAPI Cloud with Neon, Upstash and
an Actions worker (2026-10-11), Workers (<cutover date>). See
`infra/DECISIONS.md`.
```

Certificates table, replace the `api` row with:

```markdown
| `api.pacestreak.com` | Cloudflare edge certificate | Issued automatically for the Workers custom domain |
```

### infra/RUNBOOK.md

Replace `## Reminders, digests or deletions stopped (the API is up)` and
`## A deploy didn't reach the API` with these sections, and add the three new
failure modes:

```markdown
## Reminders, digests or deletions stopped (the API is up)

`GET https://api.pacestreak.com/health/worker` answers 503 after 900 s without
a scheduler tick. Check, in order:

1. Workers → `pacestreak-api` → Settings → Triggers: three crons listed. A
   deploy registers them from `wrangler.jsonc`; a hand edit in the dashboard
   is overwritten by the next deploy.
2. Workers Logs, filter `scheduled`: a tick that throws is logged with the
   job name. A lease that never expires (240 s) means a tick died mid-run;
   the next tick after expiry takes over.
3. Queues → `pacestreak-jobs`: a growing backlog means consumers are failing
   or slow; see "Messages in the dead-letter queue".

## A deploy didn't reach the API

Workers Builds → the build: the deploy command is
`wrangler d1 migrations apply ... && wrangler deploy`, so a failed migration
stops the deploy and the old version keeps serving. `pnpm wrangler
deployments list` shows what is live; `pnpm wrangler rollback` returns to the
previous version (it does not roll back migrations, which is why they must
stay backward compatible).

## Messages in the dead-letter queue

`pacestreak-jobs-dlq` has no consumer: a message there failed six attempts.
List it in the dashboard (Queues → the DLQ → Messages), find the error in
Workers Logs by the job name, fix and deploy, then send the body back to
`pacestreak-jobs`. Consumers take one message per invocation, because D1
allows 1,000 statements per invocation; never raise `max_batch_size`.

## D1 says "overloaded" or queries time out

D1 is single-threaded per database. Workers Logs `D1_ERROR`, and D1 → Metrics
query duration. Usual causes: a job slice too large (see `SLICE_IDS` in
`src/jobs/dispatch.ts`) or a missing index (`test/explain`). Requests retry
nothing; fix the query.

## Requests fail with "exceeded CPU" (1102)

Workers Logs `exceededCpu`. The limit is `limits.cpu_ms` (30 s) in
`wrangler.jsonc`; normal requests use milliseconds, PBKDF2 sign-in about
25 ms. An import or export that hits it is a bug in the resumable slice code
(`src/heavy`), not a reason to raise the limit.

## Restoring the database

D1 Time Travel keeps 30 days on Workers Paid:
`pnpm wrangler d1 time-travel info pacestreak` then
`pnpm wrangler d1 time-travel restore pacestreak --timestamp=<unix>`.
A restore rewinds the whole database, every user included. There is no other
backup (owner's decision).
```

In `## Email stopped working after a DNS change`, replace the Brevo detail
with: "Email Service → Email Sending → `pacestreak.com` must show Verified;
its DKIM and bounce records are on subdomains and must not be removed. The
apex SPF and MX belong to Zoho." In `## Verifying everything at once`, add
`curl -s https://api.pacestreak.com/health/worker` and drop any
`fastapi cloud` or `gh run list` worker lines.

### infra/DECISIONS.md

Append (do not edit the older hosting sections; they are history):

```markdown
## The API's hosting, revised again: Cloudflare Workers, D1, Queues, Email Service

Decided 2026-10-17, live <cutover date>. The Python API (FastAPI on FastAPI
Cloud, Neon Postgres, Upstash Redis, a GitHub Actions cron worker, Brevo) was
rewritten as TypeScript on Cloudflare Workers: Hono, Drizzle and Zod, with D1
(location `apac`), R2, Queues with a dead-letter queue, cron triggers, the Rate
Limiting binding and Cloudflare Email Service, on Workers Paid ($5/month).

Why: one provider instead of six; no scheduled Actions job eating the private
repos' 2,000 free minutes; no scale-to-zero cold starts on 0.1 vCPU; the
scheduler, queue, database and mail live next to the code and deploy with it.
PaceStreak had no users, so nothing had to stay compatible (no Argon2 or
Fernet carry-over, no data migration). Workers Paid rather than Free because
PBKDF2 at the platform maximum of 100,000 iterations needs more than 10 ms of
CPU, and a cheap plan is never a reason to weaken hashing. Backups are D1 Time
Travel (30 days on Paid); off-host backups stay declined.

Not chosen: Durable Objects (D1's batches give the atomicity needed), KV
(rate limits use the binding and a D1 counter table), Hyperdrive to keep Neon
(two providers and a network hop for no gain without existing data).
Records: `api/docs/rewrite/OWNER-DECISIONS.md`, `DESIGN.md`.
```

Also amend `## API hosting and email provider: no longer open` with one line
at its end: "Superseded on <cutover date>: mail is Cloudflare Email Service;
Brevo is retired."

### Workspace AGENTS.md (root repo)

Replace item 1 and item 2 of "How production runs" with:

```markdown
1. **API: Cloudflare Workers, live since <cutover date>** (FastAPI Cloud
   2026-10-11 to <cutover date>, a GCP VM before that; all retired). Worker
   `pacestreak-api` on Workers Paid, D1 `pacestreak` (location `apac`), R2,
   Queues with a dead-letter queue, three cron triggers, custom domain
   `api.pacestreak.com` (created by `wrangler deploy`, proxied). Push to `api`
   main → Workers Builds applies D1 migrations, then deploys; migrations must
   stay backward compatible. Other branches deploy the `staging` environment.
   Check with `pnpm wrangler deployments list` and `/health/worker`;
   `infra/RUNBOOK.md` has the failure modes. Configuration lives in one place:
   `api/wrangler.jsonc` vars and `wrangler secret`.
2. **Email: Cloudflare Email Service** (`send_email` binding), `pacestreak.com`
   onboarded for sending. No tracking. Included sends on Workers Paid; check
   the current quota before a mailing feature.
```

Item 6 becomes: "**`/privacy` names every provider**: Cloudflare (Pages,
Workers, D1, R2, Queues, Email Service, Turnstile), Open Food Facts, Zoho and
browser push services. A material edit bumps `terms_version` in
`api/src/env.ts` (`SETTINGS.termsVersion`)."

In the intro, replace "`api` (FastAPI, ~265 routes, ~285 tests) at
`api.pacestreak.com`" with "`api` (TypeScript on Cloudflare Workers: Hono, D1,
~265 routes) at `api.pacestreak.com`". In the visibility paragraph, delete the
"Caveat: the `api` `Worker tick` ..." sentences (retired). In "Local
development of the product", replace the `api` block with
`cd api && pnpm dev   # wrangler dev on :8787` and delete the "`make test`
truncates every table" bullet and the dev-compose bullets (see
`api/AGENTS.md`). "What's left" items 2 and 3: drop "and `WORKER_ENV_JSON`"
and the FastAPI Cloud paid-plan item. In "Operations quick reference":
admin tooling is `pnpm admin create-admin|set-password|set-role` (prints SQL
for `wrangler d1 execute`), backups are D1 Time Travel, and drop "`api` CI
also runs `alembic check`" (it runs `drizzle-kit check` and a drift probe).
In the Layout table, change `api`'s state to "**Live** at `api.pacestreak.com`
(Cloudflare Workers, Workers Builds)".

### status/.upptimerc.yml

The `/health` check still works unchanged (`{"status":"healthy"}`, no
redirect). Proposed: fix the stray comment line and add the scheduler check,
which the Actions worker could not have offered cheaply:

```diff
   # The product itself: React PWA shell, served noindex. A 200 here still
-  # proves nothing about the API behind it, hence the separate api.
-  # monitor below — the app can render its shell while every API call fails.
+  # proves nothing about the API behind it, hence the separate api monitor
+  # below — the app can render its shell while every API call fails.
@@
-  # /health is unauthenticated and cheap (no DB round-trip beyond a liveness
-  # check), so it is safe to hit every 5 minutes without adding to the
-  # per-IP rate limits real users share.
+  # /health is unauthenticated, touches no database and is edge-cached for a
+  # few seconds, so it is safe to hit every 5 minutes without adding to the
+  # per-IP rate limits real users share.
   - name: api.pacestreak.com
@@
     connectTimeout: 10
     requestTimeout: 30
+
+  # The scheduler: cron triggers and the queue consumer inside the Worker.
+  # 503 after 900 s without a tick, while /health stays green.
+  - name: api.pacestreak.com scheduler
+    slug: api-pacestreak-com-worker
+    url: https://api.pacestreak.com/health/worker
+    maxResponseTime: 3000
+    expectedStatusCodes:
+      - 200
+    maxRedirects: 0
+    connectTimeout: 10
+    requestTimeout: 30
```

The certificate check needs no change: it reads whatever certificate the
hostname serves, now Cloudflare's edge certificate.

---

## Proposed `/privacy` and `/terms` text

### Time Travel retention (verified)

Cloudflare's D1 Time Travel documentation says you can restore "up to 30 days
in the past (Workers Paid plan) or 7 days (Workers Free plan)":
<https://developers.cloudflare.com/d1/reference/time-travel/> (read
2026-10-18). PaceStreak is on Workers Paid (`OWNER-DECISIONS.md`), so the
page says **30 days**. DESIGN.md §16's "7 days" assumed the Free plan and is
superseded; the WORKPLAN acceptance line "Cloudflare + Brevo, 7-day" is
likewise superseded by the owner's decision to drop Brevo.

### `terms_version`

Root `AGENTS.md`: a material change to `/privacy` or `/terms` bumps
`terms_version`, which makes every account accept again. This change is
material (providers, locations, backup window), so `next` already sets
`SETTINGS.termsVersion` in `api/src/env.ts` to **`2026-10-19`** (Python:
`2026-10-17`), asserted in `test/profile-account.test.ts` and recorded in
`CHANGES-FROM-PYTHON.md`. Publish the new pages the same day the Worker goes
live, and set both pages' `updated` constant and `terms_version` to that
date. If it is not 2026-10-19, change the constant, the test and the
CHANGES row together.

### web/src/pages/privacy.astro

`const updated = "<cutover date>";`

Replace the five `<li>` items from **Cloudflare** through **Brevo** in
"Service providers" with:

```html
          <li>
            <strong>Cloudflare</strong> runs everything we operate: it hosts
            the websites and the app, runs the API (Workers), stores your
            account and everything on this page in its database (D1), stores
            progress photos (R2) if you turn photo backup on, and holds
            import and export files for a few minutes while they are being
            processed (R2, deleted within a week at the latest). It queues
            background work such as streak reminders, digests and account
            deletions (Queues), and sends account email (Email Service):
            sign-up verification, password reset and email-change codes,
            plus any summaries you switch on. If you turn on the monthly or
            weekly backup email (off by default, and the app asks you to
            confirm), that message carries a zip of your whole export, so it
            passes through Cloudflare's mail service and then sits in your
            inbox like any other email. Cloudflare also runs Turnstile, an
            invisible challenge on sign-up, sign-in, password-reset and
            resend-verification that exists only to stop those forms being
            used to spam email or brute-force passwords. Turnstile sees the
            request needed to tell a human from a script; it is not
            analytics and does not track you around the web.
          </li>
```

Keep the Open Food Facts, Zoho and push-service items as they are.

Replace the "Where it's stored" paragraph with:

```html
        <p>
          Your data is stored by Cloudflare. The database lives in Cloudflare's
          Asia-Pacific region; the API runs on Cloudflare's global network,
          usually in the data centre closest to the database or to you; the
          websites and photos are served from that same network. If you live
          in the EU, the UK or another country with transfer rules, your data
          is transferred outside it under Cloudflare's data processing
          addendum, which includes the European Commission's standard
          contractual clauses. Everything is encrypted in transit, and
          Cloudflare encrypts it at rest. Zoho, which receives mail sent to
          hello@pacestreak.com, is described above.
        </p>
```

Replace the "Backups" list item with:

```html
          <li>
            <strong>Backups.</strong> The database keeps a rolling 30-day
            restore history (Cloudflare D1 Time Travel), used only to recover
            from a failure, so deleted data can survive there for up to 30
            days. There are no other copies. If we add longer-lived backups,
            this page will say so, and how long they last, before it happens.
          </li>
```

Then search the page for any remaining "Neon", "Upstash", "FastAPI",
"Google Cloud", "GitHub" (as a processor) and "Brevo" and remove them; the
build's `check-html.py` will not catch stale names.

Note that the "Account deletion" item stays true: 30 days of grace, then
permanent deletion, after which the data can survive in the restore history
for up to 30 more days. Consider adding that sentence to the deletion item:
"Copies in the 30-day restore history expire on their own."

### web/src/pages/terms.astro

`const updated = "<cutover date>";`. No provider is named in `/terms`
today; search it for "6 hours", "Neon" and "Brevo" before publishing. If
it describes the restore window, change it to 30 days to match `/privacy`.
The liability line about "data beyond what we can restore" stays.

### Commit for web

`docs(privacy): Cloudflare runs the API, database and mail; 30-day restore history`,
body: why (the API moved to Workers on <date>; providers and backup window
changed; `terms_version` bumped so every account accepts again). Push to
`web` `main` deploys it; do that **after** step 15 succeeds, the same day.

---

## Limits to check

Read the current numbers on the linked pages before relying on them; these
change.

| Product | What matters here | Where to check |
| --- | --- | --- |
| Workers Paid | 10 M requests/month and 30 M CPU-ms included; `cpu_ms` up to 5 min (we set 30 s); 1,000 subrequests per invocation; 128 MB memory | <https://developers.cloudflare.com/workers/platform/limits/>, <https://developers.cloudflare.com/workers/platform/pricing/> |
| D1 | 1,000 queries per invocation (why consumers take one message); 10 GB per database; rows read/written included per month; Time Travel 30 days | <https://developers.cloudflare.com/d1/platform/limits/>, <https://developers.cloudflare.com/d1/platform/pricing/> |
| Queues | Operations included per month (each message is about three: write, read, delete); consumer concurrency; message size 128 KB | <https://developers.cloudflare.com/queues/platform/limits/>, <https://developers.cloudflare.com/queues/platform/pricing/> |
| R2 | 10 GB storage, Class A and B operations free each month; egress free | <https://developers.cloudflare.com/r2/pricing/> |
| Cron triggers | Per-account and per-Worker trigger counts (we use 3 per environment, 6 total) | Workers limits page above |
| Email Service | Sends included on Workers Paid (DESIGN.md §22 assumed 3,000 a month), per-message size (backup attachments cap at 10 MiB in `src/lib/mailer`) | <https://developers.cloudflare.com/email-service/> |
| Rate Limiting binding | Period must be 10 or 60 s (we use 60) | <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/> |
| Workers Builds | Build minutes included on Paid | <https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/> |

Set a **billing notification** (Manage Account → Notifications → Usage-based
billing) for Workers, D1 and Queues, so an unexpected loop shows up as an
email rather than an invoice.
