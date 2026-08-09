"""evaluate-knowledge CLI — run/compare Knowledge search evaluations (M09).

Mirrors ai_asset_schemas.cli's validate-manifest style (click, PASS/FAIL text
output, non-zero exit code on failure/gate-fail) so it fits the same
operator muscle memory as the schema validator CLI.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import click

from evaluation_runner.comparison import DatasetMismatchError, compare_versions
from evaluation_runner.data_card import DataCardInputs, render_data_card
from evaluation_runner.quality_gate import QualityGatePolicyError, load_policy
from evaluation_runner.result import EvaluationResult
from evaluation_runner.runner import DatasetLoadError, load_dataset, run_evaluation
from evaluation_runner.search_client import HttpSearchClient, SearchClientError
from evaluation_runner.settings import settings


def _print_metrics_report(result: EvaluationResult) -> None:
    m = result.metrics
    gt = m.cases_with_ground_truth
    click.echo("")
    click.echo(f"Knowledge AssetVersion : {result.knowledge_asset_version_id}")
    click.echo(f"Dataset                : {result.dataset_id} v{result.dataset_version}")
    click.echo(f"Run ID                 : {result.run_id}")
    click.echo(f"Cases                  : {m.case_count} (Ground Truth 보유 {gt})")
    click.echo("")
    click.echo(f"  Recall@1             : {m.recall_at_1:.1%}")
    click.echo(f"  Recall@5             : {m.recall_at_5:.1%}")
    click.echo(f"  MRR                  : {m.mrr:.3f}")
    click.echo(f"  검색 결과 없음 비율   : {m.no_result_rate:.1%}")
    click.echo(f"  P50 Latency          : {m.latency_p50_ms:.0f}ms")
    click.echo(f"  P95 Latency          : {m.latency_p95_ms:.0f}ms")
    click.echo(f"  평균 Context Token    : {m.avg_context_tokens:.0f}")
    click.echo(f"  금지 문서 오검색 비율 : {m.forbidden_hit_rate:.1%}")
    click.echo("")
    click.echo(f"Quality Gate: {'PASS' if result.gate.passed else 'FAIL'}")
    for c in result.gate.checks:
        click.echo(f"  [{'PASS' if c.passed else 'FAIL'}] {c.name}: {c.message}")
    click.echo("")
    click.echo("Per-case:")
    for c in result.per_case:
        marker = "PASS" if (not c.expected_document_ids or c.hit_at_5) else "FAIL"
        click.echo(
            f"  [{marker}] {c.case_id}: hit@1={c.hit_at_1} hit@5={c.hit_at_5} "
            f"rr={c.reciprocal_rank:.2f} latency={c.latency_ms}ms "
            f"retrieved={c.retrieved_document_ids}"
        )


@click.group()
def main() -> None:
    """Knowledge 검색 품질 평가 (04-knowledge-platform.md §4.4/§4.6/§4.7)."""


@main.command("run")
@click.option(
    "--dataset", "dataset_path", required=True, type=click.Path(exists=True, path_type=Path),
    help="Evaluation Dataset JSON 파일 (evaluation-dataset.schema.json)",
)
@click.option(
    "--knowledge-id", required=True,
    help="검색 대상 Knowledge AssetVersion id (data/indexes/{id}/)",
)
@click.option("--knowledge-version", default="latest", show_default=True)
@click.option("--top-k", default=None, type=int, help=f"기본값: {settings.default_top_k}")
@click.option("--alpha", default=None, type=float, help=f"기본값: {settings.default_alpha}")
@click.option(
    "--search-runtime-url", default=None, help=f"기본값: {settings.search_runtime_url}"
)
@click.option(
    "--policy", "policy_path", default=None, type=click.Path(path_type=Path),
    help=f"Quality Gate 정책 파일. 기본값: {settings.default_quality_gate_policy}",
)
@click.option(
    "--baseline-result", "baseline_result_path", default=None,
    type=click.Path(exists=True, path_type=Path),
    help="이전 승인 버전의 evaluation-result.json — Recall@5 회귀 검사(§4.7)에 사용",
)
@click.option(
    "--output", "output_path", default=None, type=click.Path(path_type=Path),
    help="evaluation-result.json을 기록할 경로",
)
@click.option(
    "--data-card", "data_card_path", default=None, type=click.Path(path_type=Path),
    help="Data Card Markdown을 기록할 경로 (§4.8)",
)
@click.option("--knowledge-name", default=None, help="Data Card에 표기할 Knowledge 이름")
def run_cmd(
    dataset_path: Path,
    knowledge_id: str,
    knowledge_version: str,
    top_k: int | None,
    alpha: float | None,
    search_runtime_url: str | None,
    policy_path: Path | None,
    baseline_result_path: Path | None,
    output_path: Path | None,
    data_card_path: Path | None,
    knowledge_name: str | None,
) -> None:
    """Evaluation Dataset을 지정한 Knowledge에 대해 실행하고 §4.4 지표 +
    §4.7 Quality Gate 결과를 출력한다."""
    try:
        dataset = load_dataset(dataset_path)
    except DatasetLoadError as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)

    try:
        policy = load_policy(policy_path or settings.default_quality_gate_policy)
    except QualityGatePolicyError as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)

    baseline_recall_at_5: float | None = None
    if baseline_result_path is not None:
        with baseline_result_path.open() as f:
            baseline_result = EvaluationResult.from_dict(json.load(f))
        baseline_recall_at_5 = baseline_result.metrics.recall_at_5

    client = HttpSearchClient(
        base_url=search_runtime_url or settings.search_runtime_url,
        timeout_seconds=settings.request_timeout_seconds,
    )

    try:
        result = asyncio.run(
            run_evaluation(
                search_client=client,
                dataset=dataset,
                knowledge_id=knowledge_id,
                knowledge_version=knowledge_version,
                top_k=top_k if top_k is not None else settings.default_top_k,
                alpha=alpha if alpha is not None else settings.default_alpha,
                policy=policy,
                baseline_recall_at_5=baseline_recall_at_5,
            )
        )
    except SearchClientError as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)

    if not dataset.is_expert_reviewed:
        click.echo(
            f"경고: Dataset review_status={dataset.review_status.value} — §4.3에 따라 "
            "업무 전문가 검토 전까지 이 결과를 공식 품질 기준으로 사용하지 마십시오.",
            err=True,
        )

    _print_metrics_report(result)

    if output_path is not None:
        output_path.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        click.echo(f"\nWrote evaluation result: {output_path}")

    if data_card_path is not None:
        index_meta = _read_index_meta(knowledge_id)
        inputs = DataCardInputs(
            knowledge_name=knowledge_name or knowledge_id,
            knowledge_asset_id=dataset.knowledge_asset_id,
            knowledge_asset_version_id=knowledge_id,
            embedding_model=index_meta.get("embed_model") if index_meta else None,
            source_document_count=index_meta.get("document_count") if index_meta else None,
            chunk_count=index_meta.get("chunk_count") if index_meta else None,
        )
        card = render_data_card(inputs, dataset, result)
        data_card_path.write_text(card)
        click.echo(f"Wrote Data Card: {data_card_path}")

    if not result.gate.passed:
        sys.exit(1)


def _read_index_meta(knowledge_id: str) -> dict | None:
    meta_path = settings.index_base / knowledge_id / "index-meta.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


@main.command("compare")
@click.option(
    "--baseline", "baseline_path", required=True, type=click.Path(exists=True, path_type=Path),
    help="baseline evaluation-result.json",
)
@click.option(
    "--candidate", "candidate_path", required=True, type=click.Path(exists=True, path_type=Path),
    help="candidate evaluation-result.json",
)
@click.option(
    "--output", "output_path", default=None, type=click.Path(path_type=Path),
    help="비교 리포트를 기록할 JSON 경로",
)
def compare_cmd(baseline_path: Path, candidate_path: Path, output_path: Path | None) -> None:
    """동일 Evaluation Dataset Version으로 만든 두 평가 결과를 비교한다 (§4.6)."""
    with baseline_path.open() as f:
        baseline = EvaluationResult.from_dict(json.load(f))
    with candidate_path.open() as f:
        candidate = EvaluationResult.from_dict(json.load(f))

    try:
        report = compare_versions(baseline, candidate)
    except DatasetMismatchError as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)

    click.echo(f"Baseline Knowledge Version  : {report.baseline_knowledge_version}")
    click.echo(f"Candidate Knowledge Version : {report.candidate_knowledge_version}")
    click.echo(f"Dataset                     : {report.dataset_id} v{report.dataset_version}")
    click.echo("")
    click.echo(f"  Recall@1 변화 : {report.recall_at_1_delta:+.1%}")
    click.echo(f"  Recall@5 변화 : {report.recall_at_5_delta:+.1%}")
    click.echo(f"  MRR 변화      : {report.mrr_delta:+.3f}")
    click.echo(f"  P95 지연 변화  : {report.latency_p95_delta_ms:+.0f}ms")
    click.echo(f"  결과없음 변화  : {report.no_result_rate_delta:+.1%}")
    click.echo("")
    click.echo(f"  개선된 Case : {report.improved_case_ids or '없음'}")
    click.echo(f"  퇴행한 Case : {report.regressed_case_ids or '없음'}")
    if report.new_case_ids:
        click.echo(f"  신규 Case(비교 제외) : {report.new_case_ids}")
    if report.removed_case_ids:
        click.echo(f"  삭제된 Case(비교 제외) : {report.removed_case_ids}")
    click.echo("")
    click.echo(f"권고: {report.recommendation}")
    for reason in report.blocking_reasons:
        click.echo(f"  차단 사유: {reason}")

    if output_path is not None:
        output_path.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        click.echo(f"\nWrote comparison report: {output_path}")

    if report.recommendation != "승인 권고":
        sys.exit(1)


if __name__ == "__main__":
    main()
