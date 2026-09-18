#!/bin/sh
#
# Container entrypoint.
#
# Picks between FastAPI's two server commands based on $APP_MODE, so the same
# image runs in development and production and the only thing that changes is
# an environment variable in the compose file.
#
#   fastapi dev   reload on, single process, verbose        APP_MODE=dev
#   fastapi run   reload off, optional workers, quieter     APP_MODE=prod
#
# Anything passed as arguments is executed instead, so the image stays usable
# for one-off work:
#
#   docker compose run --rm api sh
#   docker compose run --rm api python -m alembic upgrade head

set -eu

APP_MODE="${APP_MODE:-prod}"
APP_MODULE="${APP_MODULE:-app.main:app}"
APP_PORT="${APP_PORT:-8000}"

# 0.0.0.0, always, and deliberately.
#
# `fastapi run` already defaults to 0.0.0.0, but `fastapi dev` defaults to
# 127.0.0.1 - correct on a laptop, wrong in a container, where it means the
# port is published but nothing outside the container can ever reach it. The
# symptom is a connection reset with a perfectly healthy-looking log, so it is
# set explicitly here rather than left to the command's default.
APP_HOST="${APP_HOST:-0.0.0.0}"

# An escape hatch beats a rebuild.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

# An empty environment variable is NOT the same as an unset one, and uvicorn
# reads both of these directly from the environment regardless of what this
# script passes on the command line.
#
# uvicorn does `if "WEB_CONCURRENCY" in os.environ: int(os.environ[...])` - a
# presence check, not a truthiness check - so WEB_CONCURRENCY="" crashes the
# server at startup with `invalid literal for int() with base 10: ''`. Compose
# sets exactly that when you write `WEB_CONCURRENCY: ${WEB_CONCURRENCY:-}`,
# which looks like a sensible default and is a crash loop.
#
# Unsetting here means the trap is closed no matter where the empty value came
# from: compose, a Cloud Run variable left blank in the console, or a CI job.
[ -z "${WEB_CONCURRENCY:-}" ] && unset WEB_CONCURRENCY || true
[ -z "${FORWARDED_ALLOW_IPS:-}" ] && unset FORWARDED_ALLOW_IPS || true

# Opt-in so the entrypoint does not silently run DDL on every boot - with more
# than one replica, every replica would run it at once. Alembic is the only
# thing allowed to change the schema; see README.md#migrations.
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
    echo "entrypoint: running migrations"
    alembic upgrade head
fi

case "$APP_MODE" in
    dev)
        echo "entrypoint: starting in DEVELOPMENT mode (reload on) on ${APP_HOST}:${APP_PORT}"
        # No --workers here: it is mutually exclusive with reload, and
        # `fastapi dev` does not accept it at all.
        exec fastapi dev \
            --host "$APP_HOST" \
            --port "$APP_PORT" \
            --entrypoint "$APP_MODULE"
        ;;

    prod)
        echo "entrypoint: starting in PRODUCTION mode on ${APP_HOST}:${APP_PORT}"

        set -- --host "$APP_HOST" --port "$APP_PORT" --entrypoint "$APP_MODULE"

        # Leave WEB_CONCURRENCY unset on a platform that scales by running more
        # containers - Cloud Run, Fly, Railway. Workers inside a container that
        # the platform is already replicating multiplies memory for nothing.
        if [ -n "${WEB_CONCURRENCY:-}" ]; then
            set -- "$@" --workers "$WEB_CONCURRENCY"
        fi

        # Proxy headers are on by default, but uvicorn only trusts them from
        # the addresses listed here. Behind Cloudflare plus a platform load
        # balancer the immediate peer is not a stable address, so this is
        # usually the LB's subnet or, on a trusted-network platform, "*".
        # Trusting "*" on a directly-exposed service lets a caller forge
        # X-Forwarded-For, so set it deliberately.
        if [ -n "${FORWARDED_ALLOW_IPS:-}" ]; then
            set -- "$@" --forwarded-allow-ips "$FORWARDED_ALLOW_IPS"
        fi

        exec fastapi run "$@"
        ;;

    *)
        echo "entrypoint: APP_MODE must be 'dev' or 'prod', got '${APP_MODE}'" >&2
        exit 64
        ;;
esac
