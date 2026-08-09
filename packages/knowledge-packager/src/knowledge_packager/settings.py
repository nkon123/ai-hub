"""Knowledge Packager settings — env-backed, mirrors
`evaluation_runner.settings`'s `Settings(BaseSettings)` pattern.

All paths are shared-filesystem absolute paths in this PoC, same assumption
`evaluation_runner.settings.index_base` already makes for reading
services/indexing-runtime's output files without importing that module's
Python package (CLAUDE.md 구현 원칙 2: 모듈 간 내부 폴더 직접 Import
금지 — reading a JSON/Chroma/pickle file that another module wrote is not a
Python import).
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/


class KnowledgePackagerSettings(BaseSettings):
    # Where services/indexing-runtime wrote per-AssetVersion index directories.
    # Read-only — never written to (CLAUDE.md: 승인 Version을 수정하는 코드를
    # 만들지 않는다, and this task's explicit "treat data/indexes/ as
    # strictly read-only" instruction).
    index_base: Path = _REPO_ROOT / "data" / "indexes"

    # Default Package verification policy file (§4.1 checks' severities are
    # policy, not hardcoded — same pattern as evaluation_runner's
    # quality-gate.yaml).
    default_package_policy: Path = (
        Path(__file__).resolve().parent.parent.parent / "config" / "package-policy.yaml"
    )

    class Config:
        env_prefix = "KNOWLEDGE_PACKAGER_"


settings = KnowledgePackagerSettings()
