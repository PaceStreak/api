# syntax=docker/dockerfile:1.26.0
#
# Two stages, so the runtime image carries no build tooling and no uv binary.
#
# Dependencies are installed before the source is copied, so editing a handler
# rebuilds one small layer instead of reinstalling everything - that ordering
# is the only reason the COPY lines are split up.
#
# Requires BuildKit and buildx for `RUN --mount`. Both are standard in current
# Docker; if `docker buildx version` fails, install the plugin before building.

ARG PYTHON_VERSION=3.14

# --- build ------------------------------------------------------------------

FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

# Pinned. `:latest` would make the build unreproducible in exactly the way a
# lockfile exists to prevent.
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# /srv, not /app: the Python package is called `app`, and nesting it at
# /app/app makes every path in this file ambiguous to read.
WORKDIR /srv

# Manifests are bind-mounted rather than copied, so they never become an image
# layer, and uv's download cache persists across builds instead of being
# re-fetched every time.
#
# `--locked` fails if uv.lock has drifted from pyproject.toml instead of
# quietly resolving something that was never tested.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

COPY README.md ./
COPY app/ ./app/

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-dev

# --- runtime ----------------------------------------------------------------

FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

# Never root. A container escape is a different conversation from a container
# escape as uid 0.
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --create-home app

WORKDIR /srv

COPY --from=builder --chown=app:app /srv/.venv /srv/.venv
COPY --from=builder --chown=app:app /srv/app /srv/app
COPY --chown=app:app docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

ENV PATH="/srv/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_MODE=prod \
    APP_MODULE=app.main:app \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000

USER app

EXPOSE 8000

# The entrypoint chooses `fastapi dev` or `fastapi run` from $APP_MODE and
# execs it, so the server is PID 1 and receives SIGTERM directly. Without the
# exec, a shell swallows the signal and the platform waits out its full grace
# period on every single deploy.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
