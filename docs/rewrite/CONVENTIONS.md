# Conventions for module units

How to build a unit of the rewrite on top of the foundation (F0-F3). Read
`OWNER-DECISIONS.md` and the unit's entry in `WORKPLAN.json` first; this file
is the "how", `DESIGN.md` is the "why". When this file and `DESIGN.md`
disagree, this file wins (it records what the foundation actually does).
Anything you decide that the next agent needs goes in `PROGRESS.md` under
"Decisions".

## 1. Where code goes

```text
src/
  index.ts            Worker entry (fetch, scheduled, queue). P1-JOBS fills scheduled/queue.
  app.ts              createApp(): middleware order, error boundary, 404/405, body limits (BODY_LIMITS).
  routes.ts           mountRoutes(): mounts each module's sub-app, in the Python router order (spec/core.md §0).
  env.ts              Config (parsed env) + SETTINGS (product constants such as termsVersion).
  ctx.ts              Ctx, AppEnv, AuthedEnv.
  db/schema/*.ts      Drizzle tables, one file per area; index.ts re-exports all.
  db/client.ts        createDb(): counted drizzle client.
  db/batch.ts         AuthedBatch, runBatch, writeBatch, guards, withFold, toWire.
  db/explain*.ts      EXPLAIN lint registry (ExplainCase).
  db/fk-users.gen.ts  Generated FK-to-users list (merge/purge).
  lib/                Pure helpers. Never import from modules/. Add new shared helpers here (crypto, mailer,
                      push, r2, ratelimit, turnstile ... per WORKPLAN Phase 1).
  catalog/            Frozen data + lookup maps (exercise library, achievements, quests, templates).
  heavy/              Pure parsers/writers (multipart, csv, gpx, fit, account json, zip).
  jobs/               Cron dispatchers, queue consumer router, the 12 jobs.
  modules/<name>/
    routes.ts         Hono sub-app: validation middleware + thin handlers.
    service.ts        Business logic. The ONLY file another module may import.
    repo.ts           Query builders (functions returning un-awaited drizzle queries) + `explain` export.
    schemas.ts        zod request/response schemas.
    *.test.ts         Optional unit tests next to the code; route/parity tests go in test/.
```

`pnpm check:deps` enforces: `modules/X` imports `modules/Y` only through
`modules/Y/service.ts`; `lib/`, `db/`, `catalog/`, `heavy/` never import
`modules/`; nothing in `modules/` mentions `env.DB`.

Module names (match WORKPLAN): `auth profile account training game habits
insights nutrition social groups notifications search admin ops trash`.

## 2. A route, end to end

```ts
// src/modules/habits/routes.ts
import { Hono } from "hono";
import type { AuthedEnv } from "../../ctx.ts";
import { json, param } from "../../lib/validation.ts";
import { CreateHabit, HabitId } from "./schemas.ts";
import * as service from "./service.ts";

export const habitsRoutes = new Hono<AuthedEnv>()
  .post("/", json(CreateHabit), async (c) => {
    const habit = await service.create(c.var.ctx, c.var.authed, c.req.valid("json"));
    return c.json(habit, 201);
  })
  .delete("/:id", param(HabitId), async (c) => {
    await service.remove(c.var.ctx, c.var.authed, c.req.valid("param").id);
    return c.body(null, 204);
  });
```

Mount it in `src/routes.ts` behind the auth middleware (the AUTH unit adds
`auth()`, `optionalAuth()`, `moderator()`, `admin()`; they attach
`c.var.authed`): `app.route("/v1/habits", habitsRoutes)`. Keep handlers thin:
parse, call the service, shape the response.

- Paths are exactly the Python paths (`spec/*.md` tables). Order of mounting
  matters when two patterns overlap: register the literal path first
  (`/v1/workouts/batch` before `/v1/workouts/:id`).
- Status codes and `detail` texts are copied verbatim from the spec.
- Responses are plain objects built by the service, with snake_case keys as
  the app expects, timestamps through `toWire(ms)`, dates as `YYYY-MM-DD`.

## 3. D1 access: read batch, then write batch

Every request spends **one read round trip and at most one write round
trip** (DESIGN.md §17). Never `await` a query builder inside a loop; build
the statements, then send them together.

```ts
// repo.ts: functions return un-awaited builders. Awaiting a builder executes it immediately (a bug here).
export const listHabits = (db: Db, userId: string) =>
  db.select().from(habits).where(and(eq(habits.userId, userId), isNull(habits.archivedAt)))
    .orderBy(habits.position, habits.nameFold);

// service.ts
export async function list(ctx: Ctx, authed: AuthedBatch) {
  const [me, rows, logs] = await authed.read(repo.listHabits(ctx.db, authed.userId), repo.recentLogs(ctx.db, authed.userId));
  return rows.map(toHabitOut);
}

export async function create(ctx: Ctx, authed: AuthedBatch, input: CreateHabitIn) {
  const now = ctx.clock.now();
  const [inserted] = await authed.write(
    ctx.db.insert(habits).values(withFold(habits, { ...input, userId: authed.userId, createdAt: now, updatedAt: now }))
      .returning(),
  );
  return toHabitOut(inserted[0]);
}
```

