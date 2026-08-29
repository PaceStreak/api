# syntax=docker/dockerfile:1.7
#
# Two stages so the runtime image carries no build tooling and no uv binary.
#
# The dependency layer is installed before the source is copied, so editing a
# handler does not reinstall the world - that ordering is the whole reason the
# COPY statements look split up.

ARG PYTHON_VERSION=3.14

# --- build ------------------------------------------------------------------

FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

# Pinned. `:latest` would make the build unreproducible in exactly the way a
# lockfile exists to prevent.
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# WORKDIR is /srv, not /app: the Python package is called `app`, and nesting
# it at /app/app makes every path in this file ambiguous to read.
WORKDIR /srv

# `--locked` fails if uv.lock has drifted from pyproject.toml instead of
# quietly resolving something the tests never ran against.
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

ENV PATH="/srv/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PACESTREAK_ENVIRONMENT=production

USER app

# Cloud Run, Fly and Railway all inject $PORT. Defaulting it keeps
# `docker run -p 8000:8000` working locally without extra flags.
ENV PORT=8000
EXPOSE 8000

# Exec form, so uvicorn is PID 1 and receives SIGTERM directly. Without it the
# shell swallows the signal and the platform waits out its grace period on
# every deploy.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
