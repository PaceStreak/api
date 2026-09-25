.PHONY: keys vapid dev up down logs ps clean install migrate migrate-local migration current history downgrade run worker test lint create-admin set-password backup restore-check prod-up prod-config

# Generates the RS256 keypair access tokens are signed with. Not committed -
# see .gitignore - so every environment (including CI, if it ever runs the
# app rather than just linting it) needs its own.
keys:
	mkdir -p keys
	openssl genrsa -out keys/private.pem 2048
	openssl rsa -in keys/private.pem -pubout -out keys/public.pem
	@echo "keys/private.pem and keys/public.pem written."

# The VAPID key identifies this server to browsers' push services. Without it
# push is simply off; in-app and email notifications still work.
vapid:
	mkdir -p keys
	openssl ecparam -name prime256v1 -genkey -noout -out keys/vapid_private.pem
	@echo "keys/vapid_private.pem written."

dev:
	docker compose up --build

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api

ps:
	docker compose ps

# Stops the stack and deletes both data volumes (Postgres and Redis).
clean:
	docker compose down -v

install:
	uv sync

# Applies migrations to the DATABASE_URL in .env, without containers.
migrate-local:
	uv run alembic upgrade head

migrate:
	docker compose exec api alembic upgrade head

migration:
	docker compose exec api alembic revision --autogenerate -m "$(m)"

current:
	docker compose exec api alembic current

history:
	docker compose exec api alembic history

downgrade:
	docker compose exec api alembic downgrade -1

run:
	uv run fastapi dev app/main.py

# Reminders, digests, streak refreshes. `docker compose up` runs it as the
# worker service; this is the no-containers equivalent.
worker:
	uv run python -m app.worker

test:
	docker compose exec api pytest


lint:
	uv run ruff check app tests
	uv run ruff format --check app tests

# Operator commands. Passwords are prompted for, never passed as arguments.
#   make create-admin email=you@example.com
create-admin:
	docker compose exec api python -m app.cli create-admin $(email)

set-password:
	docker compose exec api python -m app.cli set-password $(email)

# Dump Postgres into ./backups (BACKUP_DIR), then prove the dump restores.
backup:
	scripts/backup.sh
	scripts/restore-check.sh

restore-check:
	scripts/restore-check.sh $(file)

# Production, on any Docker host with a reverse proxy in front. Needs a .env
# with the required secrets; `make prod-config` names any that are missing.
PROD = docker compose -f compose.yaml -f compose.prod.yaml

prod-config:
	$(PROD) config -q && echo "compose.prod.yaml: configuration OK"

prod-up:
	$(PROD) up -d --build --wait
