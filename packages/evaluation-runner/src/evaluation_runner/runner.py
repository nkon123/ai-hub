"""Evaluation run orchestration: dataset + SearchClient -> EvaluationResult.

CLAUDE.md 구현 원칙 9 ("모든 주요 요청과 실행에는 Trace ID를 사용한다"): every
evaluation run gets one run_id (uuid4), passed as `run_id` on every
search-runtime call it makes; every individual case additionally gets its own
`trace_id` so a single case's search can be located in search-runtime logs
independent of the rest of the run.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from ai_asset_schemas.validator import SchemaType, ValidationError, validate

from evaluation_runner.metrics import (
    aggregate_acl_metrics,
    aggregate_metrics,
    evaluate_acl_case,
    evaluate_case,
)
from evaluation_runner.models import EvaluationDataset
from evaluation_runner.quality_gate import GateResult, QualityGatePolicy, evaluate_gate
from evaluation_runner.result import EvaluationResult, RetrievalSettings
from evaluation_runner.search_client import SearchClient


class DatasetLoadError(Exception):
    """Raised when an evaluation dataset file fails to load or validate."""


def load_dataset(path: str | Path) -> EvaluationDataset:
    p = Path(path)
    if not p.exists():
        raise DatasetLoadError(f"Evaluation Dataset 파일을 찾을 수 없습니다: {p}")
    with p.open() as f:
        data = json.load(f)
    try:
        validate(data, SchemaType.EVALUATION_DATASET)
    except ValidationError as exc:
        raise DatasetLoadError(f"Evaluation Dataset 스키마 검증 실패 ({p}): {exc}") from exc
    return EvaluationDataset.from_dict(data)


async def run_evaluation(
    *,
    search_client: SearchClient,
    dataset: EvaluationDataset,
    knowledge_id: str,
    knowledge_version: str = "latest",
    top_k: int = 5,
    alpha: float = 0.5,
    policy: QualityGatePolicy,
    baseline_recall_at_5: float | None = None,
) -> EvaluationResult:
    """Run every case in `dataset` against `search_client`, aggregate the
    §4.4 metrics, and evaluate the §4.7 Quality Gate against `policy`.

    `knowledge_id` is the AssetVersion id (search-runtime's `knowledge_id`
    query field is the AssetVersion id, not the Asset id — see
    data/indexes/{asset_version_id}/).
    """
    run_id = str(uuid4())
    case_results = []

    for case in dataset.cases:
        trace_id = str(uuid4())
        response = await search_client.search(
            query=case.question,
            knowledge_id=knowledge_id,
            knowledge_version=knowledge_version,
            top_k=top_k,
            alpha=alpha,
            metadata_filters=case.required_filters or None,
            trace_id=trace_id,
            run_id=run_id,
        )
        case_results.append(evaluate_case(case, response))

    # ACL cases (§4.7 / D-045). The one thing that makes them different from
    # the loop above: `access_context` is set explicitly to the case's
    # clearance, overriding this package's RESTRICTED default. That default
    # exists so ordinary quality measurement sees the whole corpus; here we
    # deliberately want to be blinded, because being blinded is the property
    # under test.
    acl_results = []
    for acl_case in dataset.acl_cases:
        trace_id = str(uuid4())
        response = await search_client.search(
            query=acl_case.question,
            knowledge_id=knowledge_id,
            knowledge_version=knowledge_version,
            top_k=top_k,
            alpha=alpha,
            trace_id=trace_id,
            run_id=run_id,
            access_context={"clearance": acl_case.clearance},
        )
        acl_results.append(evaluate_acl_case(acl_case, response))

    acl_metrics = aggregate_acl_metrics(acl_results) if acl_results else None
    metrics = aggregate_metrics(case_results, acl_metrics)
    gate: GateResult = evaluate_gate(metrics, policy, baseline_recall_at_5=baseline_recall_at_5)

    return EvaluationResult(
        result_id=str(uuid4()),
        knowledge_asset_version_id=knowledge_id,
        dataset_id=dataset.dataset_id,
        dataset_version=dataset.version,
        evaluated_at=datetime.now(UTC).isoformat(),
        run_id=run_id,
        retrieval_settings=RetrievalSettings(
            top_k=top_k, alpha=alpha, knowledge_version=knowledge_version
        ),
        metrics=metrics,
        gate=gate,
        per_case=case_results,
        per_acl_case=acl_results,
    )
