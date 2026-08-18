"""Quality Gate — 04-knowledge-platform.md §4.7.

"수치는 최초 실험 후 조정하며 코드에 하드코딩하지 않고 정책 설정으로
관리한다" — every threshold here is read from a YAML policy file
(default: packages/evaluation-runner/config/quality-gate.yaml). This module
never contains a numeric literal threshold itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from evaluation_runner.metrics import EvaluationMetrics


class QualityGatePolicyError(Exception):
    """Raised when a policy file is missing or malformed."""


@dataclass(frozen=True)
class QualityGatePolicy:
    recall_at_5_min: float
    recall_at_5_max_regression_pp: float
    p95_latency_ms_max: float
    forbidden_hit_rate_max: float
    acl_leak_rate_max: float = 0.0
    acl_visibility_min: float = 1.0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> QualityGatePolicy:
        try:
            gate = data["quality_gate"]
            return QualityGatePolicy(
                recall_at_5_min=float(gate["recall_at_5_min"]),
                recall_at_5_max_regression_pp=float(gate["recall_at_5_max_regression_pp"]),
                p95_latency_ms_max=float(gate["p95_latency_ms_max"]),
                forbidden_hit_rate_max=float(gate.get("forbidden_hit_rate_max", 0.0)),
                acl_leak_rate_max=float(gate.get("acl_leak_rate_max", 0.0)),
                acl_visibility_min=float(gate.get("acl_visibility_min", 1.0)),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise QualityGatePolicyError(
                f"Quality Gate 정책 파일 형식이 올바르지 않습니다: {exc}"
            ) from exc


def load_policy(path: str | Path) -> QualityGatePolicy:
    p = Path(path)
    if not p.exists():
        raise QualityGatePolicyError(f"Quality Gate 정책 파일을 찾을 수 없습니다: {p}")
    with p.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise QualityGatePolicyError(
            f"Quality Gate 정책 파일이 비어 있거나 형식이 올바르지 않습니다: {p}"
        )
    return QualityGatePolicy.from_dict(data)


@dataclass(frozen=True)
class GateCheck:
    name: str
    passed: bool
    actual: float
    threshold: float
    comparison: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "actual": self.actual,
            "threshold": self.threshold,
            "comparison": self.comparison,
            "message": self.message,
        }


@dataclass(frozen=True)
class GateResult:
    passed: bool
    checks: list[GateCheck]

    def to_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "checks": [c.to_dict() for c in self.checks]}

    @property
    def failed_checks(self) -> list[GateCheck]:
        return [c for c in self.checks if not c.passed]


def evaluate_gate(
    metrics: EvaluationMetrics,
    policy: QualityGatePolicy,
    baseline_recall_at_5: float | None = None,
) -> GateResult:
    checks: list[GateCheck] = []

    recall_ok = metrics.recall_at_5 >= policy.recall_at_5_min
    checks.append(
        GateCheck(
            name="recall_at_5_min",
            passed=recall_ok,
            actual=metrics.recall_at_5,
            threshold=policy.recall_at_5_min,
            comparison=">=",
            message=(
                f"Recall@5 {metrics.recall_at_5:.1%}는 기준 {policy.recall_at_5_min:.0%} "
                f"{'이상 충족' if recall_ok else '미달'}"
            ),
        )
    )

    if baseline_recall_at_5 is not None:
        drop = baseline_recall_at_5 - metrics.recall_at_5
        regression_ok = drop <= policy.recall_at_5_max_regression_pp
        checks.append(
            GateCheck(
                name="recall_at_5_regression",
                passed=regression_ok,
                actual=drop,
                threshold=policy.recall_at_5_max_regression_pp,
                comparison="<=",
                message=(
                    f"이전 승인 버전 대비 Recall@5 하락폭 {drop:+.1%} "
                    f"({'허용 범위' if regression_ok else '허용 한도 초과'}, "
                    f"한도 {policy.recall_at_5_max_regression_pp:.0%})"
                ),
            )
        )

    latency_ok = metrics.latency_p95_ms <= policy.p95_latency_ms_max
    checks.append(
        GateCheck(
            name="p95_latency_ms_max",
            passed=latency_ok,
            actual=metrics.latency_p95_ms,
            threshold=policy.p95_latency_ms_max,
            comparison="<=",
            message=(
                f"P95 검색 지연시간 {metrics.latency_p95_ms:.0f}ms "
                f"({'기준 이내' if latency_ok else '기준 초과'}, "
                f"기준 {policy.p95_latency_ms_max:.0f}ms)"
            ),
        )
    )

    forbidden_ok = metrics.forbidden_hit_rate <= policy.forbidden_hit_rate_max
    checks.append(
        GateCheck(
            name="forbidden_hit_rate_max",
            passed=forbidden_ok,
            actual=metrics.forbidden_hit_rate,
            threshold=policy.forbidden_hit_rate_max,
            comparison="<=",
            message=(
                f"금지 문서 오검색 비율 {metrics.forbidden_hit_rate:.1%} "
                f"({'기준 이내' if forbidden_ok else '기준 초과'}, "
                f"기준 {policy.forbidden_hit_rate_max:.0%})"
            ),
        )
    )

    # §4.7 "모든 ACL Test 통과" (D-045). These two checks are appended ONLY
    # when the dataset actually declared ACL cases. The alternative —
    # emitting them with actual=0.0 and passed=True for every dataset — would
    # print "ACL 통과" on a Gate report for a Knowledge whose ACL behaviour
    # was never tested, which is worse than printing nothing. A caller that
    # needs to know whether ACL was measured reads `metrics.acl_case_count`.
    if metrics.acl_case_count > 0:
        leak_ok = metrics.acl_leak_rate <= policy.acl_leak_rate_max
        leak_verdict = "기준 이내" if leak_ok else "기준 초과 — 권한 없는 등급에서 문서가 검색됨"
        checks.append(
            GateCheck(
                name="acl_leak_rate_max",
                passed=leak_ok,
                actual=metrics.acl_leak_rate,
                threshold=policy.acl_leak_rate_max,
                comparison="<=",
                message=(
                    f"ACL 유출 비율 {metrics.acl_leak_rate:.1%} "
                    f"({leak_verdict}, "
                    f"기준 {policy.acl_leak_rate_max:.0%}, 검사 {metrics.acl_case_count}건)"
                ),
            )
        )

        # Only meaningful when at least one case declared what should stay
        # visible. Without that, "0건 유출"은 검색이 아무것도 못 찾아도 성립한다.
        if metrics.acl_cases_with_visibility_expectation > 0:
            visibility_ok = metrics.acl_visibility_rate >= policy.acl_visibility_min
            visibility_verdict = (
                "기준 충족"
                if visibility_ok
                else (
                    "기준 미달 — 과차단이거나, 색인/검색 자체가 동작하지 않아 "
                    "ACL 검사가 무의미할 수 있음"
                )
            )
            checks.append(
                GateCheck(
                    name="acl_visibility_min",
                    passed=visibility_ok,
                    actual=metrics.acl_visibility_rate,
                    threshold=policy.acl_visibility_min,
                    comparison=">=",
                    message=(
                        f"허용 등급에서의 문서 가시성 {metrics.acl_visibility_rate:.1%} "
                        f"({visibility_verdict}, "
                        f"기준 {policy.acl_visibility_min:.0%}, "
                        f"검사 {metrics.acl_cases_with_visibility_expectation}건)"
                    ),
                )
            )

    return GateResult(passed=all(c.passed for c in checks), checks=checks)
