.PHONY: dev lint typecheck test validate-schemas contract-test install e2e-test e2e-clean security-test \
	dev-portal-api dev-portal-web dev-agent-runtime dev-indexing-runtime dev-search-runtime dev-distribution-service dev-office-mcp-server health-check \
	migrate migration migrate-status

install:
	uv sync --all-packages
	pnpm install

lint:
	uv run ruff check .
	pnpm -r lint

typecheck:
	uv run mypy apps/ services/ packages/ tests/
	pnpm -r typecheck

test:
	uv run pytest tests/ -v

contract-test:
	uv run pytest tests/contract/ -v

# tests/e2e/ (M12, 06-quality-delivery.md §8) hits the LIVE service stack
# with real Ollama embeddings/generation -- excluded from `make test` via
# pyproject.toml's `addopts = -m "not e2e"`; `-m e2e` here overrides that.
# Run `make health-check` first (and `ollama serve`) to confirm the stack
# is up -- if it isn't, this suite SKIPS (not fails), see
# tests/e2e/conftest.py::_require_live_services.
e2e-test:
	uv run pytest tests/e2e/ -v -m e2e

# Standalone recovery sweep for e2e- prefixed rows/directories left behind
# in the live `apps/portal-api/portal.db` / `data/indexes/` -- e.g. from a
# run predating tests/e2e/conftest.py's automatic per-test cleanup, or a
# crashed `make e2e-test`. Safe to run any time, with or without the live
# service stack up: it writes directly to the sqlite file (there is no
# DELETE API, by design) and is hard-guarded against ever touching seeded
# demo assets/services/deployments -- see tests/e2e/conftest.py's
# `PROTECTED_*` constants and `sweep_e2e_prefixed_artifacts`.
e2e-clean:
	uv run python -m tests.e2e.conftest

# tests/security/ (M12, 05-mcp-security-governance.md §12/§13) — cross-cutting
# security properties (authn/authz bypass/privilege escalation/injection/
# secret leakage/audit/trace correlation) verified against the LIVE service
# stack, the same execution model as tests/e2e/ (reuses its conftest liveness
# gate and cleanup, see tests/security/conftest.py). Excluded from `make test`
# via pyproject.toml's `addopts = -m "not e2e and not security"`; skips
# cleanly (does not fail) when the live stack isn't up.
security-test:
	uv run pytest tests/security/ -v -m security

validate-schemas:
	uv run validate-manifest --all fixtures/valid/
	@echo "All valid fixtures passed schema validation"

dev-portal-api:
	cd apps/portal-api && uv run uvicorn portal_api.main:app --reload --port 8000

dev-portal-web:
	pnpm --filter portal-web dev

dev-agent-runtime:
	cd services/agent-runtime && uv run uvicorn agent_runtime.main:app --reload --port 8100

dev-indexing-runtime:
	cd services/indexing-runtime && uv run uvicorn indexing_runtime.main:app --reload --port 8200

dev-search-runtime:
	cd services/search-runtime && uv run uvicorn search_runtime.main:app --reload --port 8300

dev-distribution-service:
	cd services/distribution-service && uv run uvicorn distribution_service.main:app --reload --port 8400

dev-office-mcp-server:
	cd services/office-mcp-server && uv run uvicorn office_mcp_server.main:app --reload --port 8500

health-check:
	curl -sf http://localhost:8000/health && echo " portal-api OK"
	curl -sf http://localhost:8100/health && echo " agent-runtime OK"
	curl -sf http://localhost:8200/health && echo " indexing-runtime OK"
	curl -sf http://localhost:8300/health && echo " search-runtime OK"
	curl -sf http://localhost:8400/health && echo " distribution-service OK"
	curl -sf http://localhost:8500/health/live && echo " office-mcp-server OK"

# M02 schema migrations (Alembic, D-043). See "스키마 변경 절차" in
# docs/implementation-spec/progress-log.md: change a model -> `make migration
# name=...` -> review the generated file -> `make migrate`.
migrate:
	cd apps/portal-api && uv run alembic upgrade head

migration:
	@if [ -z "$(name)" ]; then echo "Usage: make migration name=<description>"; exit 1; fi
	cd apps/portal-api && uv run alembic revision --autogenerate -m "$(name)"

migrate-status:
	cd apps/portal-api && uv run alembic current && uv run alembic heads
