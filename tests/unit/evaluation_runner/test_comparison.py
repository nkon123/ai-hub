"""Version comparison (§4.6) — improved/regressed case classification."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from evaluation_runner.comparison import DatasetMismatchError, compare_versions
from evaluation_runner.metrics import CaseResult, EvaluationMetrics
from evaluation_runner.quality_gate import GateCheck, GateResult
from evaluation_runner.result import EvaluationResult, RetrievalSettings


def _case(case_id: str, hit_at_5: bool) -> CaseResult:
    return CaseResult(
        case_id=case_id,
        question="q",
        expected_document_ids=["doc-1"],
        retrieved_document_ids=["doc-1"] if hit_at_5 else ["doc-2"],
        hit_at_1=hit_at_5,
        hit_at_5=hit_at_5,
        reciprocal_rank=1.0 if hit_at_5 else 0.0,
        latency_ms=100,
        returned_count=1,
        context_tokens=10,
        forbidden_hit=False,
    )


def _result(
    knowledge_version: str,
    dataset_id: str,
    dataset_version: str,
    cases: list[CaseResult],
    recall_at_5: float,
    latency_p95_ms: float,
    gate_passed: bool = True,
) -> EvaluationResult:
    metrics = EvaluationMetrics(
        case_count=len(cases),
        cases_with_ground_truth=len(cases),
        recall_at_1=recall_at_5,
        recall_at_5=recall_at_5,
        mrr=recall_at_5,
        no_result_rate=0.0,
        latency_p50_ms=latency_p95_ms / 2,
        latency_p95_ms=latency_p95_ms,
        avg_context_tokens=10.0,
        forbidden_hit_rate=0.0,
    )
    gate = GateResult(
        passed=gate_passed,
        checks=[
            GateCheck(
                name="recall_at_5_min",
                passed=gate_passed,
                actual=recall_at_5,
                threshold=0.8,
                comparison=">=",
                message="ok" if gate_passed else "Recall@5 미달",
            )
        ],
    )
    return EvaluationResult(
        result_id="r1",
        knowledge_asset_version_id=knowledge_version,
        dataset_id=dataset_id,
        dataset_version=dataset_version,
        evaluated_at=datetime.now(UTC).isoformat(),
        run_id="run-1",
        retrieval_settings=RetrievalSettings(top_k=5, alpha=0.5),
        metrics=metrics,
        gate=gate,
        per_case=cases,
    )


def test_compare_versions_classifies_improved_and_regressed_cases() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0",
        cases=[_case("A", hit_at_5=True), _case("B", hit_at_5=False), _case("C", hit_at_5=True)],
        recall_at_5=2 / 3, latency_p95_ms=1000,
    )
    candidate = _result(
        "v2", "ds-1", "1.0.0",
        cases=[_case("A", hit_at_5=True), _case("B", hit_at_5=True), _case("C", hit_at_5=False)],
        recall_at_5=2 / 3, latency_p95_ms=1200,
    )

    report = compare_versions(baseline, candidate)

    assert report.improved_case_ids == ["B"]
    assert report.regressed_case_ids == ["C"]
    assert report.unchanged_case_ids == ["A"]
    assert report.latency_p95_delta_ms == pytest.approx(200.0)
    assert report.recall_at_5_delta == pytest.approx(0.0)


def test_compare_versions_recommends_block_when_candidate_gate_fails() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )
    candidate = _result(
        "v2", "ds-1", "1.0.0", cases=[_case("A", False)], recall_at_5=0.5, latency_p95_ms=1000,
        gate_passed=False,
    )

    report = compare_versions(baseline, candidate)

    assert report.recommendation == "게시 차단"
    assert report.blocking_reasons  # non-empty


def test_compare_versions_recommends_approve_when_candidate_gate_passes() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )
    candidate = _result(
        "v2", "ds-1", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=900
    )

    report = compare_versions(baseline, candidate)

    assert report.recommendation == "승인 권고"
    assert report.blocking_reasons == []


def test_compare_versions_rejects_mismatched_dataset() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )
    candidate = _result(
        "v2", "ds-2", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )

    with pytest.raises(DatasetMismatchError):
        compare_versions(baseline, candidate)


def test_compare_versions_rejects_mismatched_dataset_version() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )
    candidate = _result(
        "v2", "ds-1", "2.0.0", cases=[_case("A", True)], recall_at_5=0.9, latency_p95_ms=1000
    )

    with pytest.raises(DatasetMismatchError):
        compare_versions(baseline, candidate)


def test_compare_versions_tracks_new_and_removed_cases() -> None:
    baseline = _result(
        "v1", "ds-1", "1.0.0",
        cases=[_case("A", True), _case("B", True)], recall_at_5=1.0, latency_p95_ms=1000,
    )
    candidate = _result(
        "v2", "ds-1", "1.0.0",
        cases=[_case("A", True), _case("C", True)], recall_at_5=1.0, latency_p95_ms=1000,
    )

    report = compare_versions(baseline, candidate)

    assert report.new_case_ids == ["C"]
    assert report.removed_case_ids == ["B"]
