"""ACL Test — 04-knowledge-platform.md §4.7 "모든 ACL Test 통과" (D-045).

Runs entirely against a fake SearchClient, like the rest of this package's
unit tests. The fake is what makes the central assertion possible at all:
the property under test is *what clearance the runner sends*, and only the
recorded call reveals that.

The failure this suite is built around is not "a leak is not detected" — it
is the quieter one: a check that never ran looking exactly like a check that
passed. Three separate tests pin that down (gate omission, Data Card wording,
old-result loading), because there are three separate places a reader could
be misled.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from evaluation_runner.data_card import DataCardInputs, render_data_card
from evaluation_runner.metrics import aggregate_acl_metrics, evaluate_acl_case
from evaluation_runner.models import AclCase, DatasetReviewStatus, EvaluationDataset
from evaluation_runner.quality_gate import QualityGatePolicy
from evaluation_runner.result import EvaluationResult
from evaluation_runner.runner import load_dataset, run_evaluation
from evaluation_runner.search_client import SearchResponse

from .conftest import FakeSearchClient, make_citation

POLICY = QualityGatePolicy(
    recall_at_5_min=0.0,  # quality thresholds are not what this suite measures
    recall_at_5_max_regression_pp=1.0,
    p95_latency_ms_max=100000,
    forbidden_hit_rate_max=1.0,
    acl_leak_rate_max=0.0,
    acl_visibility_min=1.0,
)


def _dataset(acl_cases: list[AclCase]) -> EvaluationDataset:
    return EvaluationDataset(
        dataset_id="acl-ds",
        name="ACL 데이터셋",
        version="1.0.0",
        knowledge_asset_id="asset-1",
        review_status=DatasetReviewStatus.EXPERT_REVIEWED,
        cases=[],
        acl_cases=acl_cases,
    )


def _acl_case(**overrides: object) -> AclCase:
    base = {
        "case_id": "ACL-001",
        "question": "연봉 테이블을 보여줘",
        "clearance": "PUBLIC_INTERNAL",
        "forbidden_document_ids": ["salary-table"],
    }
    base.update(overrides)
    return AclCase(**base)  # type: ignore[arg-type]


# --- Case-level evaluation ---


def test_leak_is_detected_and_the_leaked_document_is_named() -> None:
    result = evaluate_acl_case(
        _acl_case(),
        SearchResponse(citations=[make_citation("salary-table"), make_citation("handbook")]),
    )

    assert result.leaked is True
    # Naming it is the point — "1건 유출" is not actionable.
    assert result.leaked_document_ids == ["salary-table"]
    assert result.retrieved_document_ids == ["salary-table", "handbook"]


def test_no_leak_when_the_forbidden_document_is_filtered_out() -> None:
    result = evaluate_acl_case(
        _acl_case(), SearchResponse(citations=[make_citation("handbook")])
    )

    assert result.leaked is False
    assert result.leaked_document_ids == []


def test_visibility_is_not_asserted_when_the_case_declares_none() -> None:
    """None, not True — a case that asserted nothing did not pass anything."""
    result = evaluate_acl_case(_acl_case(), SearchResponse(citations=[]))

    assert result.visibility_satisfied is None
    assert result.missing_visible_document_ids == []


def test_visibility_failure_is_reported_when_an_expected_document_is_missing() -> None:
    result = evaluate_acl_case(
        _acl_case(
            clearance="INTERNAL",
            forbidden_document_ids=["salary-table"],
            expected_visible_document_ids=["handbook"],
        ),
        SearchResponse(citations=[]),
    )

    assert result.leaked is False  # nothing returned, so nothing leaked...
    assert result.visibility_satisfied is False  # ...and that is exactly the problem
    assert result.missing_visible_document_ids == ["handbook"]


def test_document_ids_are_matched_by_the_same_d045_rule_as_quality_cases() -> None:
    """Forbidden ids may be written with an extension or in mixed case; the
    matching rule is shared with `cases`, not reinvented here."""
    result = evaluate_acl_case(
        _acl_case(forbidden_document_ids=["Salary-Table.MD"]),
        SearchResponse(citations=[make_citation("salary-table")]),
    )

    assert result.leaked is True


# --- Aggregation ---


def test_aggregate_reports_rates_and_the_leaking_case_ids() -> None:
    leaking = evaluate_acl_case(
        _acl_case(case_id="A", expected_visible_document_ids=["handbook"]),
        SearchResponse(citations=[make_citation("salary-table"), make_citation("handbook")]),
    )
    clean = evaluate_acl_case(
        _acl_case(case_id="B", expected_visible_document_ids=["handbook"]),
        SearchResponse(citations=[make_citation("handbook")]),
    )

    metrics = aggregate_acl_metrics([leaking, clean])

    assert metrics.case_count == 2
    assert metrics.leak_rate == 0.5
    assert metrics.leaked_case_ids == ["A"]
    assert metrics.cases_with_visibility_expectation == 2
    assert metrics.visibility_rate == 1.0
    assert metrics.measured is True


def test_visibility_rate_denominator_only_counts_cases_that_asserted_it() -> None:
    asserted = evaluate_acl_case(
        _acl_case(case_id="A", expected_visible_document_ids=["handbook"]),
        SearchResponse(citations=[make_citation("handbook")]),
    )
    silent = evaluate_acl_case(_acl_case(case_id="B"), SearchResponse(citations=[]))

    metrics = aggregate_acl_metrics([asserted, silent])

    assert metrics.cases_with_visibility_expectation == 1
    assert metrics.visibility_rate == 1.0


# --- Quality Gate ---


async def _run(acl_cases: list[AclCase], responses: dict[str, SearchResponse]) -> EvaluationResult:
    client = FakeSearchClient(responses_by_query=responses)
    return await run_evaluation(
        search_client=client,
        dataset=_dataset(acl_cases),
        knowledge_id="kv-1",
        policy=POLICY,
    )


@pytest.mark.asyncio
async def test_gate_omits_acl_checks_entirely_when_the_dataset_has_none() -> None:
    """The core anti-lie property: no ACL cases must produce NO ACL check —
    not a passing one. A passing check would tell a reviewer that a Knowledge
    with untested ACL behaviour is safe to approve."""
    result = await _run([], {})

    names = {c.name for c in result.gate.checks}
    assert "acl_leak_rate_max" not in names
    assert "acl_visibility_min" not in names
    assert result.metrics.acl_case_count == 0
    assert result.per_acl_case == []


@pytest.mark.asyncio
async def test_gate_fails_on_a_single_leak() -> None:
    case = _acl_case(expected_visible_document_ids=["handbook"])
    result = await _run(
        [case],
        {
            case.question: SearchResponse(
                citations=[make_citation("salary-table"), make_citation("handbook")]
            )
        },
    )

    assert result.gate.passed is False
    leak_check = next(c for c in result.gate.checks if c.name == "acl_leak_rate_max")
    assert leak_check.passed is False
    assert result.metrics.acl_leak_rate == 1.0


@pytest.mark.asyncio
async def test_gate_fails_when_nothing_is_visible_even_though_nothing_leaked() -> None:
    """A backend returning nothing leaks nothing. Without the visibility
    check this run would be a clean PASS while proving absolutely nothing."""
    case = _acl_case(expected_visible_document_ids=["handbook"])
    result = await _run([case], {case.question: SearchResponse(citations=[])})

    assert result.metrics.acl_leak_rate == 0.0
    assert result.gate.passed is False
    visibility_check = next(c for c in result.gate.checks if c.name == "acl_visibility_min")
    assert visibility_check.passed is False


@pytest.mark.asyncio
async def test_gate_passes_when_forbidden_is_hidden_and_expected_is_visible() -> None:
    case = _acl_case(expected_visible_document_ids=["handbook"])
    result = await _run(
        [case], {case.question: SearchResponse(citations=[make_citation("handbook")])}
    )

    assert result.gate.passed is True
    assert result.metrics.acl_leak_rate == 0.0
    assert result.metrics.acl_visibility_rate == 1.0


@pytest.mark.asyncio
async def test_visibility_check_is_omitted_when_no_case_asserts_visibility() -> None:
    case = _acl_case()
    result = await _run(
        [case], {case.question: SearchResponse(citations=[make_citation("handbook")])}
    )

    names = {c.name for c in result.gate.checks}
    assert "acl_leak_rate_max" in names
    assert "acl_visibility_min" not in names


# --- Runner wiring ---


@pytest.mark.asyncio
async def test_runner_sends_the_case_clearance_not_the_restricted_default() -> None:
    """If the runner fell back to the package's RESTRICTED default, every ACL
    case would query as the highest clearance and the whole test would be
    meaningless while still going green."""
    client = FakeSearchClient()
    case = _acl_case(clearance="PUBLIC_INTERNAL")

    await run_evaluation(
        search_client=client,
        dataset=_dataset([case]),
        knowledge_id="kv-1",
        policy=POLICY,
    )

    assert len(client.calls) == 1
    assert client.calls[0].access_context == {"clearance": "PUBLIC_INTERNAL"}


@pytest.mark.asyncio
async def test_acl_cases_never_enter_recall_metrics() -> None:
    """A leak must not be averaged into a relevance number, and an ACL case
    must not inflate or deflate Recall@K."""
    case = _acl_case()
    result = await _run(
        [case], {case.question: SearchResponse(citations=[make_citation("salary-table")])}
    )

    assert result.metrics.case_count == 0
    assert result.metrics.cases_with_ground_truth == 0
    assert len(result.per_acl_case) == 1


@pytest.mark.asyncio
async def test_every_acl_call_carries_the_run_id_and_its_own_trace_id() -> None:
    """구현 원칙 9 — the same discipline the quality cases already follow."""
    cases = [_acl_case(case_id="A"), _acl_case(case_id="B", question="다른 질문")]
    client = FakeSearchClient()

    result = await run_evaluation(
        search_client=client,
        dataset=_dataset(cases),
        knowledge_id="kv-1",
        policy=POLICY,
    )

    assert {c.run_id for c in client.calls} == {result.run_id}
    trace_ids = [c.trace_id for c in client.calls]
    assert all(trace_ids)
    assert len(set(trace_ids)) == len(trace_ids)


# --- Persistence and reporting ---


@pytest.mark.asyncio
async def test_result_round_trips_through_the_schema(tmp_path: Path) -> None:
    from ai_asset_schemas.validator import SchemaType, validate

    case = _acl_case(expected_visible_document_ids=["handbook"])
    result = await _run(
        [case],
        {case.question: SearchResponse(citations=[make_citation("salary-table")])},
    )

    payload = result.to_dict()
    validate(payload, SchemaType.EVALUATION_RESULT)

    path = tmp_path / "result.json"
    path.write_text(json.dumps(payload))
    reloaded = EvaluationResult.from_dict(json.loads(path.read_text()))

    assert reloaded.metrics.acl_leak_rate == 1.0
    assert reloaded.per_acl_case[0].leaked_document_ids == ["salary-table"]
    assert reloaded.per_acl_case[0].visibility_satisfied is False


def test_a_result_saved_before_acl_existed_still_loads_as_not_measured() -> None:
    """Old persisted results have no acl_* keys. They must load, and they must
    read as 'not measured' — never as a pass."""
    legacy = {
        "result_id": "r1",
        "knowledge_asset_version_id": "kv-1",
        "dataset_id": "ds",
        "dataset_version": "1.0.0",
        "evaluated_at": "2026-08-01T00:00:00Z",
        "run_id": "run-1",
        "retrieval_settings": {"top_k": 5, "alpha": 0.5, "knowledge_version": "latest"},
        "metrics": {
            "case_count": 1,
            "cases_with_ground_truth": 1,
            "recall_at_1": 1.0,
            "recall_at_5": 1.0,
            "mrr": 1.0,
            "no_result_rate": 0.0,
            "latency_p50_ms": 10.0,
            "latency_p95_ms": 10.0,
            "avg_context_tokens": 10.0,
            "forbidden_hit_rate": 0.0,
        },
        "gate": {"passed": True, "checks": []},
        "per_case": [],
    }

    reloaded = EvaluationResult.from_dict(legacy)

    assert reloaded.metrics.acl_case_count == 0
    assert reloaded.per_acl_case == []


@pytest.mark.asyncio
async def test_data_card_says_not_measured_rather_than_leaving_a_blank() -> None:
    result = await _run([], {})
    card = render_data_card(
        DataCardInputs(
            knowledge_name="사내 정책",
            knowledge_asset_id="asset-1",
            knowledge_asset_version_id="kv-1",
        ),
        _dataset([]),
        result,
    )

    assert "ACL Test" in card
    assert "측정하지 않음" in card
    assert "이 항목의 공란은 통과를 의미하지 않습니다" in card


@pytest.mark.asyncio
async def test_data_card_names_the_leaking_case_and_document() -> None:
    case = _acl_case(case_id="ACL-042")
    result = await _run(
        [case], {case.question: SearchResponse(citations=[make_citation("salary-table")])}
    )
    card = render_data_card(
        DataCardInputs(
            knowledge_name="사내 정책",
            knowledge_asset_id="asset-1",
            knowledge_asset_version_id="kv-1",
        ),
        _dataset([case]),
        result,
    )

    assert "ACL-042" in card
    assert "salary-table" in card


# --- Schema/fixture contract ---


def test_dataset_without_acl_cases_still_loads() -> None:
    """Additive field — the existing fixture must keep working untouched."""
    fixture = (
        Path(__file__).resolve().parents[3]
        / "fixtures" / "valid" / "hr-policy-knowledge" / "evaluation-dataset.json"
    )
    dataset = load_dataset(fixture)

    assert dataset.has_acl_cases is False
    assert dataset.acl_cases == []
