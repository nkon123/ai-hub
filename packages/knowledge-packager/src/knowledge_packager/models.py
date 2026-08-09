"""Domain models for the Knowledge Packager (M09).

Plain dataclasses/enums only — no pydantic, no FastAPI (CLAUDE.md 구현
원칙: Python Domain Model과 API Model을 분리한다). Mirrors
`evaluation_runner.quality_gate.GateCheck`/`GateResult`'s shape closely on
purpose: both packages report "named checks with a pass/fail + message",
and a downstream reader (a future Portal screen) should not have to learn
two different result shapes for the same idea.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    """One §4.1 verification check's outcome.

    `passed` already encodes whether this check blocks the build — for the
    forbidden-pattern scanner (the one check with per-finding severity) that
    means "no FATAL-severity finding survived the pickle-artifact severity
    override policy"; WARNING-severity findings are recorded in `details`
    but do not flip `passed` to False. Every other check is a structural
    fact (counts reconcile, ids match, files exist) that is unconditionally
    build-blocking when false.
    """

    name: str
    passed: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "message": self.message,
            "details": self.details,
        }


@dataclass(frozen=True)
class VerificationReport:
    checks: list[CheckResult]

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def failed_checks(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.passed]

    def to_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "checks": [c.to_dict() for c in self.checks]}


@dataclass(frozen=True)
class SourceDocumentEntry:
    """One row of the Source Manifest (04-knowledge-platform.md §4.2).

    Field names are verbatim from §4.2. Any field the pipeline cannot
    honestly populate today is set to the literal sentinel string
    `NOT_RECORDED` ("미기재") — same discipline as
    `evaluation_runner.data_card` — never a fabricated or guessed value.
    """

    document_id: str
    display_name: str
    relative_source_path: str
    source_hash: str
    source_version: str
    owner: dict[str, Any] | str
    classification: str
    license_or_usage_basis: str
    effective_date: str
    status: str
    parser_identity: dict[str, str] | str

    def to_dict(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "display_name": self.display_name,
            "relative_source_path": self.relative_source_path,
            "source_hash": self.source_hash,
            "source_version": self.source_version,
            "owner": self.owner,
            "classification": self.classification,
            "license_or_usage_basis": self.license_or_usage_basis,
            "effective_date": self.effective_date,
            "status": self.status,
            "parser_identity": self.parser_identity,
        }


NOT_RECORDED = "미기재"
