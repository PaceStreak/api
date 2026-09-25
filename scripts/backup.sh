#!/bin/sh
# Postgres backup: a compressed custom-format dump, checksummed, with retention.
#
#   scripts/backup.sh                 dump into ./backups (or $BACKUP_DIR)
#   BACKUP_KEEP_DAYS=30 scripts/backup.sh
#
# Runs pg_dump inside the postgres container, so the dump always matches the
# server's major version. Custom format (-Fc) because it restores selectively
# and in parallel; plain SQL does neither.
#
# A backup nobody has restored is a hope, not a backup: run
# scripts/restore-check.sh against every new dump (the prod compose does).
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DB="${POSTGRES_DB:-pacestreak}"
DB_USER="${POSTGRES_USER:-pacestreak}"
COMPOSE="${COMPOSE:-docker compose}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/pacestreak-$stamp.dump"
partial="$target.partial"

# Written to .partial and renamed only on success, so a failed or interrupted
# dump can never be mistaken for a good one - or pruned in favour of it.
$COMPOSE exec -T postgres pg_dump -U "$DB_USER" -d "$DB" -Fc -Z 9 --no-owner > "$partial"
[ -s "$partial" ] || { echo "backup: empty dump, aborting" >&2; rm -f "$partial"; exit 1; }
mv "$partial" "$target"
chmod 600 "$target"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$target")" > "$(basename "$target").sha256" )

echo "backup: wrote $target ($(du -h "$target" | cut -f1))"

# Retention: only complete, checksummed dumps are ever deleted, and never the
# newest one, whatever its age.
newest="$(ls -1t "$BACKUP_DIR"/pacestreak-*.dump | head -1)"
find "$BACKUP_DIR" -name 'pacestreak-*.dump' -mtime "+$KEEP_DAYS" ! -path "$newest" \
    -exec sh -c 'rm -f "$1" "$1.sha256"; echo "backup: pruned $1"' _ {} \;
