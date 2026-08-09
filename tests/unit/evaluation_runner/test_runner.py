"""Dataset loading + end-to-end run_evaluation, entirely against a fake
SearchClient — no live search-runtime, no Ollama, no network."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from evaluation_runner.models import DatasetReviewStatus
from evaluation_runner.quality_gate import QualityGatePolicy
from evaluation_runner.result import EvaluationResult
from evaluation_runner.runner import DatasetLoadError, load_dataset, run_evaluation
from evaluation_runner.search_client import SearchResponse

from .conftest import FakeSearchClient, make_citation

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "fixtures" / "valid" / "hr-policy-knowledge" / "evaluation-dataset.json"
)

POLICY = QualityGatePolicy(
    recall_at_5_min=0.80,
    recall_at_5_max_regression_pp=0.05,
    p95_latency_ms_max=2000,
    forbidden_hit_rate_max=0.0,
)


def test_load_dataset_from_real_fixture() -> None:
    dataset = load_dataset(FIXTURE_PATH)

    assert dataset.dataset_id == "remote-work-policy-eval-v1"
    assert dataset.review_status is DatasetReviewStatus.AI_GENERATED_UNREVIEWED
    assert dataset.is_expert_reviewed is False
    assert len(dataset.cases) == 6
    case_ids = {c.case_id for c in dataset.cases}
    assert "WFH-001" in case_ids


def test_load_dataset_missing_file_raises() -> None:
    with pytest.raises(DatasetLoadError):
        load_dataset("/nonexistent/evaluation-dataset.json")


def test_load_dataset_invalid_schema_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    # missing required fields (dataset_id, name, version, knowledge_asset_id, review_status)
    bad.write_text(json.dumps({"type": "evaluation_dataset", "cases": []}))

    with pytest.raises(DatasetLoadError):
        load_dataset(bad)


@pytest.mark.asyncio
async def test_run_evaluation_end_to_end_with_fake_client() -> None:
    dataset = load_dataset(FIXTURE_PATH)

    fake = FakeSearchClient(
        responses_by_query={
            "재택근무는 일주일에 최대 며칠까지 신청할 수 있나요?": SearchResponse(
                citations=[make_citation("remote-work-policy", excerpt="주 최대 2일")]
            ),
        },
        default_response=SearchResponse(citations=[]),
    )

    result = await run_evaluation(
        search_client=fake,
        dataset=dataset,
        knowledge_id="asset-version-xyz",
        knowledge_version="1.0.0",
        top_k=5,
        alpha=0.5,
        policy=POLICY,
    )

    assert result.knowledge_asset_version_id == "asset-version-xyz"
    assert result.dataset_id == dataset.dataset_id
    assert len(result.per_case) == len(dataset.cases)
    # WFH-001 got a real citation -> hit; the other cases got the empty
    # default response -> miss (this only exercises plumbing, not real search quality).
    wfh_001 = next(c for c in result.per_case if c.case_id == "WFH-001")
    assert wfh_001.hit_at_5 is True

    # every case call shares the same run_id (trace requirement, CLAUDE.md 구현 원칙 9)
    run_ids = {call.run_id for call in fake.calls}
    assert run_ids == {result.run_id}
    # but each case gets its own trace_id
    trace_ids = [call.trace_id for call in fake.calls]
    assert len(trace_ids) == len(set(trace_ids))

    # gate should fail: recall_at_5 is 1/6 with-ground-truth-cases hit, well under 80%
    assert result.gate.passed is False


@pytest.mark.asyncio
async def test_run_evaluation_gate_passes_when_all_cases_hit() -> None:
    dataset = load_dataset(FIXTURE_PATH)
    # Map every question that HAS ground truth to the matching citation; leave
    # the distractor case (empty expected_document_ids, non-empty
    # forbidden_document_ids) on the empty default response so it neither
    # counts as a recall hit nor trips the forbidden_hit_rate gate.
    hit_response = SearchResponse(citations=[make_citation("remote-work-policy")])
    responses = {
        case.question: hit_response for case in dataset.cases if case.expected_document_ids
    }
    fake = FakeSearchClient(
        responses_by_query=responses, default_response=SearchResponse(citations=[])
    )

    result = await run_evaluation(
        search_client=fake,
        dataset=dataset,
        knowledge_id="asset-version-xyz",
        policy=POLICY,
    )

    assert result.metrics.recall_at_5 == 1.0
    assert result.metrics.forbidden_hit_rate == 0.0
    assert result.gate.passed is True


@pytest.mark.asyncio
async def test_evaluation_result_round_trips_through_dict() -> None:
    dataset = load_dataset(FIXTURE_PATH)
    fake = FakeSearchClient(
        default_response=SearchResponse(citations=[make_citation("remote-work-policy")])
    )
    result = await run_evaluation(
        search_client=fake, dataset=dataset, knowledge_id="av-1", policy=POLICY
    )

    serialized = json.dumps(result.to_dict(), ensure_ascii=False)
    round_tripped = EvaluationResult.from_dict(json.loads(serialized))

    assert round_tripped.metrics.recall_at_5 == result.metrics.recall_at_5
    assert round_tripped.gate.passed == result.gate.passed
    assert len(round_tripped.per_case) == len(result.per_case)
