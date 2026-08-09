"""Security E2E test suite (M12) — docs/implementation-spec/05-mcp-security-governance.md
§12 (M11 보안 원칙) and §13 (위협 시나리오).

Hits the LIVE running services (portal-api:8000, agent-runtime:8100,
office-mcp-server:8500, ...) exactly like `tests/e2e/` — see this package's
`conftest.py` module docstring for why this suite reuses `tests/e2e/conftest.py`
wholesale instead of re-implementing its own liveness gate / cleanup.
"""
