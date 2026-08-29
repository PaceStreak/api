# Thin wrappers around uv. Every target here is exactly what CI runs, so
# `make check` passing locally means the pull request passes too.

.DEFAULT_GOAL := help
.PHONY: help install dev run check lint format typecheck test cov docker docker-run clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Create the environment from the lockfile
	uv sync --locked --all-groups

dev: install ## Install git hooks as well
	uv run pre-commit install

run: ## Serve with reload on http://127.0.0.1:8000
	uv run uvicorn app.main:app --reload

lint: ## Ruff lint
	uv run ruff check .

format: ## Ruff format and autofix
	uv run ruff format .
	uv run ruff check --fix .

typecheck: ## ty
	uv run ty check

test: ## pytest with coverage
	uv run pytest

cov: ## pytest with an HTML coverage report
	uv run pytest --cov-report=html
	@echo "open htmlcov/index.html"

check: lint typecheck test ## Everything CI runs
	uv run ruff format --check .

docker: ## Build the container image
	# BuildKit is required: the Dockerfile uses `RUN --mount`.
	DOCKER_BUILDKIT=1 docker build --tag pacestreak-api:local .

docker-run: docker ## Build and run the container image
	docker run --rm -p 8000:8000 pacestreak-api:local

clean: ## Remove caches and build artefacts
	rm -rf .pytest_cache .ruff_cache .ty_cache htmlcov coverage.xml .coverage dist build
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