- `authed.read(...q)` returns `[authUser, ...results]`; statement 0 is the
  session/user check and throws the exact Python 401s. `authUser` has `id,
  email, role, isActive, isVerified, tokenVersion`. Use `authed.read()` with
  no statements when a handler only needs the caller.
- `authed.write(...q)` runs atomically with a session guard first; if the
  session died since the read, the batch aborts and the caller gets 401.
  Results exclude the guard.
- `writeBatch(ctx, [q...])` is the commit path without a session (signup,
  jobs). `runBatch(db, [q...])` is the primitive; use it for reads outside
  auth (jobs, health).
- Raw SQL is fine where the builder can't express it: `ctx.db.run(sql\`...\`)`
  inside `runBatch`/`authed.*` (drizzle's own `db.batch` crashes on those; ours
  does not). Use `${col}` and `${value}` interpolation, never string concat.
- **Alias duplicate column names in joins**: D1 returns batch rows keyed by
  column name, so selecting `users.id` and `sessions.id` together collapses
  them. Use `sql<string>\`${sessions.id}\`.as("session_id")`.
- Check-then-insert races are closed by UNIQUE constraints: any constraint
  failure becomes 409 "That was saved twice at once. Try again." in the error
  boundary. Catch it yourself only when the spec gives a different text
  (`isConstraintError(err)`).
- D1 binds at most **100 parameters per statement**. Chunk `IN (...)` lists
  and multi-row inserts (`rowsPerInsert(columns)` in
  `test/fixtures/heavy-user-data.ts` shows the arithmetic).
- Conditional writes inside one batch use explicit predicates
  (`WHERE EXISTS (...)`, `ON CONFLICT ... DO UPDATE ... WHERE`), never
  `changes()`. Gate G-3 tests the semantics you can rely on: a later
  statement sees an earlier one's effect; any failure rolls back the batch;
  `ON CONFLICT DO NOTHING RETURNING` is empty on a duplicate.
- Workouts: `sync_seq` is bumped with
  `INSERT INTO sync_seq (id, value) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1`
  and read in the same batch with `(SELECT value FROM sync_seq WHERE id = 1)`;
  one bump per row (see `test/db/batch.test.ts`).
- Per-user rate limits (P1-GUARD owns the helper): counter UPSERT then
  `rateLimitGuard(key, limit)` in the same write batch; the guard aborts with
  429 "Slow down - try again in a little while.".

### Columns and values

- Timestamps are INTEGER epoch ms: always pass `ctx.clock.now()` for
  `createdAt`/`updatedAt` and every `*At` you set (tests freeze the clock).
- Ids: `uuid7(ctx.clock.now())` or the client-supplied UUID where the spec
  allows it (workouts, weigh-ins, meal entries, body photos, trash restores).
- JSON columns are typed with `json<T>()`; validate with zod before writing.
- Fold columns (`*Fold`) are written only through `withFold(table, values)`
  (inserts; the type forbids passing them yourself) and
  `withFoldPatch(table, patch)` (updates). Search with
  `.where(foldLike(t.nameFold, term, "prefix"))` (folds the term, escapes
  `\ % _`, adds `ESCAPE`); `"contains"` cannot use the index. Sort by
  `nameFold, name`.
- Emails are stored trimmed and lowercased (Python parity), not folded.
- Booleans are `boolean` in TS; raw SQL compares `= 1`.

### Indexes and the EXPLAIN lint

Every statement shape in a `repo.ts` is registered:

```ts
export const explain: ExplainCase[] = [
  { name: "habits.listHabits", build: (db) => listHabits(db, "u") },
  { name: "admin.searchUsers", build: (db) => searchUsers(db, "q"), scanOk: "admin-only, LIMIT 50" },
];
```

`test/explain/explain.test.ts` picks it up automatically and fails on a full
scan of a user-data table without `scanOk`. Need an index? Add it in the
schema file, then `pnpm db:generate --name <what>` (a new numbered
migration; never edit a migration that is already on `next`... except
`0000_init.sql` before cutover, which may be regenerated from scratch while
nothing is deployed) and `pnpm db:fk-users`.

## 4. Errors and validation

- Throw `new HttpError(status, "detail text")` (or the helpers `badRequest`,
  `unauthorized`, `forbidden`, `notFound`, `conflict`, `slowDown`,
  `ipRateLimited(limit)`); the boundary renders `{"detail": ...}`. `detail`
  may be an object or list where the spec says so.
- Validation middleware from `lib/validation.ts`: `json(schema)`,
  `query(schema)`, `param(schema)`. Failures are FastAPI-shaped 422s with
  pydantic messages. Write schemas so the messages come out right:

