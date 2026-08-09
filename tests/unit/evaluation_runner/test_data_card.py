"""Data Card generation (§4.8) — required sections present; unfilled fields
render as 미기재 rather than being silently omitted or invented."""

from __future__ import annotations

from datetime import UTC, datetime

from evaluation_runner.data_card import DataCardInputs, render_data_card
from evaluation_runner.metrics import CaseResult, EvaluationMetrics
from evaluation_runner.models import DatasetReviewStatus, EvaluationCase, EvaluationDataset
from evaluation_runner.quality_gate import GateCheck, GateResult
from evaluation_runner.result import EvaluationResult, RetrievalSettings

REQUIRED_SECTION_HEADINGS = [
    "## 1. 목적과 적합한 사용 사례",
    "## 2. 포함 Source 범위와 기준일",
    "## 3. 제외 Source",
    "## 4. 소유자와 문의처",
    "## 5. Parser/Chunk/Embedding/Index 전략",
    "## 6. 기본 Retrieval Profile",
    "## 7. 평가 데이터와 결과",
    "## 8. 알려진 제한사항",
    "## 9. 보안등급과 접근 조건",
    "## 10. 업데이트 방법",
    "## 11. 호환 Runtime/Model",
]


def _dataset(review_status: DatasetReviewStatus) -> EvaluationDataset:
    return EvaluationDataset(
        dataset_id="ds-1",
        name="test dataset",
        version="1.0.0",
        knowledge_asset_id="asset-1",
        review_status=review_status,
        cases=[EvaluationCase(case_id="A", question="q", expected_document_ids=["doc-1"])],
    )


def _result() -> EvaluationResult:
    case = CaseResult(
        case_id="A", question="q", expected_document_ids=["doc-1"],
        retrieved_document_ids=["doc-1"], hit_at_1=True, hit_at_5=True,
        reciprocal_rank=1.0, latency_ms=100, returned_count=1, context_tokens=20,
        forbidden_hit=False,
    )
    metrics = EvaluationMetrics(
        case_count=1, cases_with_ground_truth=1, recall_at_1=1.0, recall_at_5=1.0,
        mrr=1.0, no_result_rate=0.0, latency_p50_ms=100.0, latency_p95_ms=100.0,
        avg_context_tokens=20.0, forbidden_hit_rate=0.0,
    )
    gate = GateResult(
        passed=True,
        checks=[GateCheck("recall_at_5_min", True, 1.0, 0.8, ">=", "ok")],
    )
    return EvaluationResult(
        result_id="r1", knowledge_asset_version_id="av-1", dataset_id="ds-1",
        dataset_version="1.0.0", evaluated_at=datetime.now(UTC).isoformat(), run_id="run-1",
        retrieval_settings=RetrievalSettings(top_k=5, alpha=0.5), metrics=metrics, gate=gate,
        per_case=[case],
    )


def test_data_card_contains_all_required_sections() -> None:
    inputs = DataCardInputs(
        knowledge_name="재택근무 정책",
        knowledge_asset_id="asset-1",
        knowledge_asset_version_id="av-1",
    )
    card = render_data_card(inputs, _dataset(DatasetReviewStatus.EXPERT_REVIEWED), _result())

    for heading in REQUIRED_SECTION_HEADINGS:
        assert heading in card, f"missing section: {heading}"


def test_data_card_marks_unpopulated_fields_as_not_recorded() -> None:
    inputs = DataCardInputs(
        knowledge_name="재택근무 정책",
        knowledge_asset_id="asset-1",
        knowledge_asset_version_id="av-1",
        # everything else left None
    )
    card = render_data_card(inputs, _dataset(DatasetReviewStatus.EXPERT_REVIEWED), _result())

    assert "미기재" in card
    # purpose section specifically must not fabricate content
    purpose_section = card.split("## 1. 목적과 적합한 사용 사례")[1].split("## 2.")[0]
    assert "미기재" in purpose_section


def test_data_card_does_not_mark_provided_fields_as_not_recorded() -> None:
    inputs = DataCardInputs(
        knowledge_name="재택근무 정책",
        knowledge_asset_id="asset-1",
        knowledge_asset_version_id="av-1",
        purpose="재택근무 정책 문의 응대",
        owner_org="HR팀",
    )
    card = render_data_card(inputs, _dataset(DatasetReviewStatus.EXPERT_REVIEWED), _result())

    assert "재택근무 정책 문의 응대" in card
    assert "HR팀" in card


def test_data_card_warns_when_dataset_not_expert_reviewed() -> None:
    inputs = DataCardInputs(
        knowledge_name="재택근무 정책",
        knowledge_asset_id="asset-1",
        knowledge_asset_version_id="av-1",
    )
    dataset = _dataset(DatasetReviewStatus.AI_GENERATED_UNREVIEWED)
    card = render_data_card(inputs, dataset, _result())

    assert "주의" in card
    assert "AI_GENERATED_UNREVIEWED" in card


def test_data_card_no_warning_when_expert_reviewed() -> None:
    inputs = DataCardInputs(
        knowledge_name="재택근무 정책",
        knowledge_asset_id="asset-1",
        knowledge_asset_version_id="av-1",
    )
    dataset = _dataset(DatasetReviewStatus.EXPERT_REVIEWED)
    card = render_data_card(inputs, dataset, _result())

    assert "주의" not in card
