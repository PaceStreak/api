#!/bin/sh
# Restore a dump OVER the live database. Destructive; asks first.
#
#   scripts/restore.sh path/to/file.dump
#
# Stop the api and worker first so nothing writes mid-restore:
#   docker compose stop api worker && scripts/restore.sh X && docker compose start api worker
set -eu

cd "$(dirname "$0")/.."
dump="${1:?usage: scripts/restore.sh path/to/file.dump}"
DB="${POSTGRES_DB:-pacestreak}"
DB_USER="${POSTGRES_USER:-pacestreak}"
COMPOSE="${COMPOSE:-docker compose}"

[ -f "$dump" ] || { echo "restore: $dump not found" >&2; exit 1; }
if [ -f "$dump.sha256" ]; then
    ( cd "$(dirname "$dump")" && sha256sum -c --quiet "$(basename "$dump").sha256" )
fi
if [ "${CONFIRM:-}" != "yes" ]; then
    printf 'This replaces every row in "%s" with %s. Type the database name to continue: ' "$DB" "$dump"
    read -r answer
    [ "$answer" = "$DB" ] || { echo "restore: aborted"; exit 1; }
fi

$COMPOSE exec -T postgres pg_restore -U "$DB_USER" -d "$DB" --clean --if-exists \
    --no-owner --single-transaction --exit-on-error < "$dump"
echo "restore: done. Restart api and worker, and flush Redis's user cache:"
echo "  $COMPOSE exec redis redis-cli --scan --pattern 'auth:user:*' | xargs -r $COMPOSE exec -T redis redis-cli del"
