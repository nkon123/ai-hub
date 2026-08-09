"""Package verification policy loader — mirrors
`evaluation_runner.quality_gate`'s `load_policy`/`*PolicyError` pattern.

Every forbidden-pattern severity and the fail_on_fatal switch is read from
YAML at run time; this module never contains a hardcoded pattern or
threshold (04-knowledge-platform.md §4.7's "코드에 하드코딩하지 않고 정책
설정으로 관리한다" principle, applied here to §4.1's checks).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class PackagePolicyError(Exception):
    """Raised when a policy file is missing or malformed."""


@dataclass(frozen=True)
class ForbiddenPattern:
    id: str
    regex: re.Pattern[bytes]
    severity: str
    description: str


@dataclass(frozen=True)
class PackagePolicy:
    forbidden_filenames: list[str]
    forbidden_content_patterns: list[ForbiddenPattern]
    known_residual_leak_artifacts: list[str]
    residual_leak_severity_override: str
    fail_on_fatal: bool

    def effective_severity(self, pattern: ForbiddenPattern, file_basename: str) -> str:
        """A pattern's configured severity, downgraded per
        `residual_leak_severity_override` when the match is inside a file
        this policy already knows `knowledge_packager.relativize` cannot
        fully scrub of historical byte-level values (D-054) — `bm25.pkl`
        (never unpickled, so never rewritten) and `chroma.sqlite3` (Chroma's
        internal `embeddings_queue` append-only log retains the original
        pre-relativization metadata even after `Collection.update()`). See
        `knowledge_packager.relativize` module docstring for the full
        explanation of both cases."""
        if file_basename in self.known_residual_leak_artifacts:
            return self.residual_leak_severity_override
        return pattern.severity


def _compile_pattern(entry: dict[str, Any]) -> ForbiddenPattern:
    try:
        pattern_id = str(entry["id"])
        raw_pattern = str(entry["pattern"])
        severity = str(entry["severity"])
    except KeyError as exc:
        raise PackagePolicyError(f"forbidden_content_patterns 항목에 필드 누락: {exc}") from exc
    if severity not in {"FATAL", "WARNING", "INFO"}:
        raise PackagePolicyError(f"알 수 없는 severity: {severity!r} (id={pattern_id})")
    try:
        regex = re.compile(raw_pattern.encode("utf-8"))
    except re.error as exc:
        raise PackagePolicyError(
            f"forbidden_content_patterns[{pattern_id}] 정규식 오류: {exc}"
        ) from exc
    return ForbiddenPattern(
        id=pattern_id,
        regex=regex,
        severity=severity,
        description=str(entry.get("description", "")),
    )


def load_policy(path: str | Path) -> PackagePolicy:
    p = Path(path)
    if not p.exists():
        raise PackagePolicyError(f"Package 정책 파일을 찾을 수 없습니다: {p}")
    with p.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise PackagePolicyError(f"Package 정책 파일이 비어 있거나 형식이 올바르지 않습니다: {p}")

    try:
        patterns = [_compile_pattern(e) for e in data.get("forbidden_content_patterns", [])]
        forbidden_filenames = [str(x) for x in data.get("forbidden_filenames", [])]
        known_residual_leak_artifacts = [
            str(x) for x in data.get("known_residual_leak_artifacts", [])
        ]
        override = str(data.get("residual_leak_severity_override", "WARNING"))
        fail_on_fatal = bool(data.get("verification", {}).get("fail_on_fatal", True))
    except (TypeError, ValueError) as exc:
        raise PackagePolicyError(f"Package 정책 파일 형식이 올바르지 않습니다: {exc}") from exc

    return PackagePolicy(
        forbidden_filenames=forbidden_filenames,
        forbidden_content_patterns=patterns,
        known_residual_leak_artifacts=known_residual_leak_artifacts,
        residual_leak_severity_override=override,
        fail_on_fatal=fail_on_fatal,
    )
