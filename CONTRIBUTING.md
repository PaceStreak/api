# Contributing

See the [organization guide](https://github.com/PaceStreak/.github/blob/main/CONTRIBUTING.md)
for anything general. This file covers what is specific to the API.

## Setup

```bash
uv sync --locked --all-groups   # make install
uv run pre-commit install       # make dev
```

You do not need Python installed first. uv fetches the interpreter named in
`.python-version`. There is no `pip`, no `requirements.txt`, and no manual
virtualenv step — if you find yourself reaching for one, something is wrong.

## The loop

| Command | What it does |
| --- | --- |
| `make run` | uvicorn with reload on `http://127.0.0.1:8000` |
| `make check` | Everything CI runs: ruff, ty, pytest, format check |
| `make format` | `ruff format` plus `ruff check --fix` |
| `make cov` | HTML coverage report |
| `make docker` | Build the image (needs BuildKit) |

`make check` and CI run the same commands. If it passes here it passes there.

## Adding a dependency

```bash
uv add fastapi-limiter          # runtime
uv add --group dev pytest-mock  # development only
```

Never edit `uv.lock` by hand and never `pip install` into `.venv` — CI runs
`uv sync --locked`, which fails if the lockfile has drifted from
`pyproject.toml`. A pre-commit hook checks the same thing before you push.

Prefer explicit extras over convenience bundles. This project deliberately does
not use `fastapi[all]`, which pulls jinja2, orjson, ujson and python-multipart
that nothing here imports. Every dependency is one more thing to patch.

## Non-negotiables

These come from decisions already made elsewhere and will fail review if broken:

- **Routes are versioned.** `/v1/…` for anything client-facing. `/health` is
  the exception and is outside `/v1` on purpose — it is operational, and the
  uptime monitor should not have to move when `/v2` ships.
- **Cookies go through `app/security.py`.** Do not call `set_cookie` directly.
  The attributes — `__Secure-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`,
  `Domain=pacestreak.com` — are asserted in `tests/test_security.py`, and that
  is the point: the rules live in a test, not only in a document.
- **CORS sends an explicit origin**, never a wildcard. `Settings` raises if you
  try, because with credentials a wildcard is a *blocked* request rather than a
  permissive one.
- **No secret may have a working default** in `config.py`. A default that works
  in production is a secret that has been committed.
- **Export exists.** The product promises full JSON and CSV export. If a schema
  change makes export harder, that is a design problem, not a later chore.

## Tests

`pytest` runs with `filterwarnings = ["error"]`. This is not pedantry — it is
what caught Starlette's move from `httpx` to `httpx2` during setup, which would
otherwise have surfaced as an unexplained failure much later.

Coverage is 100% today. Keep it meaningful: a test that asserts a documented
constraint is worth writing, a test that exercises a line to move a number is
not.

## When you add the first endpoint

Do these in the same pull request, or the frontend breaks silently:

1. Widen `connect-src` in [`PaceStreak/app`](https://github.com/PaceStreak/app)'s
   `public/_headers` to include `https://api.pacestreak.com`. The CSP is
   `default-src 'self'`, so the browser blocks the call with no visible error on
   the page.
2. Register the health endpoint in
   [`PaceStreak/status`](https://github.com/PaceStreak/status) with a **body
   content assertion** — a 200 alone does not prove the service works.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`). The
subject line says what changed; the body says **why**, because the what is
already in the diff.

## Security

Do not open an issue for a vulnerability. Email **<hello@pacestreak.com>** —
see [SECURITY.md](./SECURITY.md).
