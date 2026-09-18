.PHONY: keys dev up down logs ps clean install migrate migrate-local migration current history downgrade run test

# Generates the RS256 keypair access tokens are signed with. Not committed -
# see .gitignore - so every environment (including CI, if it ever runs the
# app rather than just linting it) needs its own.
keys:
	mkdir -p keys
	openssl genrsa -out keys/private.pem 2048
	openssl rsa -in keys/private.pem -pubout -out keys/public.pem
	@echo "keys/private.pem and keys/public.pem written."

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

test:
	docker compose exec api pytest
