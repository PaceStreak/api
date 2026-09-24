.PHONY: keys vapid dev up down logs ps clean install migrate migrate-local migration current history downgrade run worker test

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
