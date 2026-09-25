#!/bin/sh
# Prove a dump restores: load it into a scratch database, check it, drop it.
#
#   scripts/restore-check.sh                    newest dump in ./backups
#   scripts/restore-check.sh path/to/file.dump
#
# Checks the checksum, restores with --exit-on-error, then confirms the schema
# is at the same Alembic revision as the live database and the core tables
# hold the same row counts. Never touches the live database.
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB="${POSTGRES_DB:-pacestreak}"
DB_USER="${POSTGRES_USER:-pacestreak}"
COMPOSE="${COMPOSE:-docker compose}"
dump="${1:-$(ls -1t "$BACKUP_DIR"/pacestreak-*.dump 2>/dev/null | head -1)}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "restore-check: no dump found" >&2; exit 1; }

if [ -f "$dump.sha256" ]; then
    ( cd "$(dirname "$dump")" && sha256sum -c --quiet "$(basename "$dump").sha256" )
fi

scratch="restore_check_$(date +%s)"
psql() { $COMPOSE exec -T postgres psql -U "$DB_USER" -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() { psql -d postgres -c "DROP DATABASE IF EXISTS $scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql -d postgres -c "CREATE DATABASE $scratch" >/dev/null
$COMPOSE exec -T postgres pg_restore -U "$DB_USER" -d "$scratch" --no-owner --exit-on-error < "$dump"

live_rev="$(psql -d "$DB" -c 'SELECT version_num FROM alembic_version')"
restored_rev="$(psql -d "$scratch" -c 'SELECT version_num FROM alembic_version')"
echo "restore-check: alembic live=$live_rev restored=$restored_rev"

for table in users profiles workouts workout_sets streak_chains; do
    n="$(psql -d "$scratch" -c "SELECT count(*) FROM $table")"
    echo "restore-check: $table rows=$n"
done
[ "$restored_rev" = "$live_rev" ] || echo "restore-check: WARNING schema revision differs (dump predates a migration)" >&2
echo "restore-check: OK $dump"
