"""E2E test suite (M12) — docs/implementation-spec/06-quality-delivery.md §8.

Hits the LIVE running services (portal-api:8000, agent-runtime:8100,
indexing-runtime:8200, search-runtime:8300, distribution-service:8400,
office-mcp-server:8500, Ollama:11434) with real embeddings/generation —
see `conftest.py` module docstring for why fakes would not have caught the
2026-08-06 chunking regression this suite exists to prevent.
"""
