# Rewrite progress

Next step: F2 core pipeline (env, ctx, errors, CORS, validation hook, AuthedBatch, helpers); F0 and F1 landed.

Started 2026-10-18 03:48 IST from a scheduled session in the owner's VS Code. Work runs in
hour-long legs gated on plan usage; each leg resumes from the `Next step:` line above.

## Units

| Unit | State |
| --- | --- |
| F0 F1 | done |
| F2 F3 | in progress |
| P1-CRYPTO P1-GUARD P1-MAIL P1-PUSH P1-R2 P1-JOBS P1-HEAVY P1-CATALOG | todo |
| AUTH NOTIF OPS-ADMIN | todo |
| GAME | todo |
| PROFILE-ACCOUNT TRAINING HABITS NUTRITION SOCIAL | todo |
| TRASH JOBS-12 | todo |
| CONTRACT | todo |
| CUTOVER (docs only) | todo |

## Gates

| Gate | Result |
| --- | --- |
| G-2 drizzle-orm types under TypeScript 7 | **Pass** (2026-10-18): drizzle-orm 0.45.4 typechecks under `typescript@7.0.2` (`tsc --noEmit`), including `db.batch` tuple inference and enum column unions. TS 7 kept; no 5.9 fallback. |

## Decisions

Recorded by the implementing agent; each says why.

1. **Tool versions are the latest stable on 2026-10-18**, not DESIGN §3's pins (which were a floor): hono 4.13.13,
   zod 4.6.7, @hono/zod-validator 0.9.1, drizzle-orm 0.45.4, drizzle-kit 0.31.11, wrangler 4.151.1,
   typescript 7.0.2, @biomejs/biome 2.5.15, fast-check 4.10.2, tsx 4.23.15, pnpm 12.14.0.
2. **`@cloudflare/vitest-plugin` 1.4.4 + vitest 5.0.5 instead of `@cloudflare/vitest-pool-workers` + vitest 4.**
   The pool package is deprecated and renamed; the plugin's peer range is `vitest ^4.1.0 || ^5.0.0`, so the latest
   vitest is supported. The plugin has no `isolatedStorage` option: storage is isolated per test file, and tests
   create their own users rather than relying on an empty database (CONVENTIONS.md).
3. **No `PLAN` var and no `lib/budget.ts` plan branching** (OWNER-DECISIONS: Workers Paid). Limits that DESIGN put in
   the budget table become plain constants in the module that uses them, at the Paid values.
4. **`MAILER` is `cloudflare` | `console`** with the `send_email` binding `EMAIL`; Brevo and `BREVO_API_KEY` are gone.
5. **Runtime types**: `wrangler types --env-file .dev.vars.example` generates `worker-configuration.d.ts` (committed;
   CI runs `--check`). The env file is passed explicitly so a developer's leftover Python `.env` never leaks into
   the generated `Env` type; tests also disable `.env`/`.dev.vars` loading for the same reason.
6. **Resource ids in `wrangler.jsonc` are zero-UUID placeholders** until the cutover unit creates the databases
   (`wrangler d1 create pacestreak --location apac`). D1's location hint is a creation-time flag, not a config field.
7. **gitleaks scans the working tree** (`gitleaks dir`), not history: the Python history predates the rule and is
   not what this branch ships. Runs from the pinned container image, no licence key needed.
8. **The Python tree is deleted on `next`**; `docs/rewrite/python-tests/` keeps a copy of the pytest suite for the
   name-parity script and as porting reference. Old code: `git show main:<path>`.

9. **Schema (F1)**: 69 tables = the 60 ported + `sessions`, `rate_counters`, `job_leases`, `import_jobs`,
   `export_jobs`, `stat_days`, `stat_weeks`, `records_best`, `sync_seq`. Column names are snake_case through Drizzle's
   `casing: "snake_case"` (set once in `drizzle.config.ts` and `src/db/client.ts`).
10. **No `WITHOUT ROWID`**: drizzle-kit cannot emit it, and hand-editing generated migrations would break the drift
    check. `stat_days`, `stat_weeks`, `records_best` are rowid tables with a composite PRIMARY KEY (one extra
    autoindex per table; lookups still use the PK index).
11. **`user_stats.rev` is both the recompute concurrency token and the ETag version** (DESIGN named two columns
    that always change together).
12. **Auth tables are redesigned, not ported** (no data to keep): `refresh_tokens` hangs off `sessions`
    (cascade), `one_time_tokens.code_hmac` and `recovery_codes.code_hmac` hold HMACs, `users.totp_secret` holds
    AES-GCM `v1.<iv>.<ct>`.
13. **`sync_seq` and `job_leases` are self-seeding UPSERTs**; no seed migration. `stat_days`/`stat_weeks`
    `chain_id` is a chain id or `""` for the whole-life aggregate, so it is not a foreign key.
14. **Indexes**: per-user name lookups use composite `(user_id, name_fold)` indexes instead of a lone `user_id`
    index; a schema test asserts every foreign key column leads some index and every fold column (except
    `journal_days.note_fold`, which is only searched with `contains`) is indexed.
15. **D1 refuses pragma table-valued functions** (`pragma_foreign_key_list(x)` in a join gives `SQLITE_AUTH`);
    plain `PRAGMA foreign_key_list("x")` statements work, so the schema tests batch one per table.

## Test counts (vs 285 pytest)

## Owner to-do
