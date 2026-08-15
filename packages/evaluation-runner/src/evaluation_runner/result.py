"""EvaluationResult — the object persisted to/from evaluation-result.schema.json."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from evaluation_runner.metrics import AclCaseResult, CaseResult, EvaluationMetrics
from evaluation_runner.quality_gate import GateResult


@dataclass(frozen=True)
class RetrievalSettings:
    top_k: int
    alpha: float
    knowledge_version: str = "latest"

    def to_dict(self) -> dict[str, Any]:
        return {
            "top_k": self.top_k,
            "alpha": self.alpha,
            "knowledge_version": self.knowledge_version,
        }


@dataclass(frozen=True)
class EvaluationResult:
    result_id: str
    knowledge_asset_version_id: str
    dataset_id: str
    dataset_version: str
    evaluated_at: str
    run_id: str
    retrieval_settings: RetrievalSettings
    metrics: EvaluationMetrics
    gate: GateResult
    per_case: list[CaseResult]
    per_acl_case: list[AclCaseResult] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "1.0",
            "type": "evaluation_result",
            "result_id": self.result_id,
            "knowledge_asset_version_id": self.knowledge_asset_version_id,
            "dataset_id": self.dataset_id,
            "dataset_version": self.dataset_version,
            "evaluated_at": self.evaluated_at,
            "run_id": self.run_id,
            "retrieval_settings": self.retrieval_settings.to_dict(),
            "metrics": self.metrics.to_dict(),
            "gate": self.gate.to_dict(),
            "per_case": [c.to_dict() for c in self.per_case],
            "per_acl_case": [c.to_dict() for c in self.per_acl_case],
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> EvaluationResult:
        rs = data["retrieval_settings"]
        m = data["metrics"]
        g = data["gate"]

        from evaluation_runner.quality_gate import GateCheck

        return EvaluationResult(
            result_id=data["result_id"],
            knowledge_asset_version_id=data["knowledge_asset_version_id"],
            dataset_id=data["dataset_id"],
            dataset_version=data["dataset_version"],
            evaluated_at=data["evaluated_at"],
            run_id=data["run_id"],
            retrieval_settings=RetrievalSettings(
                top_k=rs["top_k"],
                alpha=rs["alpha"],
                knowledge_version=rs.get("knowledge_version", "latest"),
            ),
            metrics=EvaluationMetrics(
                case_count=m["case_count"],
                cases_with_ground_truth=m["cases_with_ground_truth"],
                recall_at_1=m["recall_at_1"],
                recall_at_5=m["recall_at_5"],
                mrr=m["mrr"],
                no_result_rate=m["no_result_rate"],
                latency_p50_ms=m["latency_p50_ms"],
                latency_p95_ms=m["latency_p95_ms"],
                avg_context_tokens=m["avg_context_tokens"],
                forbidden_hit_rate=m["forbidden_hit_rate"],
                # `.get` with defaults: results persisted before ACL testing
                # existed have no such keys, and an old result must keep
                # loading — its acl_case_count of 0 correctly says "not
                # measured" rather than "passed".
                acl_case_count=m.get("acl_case_count", 0),
                acl_cases_with_visibility_expectation=m.get(
                    "acl_cases_with_visibility_expectation", 0
                ),
                acl_leak_rate=m.get("acl_leak_rate", 0.0),
                acl_visibility_rate=m.get("acl_visibility_rate", 0.0),
            ),
            gate=GateResult(
                passed=g["passed"],
                checks=[
                    GateCheck(
                        name=c["name"],
                        passed=c["passed"],
                        actual=c["actual"],
                        threshold=c["threshold"],
                        comparison=c["comparison"],
                        message=c["message"],
                    )
                    for c in g["checks"]
                ],
            ),
            per_case=[
                CaseResult(
                    case_id=c["case_id"],
                    question=c["question"],
                    expected_document_ids=c["expected_document_ids"],
                    retrieved_document_ids=c["retrieved_document_ids"],
                    hit_at_1=c["hit_at_1"],
                    hit_at_5=c["hit_at_5"],
                    reciprocal_rank=c["reciprocal_rank"],
                    latency_ms=c["latency_ms"],
                    returned_count=c["returned_count"],
                    context_tokens=c["context_tokens"],
                    forbidden_hit=c["forbidden_hit"],
                    tags=c.get("tags", []),
                )
                for c in data["per_case"]
            ],
            per_acl_case=[
                AclCaseResult(
                    case_id=c["case_id"],
                    question=c["question"],
                    clearance=c["clearance"],
                    forbidden_document_ids=c["forbidden_document_ids"],
                    retrieved_document_ids=c["retrieved_document_ids"],
                    leaked_document_ids=c["leaked_document_ids"],
                    expected_visible_document_ids=c["expected_visible_document_ids"],
                    missing_visible_document_ids=c["missing_visible_document_ids"],
                    returned_count=c.get("returned_count", 0),
                    latency_ms=c.get("latency_ms", 0),
                    tags=c.get("tags", []),
                )
                for c in data.get("per_acl_case", [])
            ],
        )