| pydantic | zod |
| --- | --- |
| `str = Field(min_length=1, max_length=60)` | `z.string().min(1).max(60)` |
| `int = Field(ge=1, le=10)` | `z.int().min(1).max(10)` (`.gt()`/`.lt()` for strict) |
| `float` | `z.number()` |
| `Literal["a","b"]` / enum | `z.enum(["a","b"])` or `z.literal([...])` |
| `EmailStr` | `z.email()` |
| `list[X] = Field(max_length=200)` | `z.array(X).max(200)` |
| `X \| None = None` | `X.nullable().optional()` (+ `.default(null)` when the handler needs it) |
| `@field_validator` raising `ValueError("msg")` | `.refine(fn, "msg")` / `.superRefine` (rendered as `Value error, msg`) |
| query `int` | `z.coerce.number().int()` |

- Objects are non-strict (unknown keys dropped), like pydantic. Do not use
  `.strict()`.
- Over-length strings are 422 (intentional change, DESIGN §19); copy the old
  `varchar(n)` sizes into `.max(n)`.

## 5. Tests

- Runner: `pnpm vitest run` (workerd, real local D1/R2/Queues). Each test
  file gets its own D1 with migrations applied (`test/setup.ts`); tests in a
  file share it, so **always create your own users** (fixtures make unique
  emails) and never assume an empty table.
- **Ported pytest tests keep their name**: the `it()` title is the pytest
  name without `test_`, e.g. `it("a_500_still_carries_cors_headers", ...)`,
  or a descriptive title containing the full `test_name`. Put them in
  `test/parity/<python file name without .py>.test.ts` (e.g.
  `test/parity/test_habits.test.ts`). A pytest test that no longer applies
  gets a comment `// parity-dropped: test_name: <reason>` in the matching
  parity file. An intentional behaviour change keeps a test titled
  `changed: <name> ...` and is listed in `CHANGES-FROM-PYTHON.md`.
  `pnpm check:parity --list` shows what is missing; lower `maxMissing` in
  `test/parity.json` in the same commit (CI ratchet).
- Fixtures (`test/fixtures/`):
  - `authed(opts)` -> `{ user, batch, t }`: a seeded user + live session +
    `AuthedBatch` for service-level tests (works now).
  - `seedUser(db, opts)`, `testDb()` (counted client with `reset()`),
    `uniqueEmail()`.
  - `signup()` / `login()`: HTTP fixtures, implemented by the AUTH unit (they
    throw until then).
  - `api(path, { json, token, headers, method })` and `jsonOf(res)`: calls
    through the real Worker (`SELF`).
  - `useFixedClock(ms)` / `T0`: deterministic time for every `Ctx`.
  - `mockFetch(match, handler)` / `mockJson(...)`: **all outbound fetch is
    blocked** unless mocked (Turnstile, Open Food Facts, push services).
  - `SoftAuthenticator` (`test/soft-webauthn.ts`): real ES256 passkey
    registration/assertion JSON for passkey routes.
  - `seedHeavyUser(opts)`: 5 years / 3,000 workouts / ~30,000 sets / 20 habits
    / 2,000 logs, for budget and bench suites (pass smaller numbers in
    ordinary tests).
- **Round-trip budgets**: route tests assert
  `expectRoundTrips(res, n)` (the app sets `X-D1-Round-Trips` in the test
  environment only); service tests assert on `t.stats` after `t.reset()`.
  Budgets: auth-gated read 1, simple write 1-2, workout write 2, refresh 2,
  password routes 2 (DESIGN.md §17). Run the budget suite for list/snapshot
  routes against `seedHeavyUser()` so N+1 shows up.
- CPU benches: add `benchCase(name, fn, { budgetMs })` to
  `test/bench/*.bench.ts`; run with `pnpm bench`.
- Queue consumers: `createMessageBatch` / `getQueueResult`; cron:
  `createScheduledController` (from `cloudflare:test`).

## 6. Definition of done for a unit

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm biome ci . && pnpm check:deps
pnpm vitest run && pnpm check:parity
pnpm build                     # wrangler dry run + 400 KiB gzip budget
pnpm drizzle-kit check         # if you touched the schema; plus pnpm db:fk-users
```

Then: update `PROGRESS.md` (unit state, decisions, test counts, `Next step:`),
add every intentional behaviour change and every Python bug you fixed to
`CHANGES-FROM-PYTHON.md` with its test, commit (conventional, body says why,
no AI credit), push `next`.

## 7. Style

- Strict TypeScript: no `any`, no `!` non-null assertions, no
  `@ts-ignore`. `as unknown as` only at a documented library boundary.
- Biome formats; `pnpm format` fixes. Double quotes, semicolons, 110 columns.
- Explicit `.ts` extensions in relative imports.
- Comments explain why, not what. Keep the Python behaviour notes (`spec/...`
  references) where a reader would otherwise "fix" a deliberate quirk.
- Never log bodies, emails, codes or tokens (`ctx.log` is structured JSON).
