"""Version comparison — 04-knowledge-platform.md §4.6.

Compares a baseline and candidate EvaluationResult that were both produced
from the *same* Evaluation Dataset version (§4.6: "동일 Evaluation Dataset
Version"). Produces Recall/MRR/Latency deltas and improved/regressed case
lists; the approve/block recommendation reuses the candidate's own Quality
Gate result (§4.7) rather than inventing separate comparison thresholds.

Package size / index count deltas (also listed in §4.6) are out of scope —
packages/knowledge-packager (§4.1/§4.2 Package Assembler) is not implemented
yet, so there is no package to measure (see open-decisions.md D-045).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from evaluation_runner.result import EvaluationResult


class DatasetMismatchError(Exception):
    """Raised when baseline and candidate results used different datasets/versions."""


@dataclass(frozen=True)
class ComparisonReport:
    baseline_knowledge_version: str
    candidate_knowledge_version: str
    dataset_id: str
    dataset_version: str
    recall_at_1_delta: float
    recall_at_5_delta: float
    mrr_delta: float
    latency_p95_delta_ms: float
    no_result_rate_delta: float
    improved_case_ids: list[str]
    regressed_case_ids: list[str]
    unchanged_case_ids: list[str]
    new_case_ids: list[str]
    removed_case_ids: list[str]
    recommendation: str
    blocking_reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseline_knowledge_version": self.baseline_knowledge_version,
            "candidate_knowledge_version": self.candidate_knowledge_version,
            "dataset_id": self.dataset_id,
            "dataset_version": self.dataset_version,
            "recall_at_1_delta": self.recall_at_1_delta,
            "recall_at_5_delta": self.recall_at_5_delta,
            "mrr_delta": self.mrr_delta,
            "latency_p95_delta_ms": self.latency_p95_delta_ms,
            "no_result_rate_delta": self.no_result_rate_delta,
            "improved_case_ids": self.improved_case_ids,
            "regressed_case_ids": self.regressed_case_ids,
            "unchanged_case_ids": self.unchanged_case_ids,
            "new_case_ids": self.new_case_ids,
            "removed_case_ids": self.removed_case_ids,
            "recommendation": self.recommendation,
            "blocking_reasons": self.blocking_reasons,
        }


def compare_versions(baseline: EvaluationResult, candidate: EvaluationResult) -> ComparisonReport:
    same_dataset = (
        baseline.dataset_id == candidate.dataset_id
        and baseline.dataset_version == candidate.dataset_version
    )
    if not same_dataset:
        raise DatasetMismatchError(
            "버전 비교는 동일 Evaluation Dataset Version에서만 가능합니다 (§4.6): "
            f"baseline={baseline.dataset_id}@{baseline.dataset_version} "
            f"candidate={candidate.dataset_id}@{candidate.dataset_version}"
        )

    baseline_by_id = {c.case_id: c for c in baseline.per_case}
    candidate_by_id = {c.case_id: c for c in candidate.per_case}

    improved: list[str] = []
    regressed: list[str] = []
    unchanged: list[str] = []

    for case_id, cand in candidate_by_id.items():
        base = baseline_by_id.get(case_id)
        if base is None:
            continue
        if cand.hit_at_5 and not base.hit_at_5:
            improved.append(case_id)
        elif not cand.hit_at_5 and base.hit_at_5:
            regressed.append(case_id)
        else:
            unchanged.append(case_id)

    new_case_ids = sorted(set(candidate_by_id) - set(baseline_by_id))
    removed_case_ids = sorted(set(baseline_by_id) - set(candidate_by_id))

    blocking_reasons = [c.message for c in candidate.gate.failed_checks]
    recommendation = "승인 권고" if candidate.gate.passed else "게시 차단"

    return ComparisonReport(
        baseline_knowledge_version=baseline.knowledge_asset_version_id,
        candidate_knowledge_version=candidate.knowledge_asset_version_id,
        dataset_id=candidate.dataset_id,
        dataset_version=candidate.dataset_version,
        recall_at_1_delta=candidate.metrics.recall_at_1 - baseline.metrics.recall_at_1,
        recall_at_5_delta=candidate.metrics.recall_at_5 - baseline.metrics.recall_at_5,
        mrr_delta=candidate.metrics.mrr - baseline.metrics.mrr,
        latency_p95_delta_ms=candidate.metrics.latency_p95_ms - baseline.metrics.latency_p95_ms,
        no_result_rate_delta=candidate.metrics.no_result_rate - baseline.metrics.no_result_rate,
        improved_case_ids=sorted(improved),
        regressed_case_ids=sorted(regressed),
        unchanged_case_ids=sorted(unchanged),
        new_case_ids=new_case_ids,
        removed_case_ids=removed_case_ids,
        recommendation=recommendation,
        blocking_reasons=blocking_reasons,
    )
