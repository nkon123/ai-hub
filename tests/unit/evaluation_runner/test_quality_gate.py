"""Quality Gate pass/fail, including the regression-vs-baseline rule (§4.7)."""

from __future__ import annotations

from pathlib import Path

import pytest
from evaluation_runner.metrics import EvaluationMetrics
from evaluation_runner.quality_gate import (
    QualityGatePolicy,
    QualityGatePolicyError,
    evaluate_gate,
    load_policy,
)

POLICY = QualityGatePolicy(
    recall_at_5_min=0.80,
    recall_at_5_max_regression_pp=0.05,
    p95_latency_ms_max=2000,
    forbidden_hit_rate_max=0.0,
)


def _metrics(**overrides) -> EvaluationMetrics:
    base = dict(
        case_count=5,
        cases_with_ground_truth=5,
        recall_at_1=0.8,
        recall_at_5=0.9,
        mrr=0.85,
        no_result_rate=0.0,
        latency_p50_ms=500.0,
        latency_p95_ms=1500.0,
        avg_context_tokens=200.0,
        forbidden_hit_rate=0.0,
    )
    base.update(overrides)
    return EvaluationMetrics(**base)


def test_gate_passes_when_all_thresholds_met() -> None:
    result = evaluate_gate(_metrics(), POLICY)

    assert result.passed is True
    assert all(c.passed for c in result.checks)
    assert len(result.failed_checks) == 0


def test_gate_fails_on_recall_at_5_below_minimum() -> None:
    result = evaluate_gate(_metrics(recall_at_5=0.5), POLICY)

    assert result.passed is False
    failed_names = {c.name for c in result.failed_checks}
    assert "recall_at_5_min" in failed_names


def test_gate_fails_on_p95_latency_above_maximum() -> None:
    result = evaluate_gate(_metrics(latency_p95_ms=2500.0), POLICY)

    assert result.passed is False
    assert "p95_latency_ms_max" in {c.name for c in result.failed_checks}


def test_gate_fails_on_forbidden_hit_rate_above_maximum() -> None:
    result = evaluate_gate(_metrics(forbidden_hit_rate=0.2), POLICY)

    assert result.passed is False
    assert "forbidden_hit_rate_max" in {c.name for c in result.failed_checks}


def test_gate_regression_check_skipped_without_baseline() -> None:
    result = evaluate_gate(_metrics(recall_at_5=0.9), POLICY, baseline_recall_at_5=None)

    assert "recall_at_5_regression" not in {c.name for c in result.checks}
    assert result.passed is True


def test_gate_fails_when_recall_drops_more_than_allowed_regression() -> None:
    # baseline 0.97 -> candidate 0.90 is a 7pp drop, over the 5pp allowance,
    # even though 0.90 itself clears the 80% minimum.
    result = evaluate_gate(_metrics(recall_at_5=0.90), POLICY, baseline_recall_at_5=0.97)

    regression_check = next(c for c in result.checks if c.name == "recall_at_5_regression")
    assert regression_check.passed is False
    assert result.passed is False
    # sanity: the absolute-minimum check itself still passes independently
    recall_min_check = next(c for c in result.checks if c.name == "recall_at_5_min")
    assert recall_min_check.passed is True


def test_gate_passes_regression_check_within_allowance() -> None:
    # baseline 0.90 -> candidate 0.87 is a 3pp drop, within the 5pp allowance.
    result = evaluate_gate(_metrics(recall_at_5=0.87), POLICY, baseline_recall_at_5=0.90)

    regression_check = next(c for c in result.checks if c.name == "recall_at_5_regression")
    assert regression_check.passed is True
    assert result.passed is True


def test_load_policy_reads_real_default_config_file() -> None:
    default_path = (
        Path(__file__).resolve().parent.parent.parent.parent
        / "packages" / "evaluation-runner" / "config" / "quality-gate.yaml"
    )
    policy = load_policy(default_path)

    assert policy.recall_at_5_min == pytest.approx(0.80)
    assert policy.p95_latency_ms_max == pytest.approx(2000)


def test_load_policy_missing_file_raises() -> None:
    with pytest.raises(QualityGatePolicyError):
        load_policy("/nonexistent/quality-gate.yaml")


def test_load_policy_malformed_file_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("quality_gate:\n  recall_at_5_min: 0.8\n")  # missing required keys

    with pytest.raises(QualityGatePolicyError):
        load_policy(bad)
