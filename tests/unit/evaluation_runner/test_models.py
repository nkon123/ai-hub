"""EvaluationDataset/EvaluationCase parsing from dict (as loaded from JSON)."""

from __future__ import annotations

from evaluation_runner.models import DatasetReviewStatus, EvaluationCase, EvaluationDataset


def test_evaluation_case_from_dict_applies_defaults() -> None:
    case = EvaluationCase.from_dict({"case_id": "X-1", "question": "q?"})

    assert case.expected_document_ids == []
    assert case.expected_chunk_ids == []
    assert case.required_filters == {}
    assert case.forbidden_document_ids == []
    assert case.tags == []


def test_evaluation_dataset_from_dict_parses_cases_and_review_status() -> None:
    data = {
        "dataset_id": "ds-1",
        "name": "test",
        "version": "1.0.0",
        "knowledge_asset_id": "asset-1",
        "review_status": "EXPERT_REVIEWED",
        "reviewed_by": "hr-lead",
        "cases": [
            {"case_id": "A", "question": "q1", "expected_document_ids": ["doc-1"]},
            {"case_id": "B", "question": "q2", "expected_document_ids": []},
        ],
    }

    dataset = EvaluationDataset.from_dict(data)

    assert dataset.review_status is DatasetReviewStatus.EXPERT_REVIEWED
    assert dataset.is_expert_reviewed is True
    assert dataset.reviewed_by == "hr-lead"
    assert len(dataset.cases) == 2
    assert dataset.cases[0].case_id == "A"


def test_evaluation_dataset_ai_generated_unreviewed_is_not_expert_reviewed() -> None:
    data = {
        "dataset_id": "ds-1",
        "name": "test",
        "version": "1.0.0",
        "knowledge_asset_id": "asset-1",
        "review_status": "AI_GENERATED_UNREVIEWED",
        "cases": [{"case_id": "A", "question": "q1", "expected_document_ids": []}],
    }

    dataset = EvaluationDataset.from_dict(data)

    assert dataset.is_expert_reviewed is False
