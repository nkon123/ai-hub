"""Evaluation Runner settings — env-backed, mirrors `agent_runtime.config`'s
and `distribution_service.config`'s `Settings(BaseSettings)` pattern.

All paths are shared-filesystem absolute paths in this PoC, same assumption
`distribution_service.config.Settings.index_base` already makes for reading
services/indexing-runtime's output without importing that module's Python
package (CLAUDE.md 구현 원칙 2: 모듈 간 내부 폴더 직접 Import 금지 — reading
a JSON file that another module wrote is not a Python import).
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/


class EvaluationRunnerSettings(BaseSettings):
    # services/search-runtime's POST /search/v1/query base URL (M08).
    search_runtime_url: str = "http://localhost:8300"

    # Per-request timeout for the HTTP SearchClient adapter.
    request_timeout_seconds: float = 30.0

    # Default top_k when a CLI invocation does not override it.
    default_top_k: int = 5

    # Default hybrid alpha (vector vs BM25 weight) — matches search_runtime's default.
    default_alpha: float = 0.5

    # Where services/indexing-runtime wrote index-meta.json, keyed by AssetVersion id.
    # Read-only, for Data Card generation only — never imported as a Python package.
    index_base: Path = _REPO_ROOT / "data" / "indexes"

    # Default Quality Gate policy file (§4.7 — thresholds live here, not in code).
    default_quality_gate_policy: Path = (
        Path(__file__).resolve().parent.parent.parent / "config" / "quality-gate.yaml"
    )

    class Config:
        env_prefix = "EVALUATION_RUNNER_"


settings = EvaluationRunnerSettings()
