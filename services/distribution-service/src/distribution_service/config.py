"""Environment-backed settings — mirrors `portal_api.config.Settings` and
`indexing_runtime`'s `INDEX_BASE` env var (see `docs/implementation-spec/
01-portal-and-distribution.md` task brief: "services take paths/URLs from
env-backed settings").

All paths are shared-filesystem absolute paths in this PoC (same assumption
`portal_api.config.storage_root`/`index_base` already make for talking to
indexing-runtime) — distribution-service and portal-api run on the same host.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/


class Settings(BaseSettings):
    # Where portal-api saved uploaded Knowledge (and, in principle, other
    # asset type) package files: storage_root/{asset_type}/{asset_id}/{version}/
    storage_root: Path = _REPO_ROOT / "apps" / "portal-api" / "storage"

    # Where indexing-runtime wrote chroma/, bm25.pkl, parents.json,
    # index-meta.json, keyed by AssetVersion id.
    index_base: Path = _REPO_ROOT / "data" / "indexes"

    # Standard Agent/Prompt/Office Profile local copies (D-034): the Hosted
    # Knowledge Chatbot flow always uses these regardless of the
    # agent_ref/prompt_bindings id in the Service Definition, because
    # agent-runtime itself does the same (`agent_runtime.manifests
    # .load_standard_config`) — Agent/Prompt Registry lookups are not yet
    # implemented. Read-only: never imports agent_runtime's Python package
    # (that would violate CLAUDE.md 구현 원칙 2), only its static config files.
    agent_runtime_config_root: Path = _REPO_ROOT / "services" / "agent-runtime" / "config"

    # Where finished Offline Bundle ZIPs are written, one object_id-keyed
    # directory per bundle (see storage.py FileSystemStorageAdapter).
    bundle_output_root: Path = _REPO_ROOT / "data" / "bundles"

    # Hard cap for total uncompressed bundle content — PACKAGE_SIZE_LIMIT_EXCEEDED.
    # D-018: "정책 설정, 실제 제한은 환경 측정" — PoC default, not measured.
    max_bundle_size_bytes: int = 2 * 1024 * 1024 * 1024  # 2 GiB

    class Config:
        env_prefix = "DISTRIBUTION_"


settings = Settings()
