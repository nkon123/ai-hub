"""Evaluation Runner — M09: Knowledge 검색 품질 평가.

04-knowledge-platform.md §4.4(검색 평가)/§4.6(버전 비교)/§4.7(Quality Gate)/
§4.8(Data Card)의 측정 계층. Never imports services/search-runtime or
services/indexing-runtime as Python packages (CLAUDE.md 구현 원칙 2) — it
only talks to search-runtime over HTTP through `SearchClient`, and only
reads indexing-runtime's `index-meta.json` output files for Data Card
metadata.
"""

from evaluation_runner.comparison import ComparisonReport, DatasetMismatchError, compare_versions
from evaluation_runner.metrics import (
    CaseResult,
    EvaluationMetrics,
    aggregate_metrics,
    evaluate_case,
)
from evaluation_runner.models import DatasetReviewStatus, EvaluationCase, EvaluationDataset
from evaluation_runner.quality_gate import (
    GateCheck,
    GateResult,
    QualityGatePolicy,
    QualityGatePolicyError,
    evaluate_gate,
    load_policy,
)
from evaluation_runner.result import EvaluationResult, RetrievalSettings
from evaluation_runner.runner import DatasetLoadError, load_dataset, run_evaluation
from evaluation_runner.search_client import (
    Citation,
    HttpSearchClient,
    SearchClient,
    SearchClientError,
    SearchResponse,
)

__all__ = [
    "CaseResult",
    "Citation",
    "ComparisonReport",
    "DatasetLoadError",
    "DatasetMismatchError",
    "DatasetReviewStatus",
    "EvaluationCase",
    "EvaluationDataset",
    "EvaluationMetrics",
    "EvaluationResult",
    "GateCheck",
    "GateResult",
    "HttpSearchClient",
    "QualityGatePolicy",
    "QualityGatePolicyError",
    "RetrievalSettings",
    "SearchClient",
    "SearchClientError",
    "SearchResponse",
    "aggregate_metrics",
    "compare_versions",
    "evaluate_case",
    "evaluate_gate",
    "load_dataset",
    "load_policy",
    "run_evaluation",
]
