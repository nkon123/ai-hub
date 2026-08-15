"""Domain models for the Evaluation Runner (M09).

Kept as plain dataclasses/enums — no pydantic, no FastAPI — so this package
stays a pure library usable from a CLI, tests, or (later) a portal-api
service call without dragging in a web framework (CLAUDE.md 구현 원칙:
Python Domain Model과 API Model을 분리한다).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class DatasetReviewStatus(StrEnum):
    """Mirrors evaluation-dataset.schema.json's review_status enum (central
    definition lives in the schema; this is the Python-side mirror used for
    type-safe comparisons, same pattern as security_policy's Role/Permission
    enums mirroring their own schema-less central definitions)."""

    AI_GENERATED_UNREVIEWED = "AI_GENERATED_UNREVIEWED"
    EXPERT_REVIEWED = "EXPERT_REVIEWED"


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    question: str
    expected_document_ids: list[str] = field(default_factory=list)
    expected_chunk_ids: list[str] = field(default_factory=list)
    required_filters: dict[str, str] = field(default_factory=dict)
    forbidden_document_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> EvaluationCase:
        return EvaluationCase(
            case_id=data["case_id"],
            question=data["question"],
            expected_document_ids=list(data.get("expected_document_ids", [])),
            expected_chunk_ids=list(data.get("expected_chunk_ids", [])),
            required_filters=dict(data.get("required_filters", {})),
            forbidden_document_ids=list(data.get("forbidden_document_ids", [])),
            tags=list(data.get("tags", [])),
        )


@dataclass(frozen=True)
class AclCase:
    """§4.7 "모든 ACL Test 통과" (D-045). Deliberately not an EvaluationCase
    with extra fields: an ACL case is not scored for relevance and never
    enters Recall@K/MRR. Retrieving a forbidden document is a security
    failure, and averaging it into a quality number would let good relevance
    hide it."""

    case_id: str
    question: str
    clearance: str
    forbidden_document_ids: list[str]
    expected_visible_document_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> AclCase:
        return AclCase(
            case_id=data["case_id"],
            question=data["question"],
            clearance=data["clearance"],
            forbidden_document_ids=list(data["forbidden_document_ids"]),
            expected_visible_document_ids=list(data.get("expected_visible_document_ids", [])),
            tags=list(data.get("tags", [])),
        )


@dataclass(frozen=True)
class EvaluationDataset:
    dataset_id: str
    name: str
    version: str
    knowledge_asset_id: str
    review_status: DatasetReviewStatus
    cases: list[EvaluationCase]
    description: str = ""
    reviewed_by: str | None = None
    reviewed_at: str | None = None
    notes: str = ""
    acl_cases: list[AclCase] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> EvaluationDataset:
        return EvaluationDataset(
            dataset_id=data["dataset_id"],
            name=data["name"],
            version=data["version"],
            knowledge_asset_id=data["knowledge_asset_id"],
            review_status=DatasetReviewStatus(data["review_status"]),
            cases=[EvaluationCase.from_dict(c) for c in data["cases"]],
            description=data.get("description", ""),
            reviewed_by=data.get("reviewed_by"),
            reviewed_at=data.get("reviewed_at"),
            notes=data.get("notes", ""),
            acl_cases=[AclCase.from_dict(c) for c in data.get("acl_cases", [])],
        )

    @property
    def is_expert_reviewed(self) -> bool:
        return self.review_status is DatasetReviewStatus.EXPERT_REVIEWED

    @property
    def has_acl_cases(self) -> bool:
        """Whether this dataset tests ACL at all. The Quality Gate branches on
        this to decide between running its ACL checks and omitting them —
        never between running them and emitting passing ones."""
        return len(self.acl_cases) > 0
