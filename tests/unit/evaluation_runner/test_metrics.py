"""Recall@1/@5, MRR, no-result-rate, P50/P95 latency — hand-computed expectations."""

from __future__ import annotations

import pytest
from evaluation_runner.metrics import CaseResult, aggregate_metrics, estimate_tokens, evaluate_case
from evaluation_runner.models import EvaluationCase
from evaluation_runner.search_client import SearchResponse

from .conftest import make_citation


def test_evaluate_case_hit_at_1_when_top_result_matches() -> None:
    case = EvaluationCase(case_id="A", question="q", expected_document_ids=["doc-1"])
    response = SearchResponse(citations=[make_citation("doc-1"), make_citation("doc-2")])

    result = evaluate_case(case, response)

    assert result.hit_at_1 is True
    assert result.hit_at_5 is True
    assert result.reciprocal_rank == 1.0
    assert result.retrieved_document_ids == ["doc-1", "doc-2"]


def test_evaluate_case_hit_at_5_but_not_at_1() -> None:
    case = EvaluationCase(case_id="B", question="q", expected_document_ids=["doc-2"])
    response = SearchResponse(
        citations=[make_citation("doc-1"), make_citation("doc-2"), make_citation("doc-3")]
    )

    result = evaluate_case(case, response)

    assert result.hit_at_1 is False
    assert result.hit_at_5 is True
    assert result.reciprocal_rank == 0.5  # rank 2 -> 1/2


def test_evaluate_case_no_hit_within_top_5() -> None:
    case = EvaluationCase(case_id="C", question="q", expected_document_ids=["doc-9"])
    response = SearchResponse(
        citations=[
            make_citation("doc-1"),
            make_citation("doc-2"),
            make_citation("doc-3"),
            make_citation("doc-4"),
            make_citation("doc-5"),
        ]
    )

    result = evaluate_case(case, response)

    assert result.hit_at_1 is False
    assert result.hit_at_5 is False
    assert result.reciprocal_rank == 0.0


def test_evaluate_case_deduplicates_repeated_documents_before_ranking() -> None:
    # Two chunks from the same document should count as one ranked position.
    case = EvaluationCase(case_id="D", question="q", expected_document_ids=["doc-2"])
    response = SearchResponse(
        citations=[
            make_citation("doc-1", chunk_id="c1"),
            make_citation("doc-1", chunk_id="c2"),  # duplicate document, different chunk
            make_citation("doc-2", chunk_id="c3"),
        ]
    )

    result = evaluate_case(case, response)

    assert result.retrieved_document_ids == ["doc-1", "doc-2"]  # doc-1 counted once
    assert result.reciprocal_rank == 0.5  # doc-2 is rank 2 among deduped docs


def test_evaluate_case_no_ground_truth_is_never_a_hit() -> None:
    case = EvaluationCase(case_id="E", question="q", expected_document_ids=[])
    response = SearchResponse(citations=[make_citation("doc-1")])

    result = evaluate_case(case, response)

    assert result.hit_at_1 is False
    assert result.hit_at_5 is False
    assert result.reciprocal_rank == 0.0
    assert result.has_ground_truth is False


def test_evaluate_case_forbidden_document_detected() -> None:
    case = EvaluationCase(
        case_id="F", question="q", expected_document_ids=[], forbidden_document_ids=["doc-1"]
    )
    response = SearchResponse(citations=[make_citation("doc-1")])

    result = evaluate_case(case, response)

    assert result.forbidden_hit is True


def test_aggregate_metrics_recall_and_mrr_known_values() -> None:
    """3 cases with ground truth: hits at 1/5 -> True/True, False/True, False/False.
    recall@1 = 1/3, recall@5 = 2/3, mrr = (1 + 0.5 + 0) / 3 = 0.5.
    A 4th case has no ground truth and is excluded from those three metrics
    but has zero results, contributing to no_result_rate = 1/4.
    """
    case_a = evaluate_case(
        EvaluationCase(case_id="A", question="q", expected_document_ids=["doc-1"]),
        SearchResponse(citations=[make_citation("doc-1"), make_citation("doc-2")]),
    )
    case_b = evaluate_case(
        EvaluationCase(case_id="B", question="q", expected_document_ids=["doc-2"]),
        SearchResponse(citations=[make_citation("doc-1"), make_citation("doc-2")]),
    )
    case_c = evaluate_case(
        EvaluationCase(case_id="C", question="q", expected_document_ids=["doc-9"]),
        SearchResponse(citations=[make_citation("doc-1"), make_citation("doc-2")]),
    )
    case_d = evaluate_case(
        EvaluationCase(case_id="D", question="q", expected_document_ids=[]),
        SearchResponse(citations=[]),
    )

    metrics = aggregate_metrics([case_a, case_b, case_c, case_d])

    assert metrics.case_count == 4
    assert metrics.cases_with_ground_truth == 3
    assert metrics.recall_at_1 == 1 / 3
    assert metrics.recall_at_5 == 2 / 3
    assert metrics.mrr == 0.5
    assert metrics.no_result_rate == 0.25


def test_aggregate_metrics_latency_percentiles_known_values() -> None:
    """latencies [10, 20, 30, 40, 100] -> p50 (linear interp, k=2.0) = 30,
    p95 (k=3.8) = 40 + (100-40)*0.8 = 88.0."""
    latencies = [10, 20, 30, 40, 100]
    case_results = [
        CaseResult(
            case_id=str(i),
            question="q",
            expected_document_ids=[],
            retrieved_document_ids=["doc-1"],
            hit_at_1=False,
            hit_at_5=False,
            reciprocal_rank=0.0,
            latency_ms=lat,
            returned_count=1,
            context_tokens=0,
            forbidden_hit=False,
        )
        for i, lat in enumerate(latencies)
    ]

    metrics = aggregate_metrics(case_results)

    assert metrics.latency_p50_ms == pytest.approx(30.0)
    assert metrics.latency_p95_ms == pytest.approx(88.0)
    assert metrics.no_result_rate == 0.0


def test_aggregate_metrics_empty_input_is_all_zero() -> None:
    metrics = aggregate_metrics([])

    assert metrics.case_count == 0
    assert metrics.recall_at_1 == 0.0
    assert metrics.recall_at_5 == 0.0
    assert metrics.mrr == 0.0
    assert metrics.no_result_rate == 0.0
    assert metrics.latency_p50_ms == 0.0
    assert metrics.latency_p95_ms == 0.0


def test_estimate_tokens_heuristic() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1  # max(1, 4 // 4)
    assert estimate_tokens("a" * 40) == 10
