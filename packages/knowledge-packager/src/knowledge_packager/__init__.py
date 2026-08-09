"""Knowledge Packager — M09: Package Assembler (04-knowledge-platform.md
§4.1/§4.2).

Assembles a Knowledge Package *directory* (manifest + Source Manifest +
checksummed index artifacts) from one `data/indexes/{AssetVersion id}/`
directory written by services/indexing-runtime, and verifies it against the
seven §4.1 checks. Never imports `indexing_runtime`/`search_runtime`/
`portal_api` (CLAUDE.md 구현 원칙 2) — it only reads the on-disk artifacts
those modules already write (JSON files, a Chroma collection via the
`chromadb` client) and never unpickles `bm25.pkl` (see `bm25_inspect`
module docstring and open-decisions.md D-054).
"""

from knowledge_packager.builder import BuildError, BuildResult, build, verify
from knowledge_packager.models import (
    NOT_RECORDED,
    CheckResult,
    SourceDocumentEntry,
    VerificationReport,
)
from knowledge_packager.policy import PackagePolicy, PackagePolicyError, load_policy

__all__ = [
    "NOT_RECORDED",
    "BuildError",
    "BuildResult",
    "CheckResult",
    "PackagePolicy",
    "PackagePolicyError",
    "SourceDocumentEntry",
    "VerificationReport",
    "build",
    "load_policy",
    "verify",
]
