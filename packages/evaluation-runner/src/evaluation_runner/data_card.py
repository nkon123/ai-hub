"""Data Card generation — 04-knowledge-platform.md §4.8.

Renders the required Data Card sections as Markdown from an EvaluationResult
plus whatever Knowledge metadata (index-meta.json, source manifest) the
caller can supply. Per the task brief: any section this function cannot
populate from real inputs is rendered as "미기재" (not filled in) rather than
silently omitted or invented — CLAUDE.md forbids fabricating data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from evaluation_runner.models import EvaluationDataset
from evaluation_runner.result import EvaluationResult

_NOT_RECORDED = "미기재"


@dataclass(frozen=True)
class DataCardInputs:
    """Everything the Data Card template can draw on. Fields left as None
    render as 미기재 — callers should not guess values to fill these in."""

    knowledge_name: str
    knowledge_asset_id: str
    knowledge_asset_version_id: str
    owner_org: str | None = None
    owner_contact: str | None = None
    purpose: str | None = None
    included_source_scope: str | None = None
    included_source_as_of: str | None = None
    excluded_source_scope: str | None = None
    parser_strategy: str | None = None
    chunking_strategy: str | None = None
    embedding_model: str | None = None
    index_strategy: str | None = None
    default_retrieval_profile: str | None = None
    known_limitations: str | None = None
    classification: str | None = None
    access_conditions: str | None = None
    update_procedure: str | None = None
    compatible_runtimes: str | None = None
    source_document_count: int | None = None
    chunk_count: int | None = None


def _line(value: str | None) -> str:
    return value if value else _NOT_RECORDED


def _count(value: int | None) -> str:
    return str(value) if value is not None else _NOT_RECORDED


def render_data_card(
    inputs: DataCardInputs,
    dataset: EvaluationDataset,
    result: EvaluationResult,
) -> str:
    m = result.metrics
    g = result.gate
    generated_at = datetime.now(UTC).isoformat()

    gate_lines = "\n".join(
        f"- {'PASS' if c.passed else 'FAIL'} `{c.name}` — {c.message}" for c in g.checks
    )

    # §4.7 ACL Test (D-045). "측정하지 않음"과 "통과"를 절대 같은 문장으로
    # 쓰지 않는다 — Data Card는 사람이 읽고 승인 판단에 쓰는 문서라, 검사하지
    # 않은 항목이 통과처럼 보이면 그 판단이 틀린 근거 위에 서게 된다.
    if m.acl_case_count == 0:
        acl_lines = (
            "- ACL Test: **측정하지 않음** — 이 Evaluation Dataset에 `acl_cases`가 없습니다. "
            "이 항목의 공란은 통과를 의미하지 않습니다."
        )
    else:
        leaked = [c for c in result.per_acl_case if c.leaked]
        acl_lines = (
            f"- ACL Test Case 수: {m.acl_case_count}\n"
            f"- ACL 유출 비율: {m.acl_leak_rate:.1%}"
        )
        if leaked:
            detail = ", ".join(
                f"`{c.case_id}`(등급 {c.clearance} → {', '.join(c.leaked_document_ids)})"
                for c in leaked
            )
            acl_lines += f"\n- 유출 발생 Case: {detail}"
        if m.acl_cases_with_visibility_expectation > 0:
            acl_lines += (
                f"\n- 허용 등급 가시성 충족률: {m.acl_visibility_rate:.1%} "
                f"({m.acl_cases_with_visibility_expectation}건 기준)"
            )
        else:
            acl_lines += (
                "\n- 허용 등급 가시성: 미검사 — 어떤 ACL Case도 "
                "`expected_visible_document_ids`를 선언하지 않아, 검색이 아무것도 반환하지 "
                "않아도 유출 0%가 됩니다."
            )

    review_warning = ""
    if not dataset.is_expert_reviewed:
        review_warning = (
            "\n> **주의**: 이 평가에 사용된 Evaluation Dataset은 `review_status="
            f"{dataset.review_status.value}`입니다. 04-knowledge-platform.md §4.3에 따라 "
            "생성형 AI가 만든 질문은 사람 검토 없이 기준 데이터로 사용하지 않으므로, "
            "아래 평가 결과는 업무 전문가 검토 전까지 공식 품질 기준으로 취급하지 않는다.\n"
        )

    return f"""# Knowledge Data Card — {inputs.knowledge_name}

생성 시각: {generated_at} (자동 생성, evaluation-runner)
{review_warning}
## 1. 목적과 적합한 사용 사례

{_line(inputs.purpose)}

## 2. 포함 Source 범위와 기준일

- 포함 범위: {_line(inputs.included_source_scope)}
- 기준일: {_line(inputs.included_source_as_of)}
- 문서 수: {_count(inputs.source_document_count)}
- Chunk 수: {_count(inputs.chunk_count)}

## 3. 제외 Source

{_line(inputs.excluded_source_scope)}

## 4. 소유자와 문의처

- 소유 조직: {_line(inputs.owner_org)}
- 문의처: {_line(inputs.owner_contact)}

## 5. Parser/Chunk/Embedding/Index 전략

- Parser: {_line(inputs.parser_strategy)}
- Chunking: {_line(inputs.chunking_strategy)}
- Embedding Model: {_line(inputs.embedding_model)}
- Index: {_line(inputs.index_strategy)}

## 6. 기본 Retrieval Profile

{_line(inputs.default_retrieval_profile)}

## 7. 평가 데이터와 결과

- Dataset: `{dataset.dataset_id}` v{dataset.version} ({dataset.review_status.value})
- Knowledge AssetVersion: `{result.knowledge_asset_version_id}`
- 평가 시각: {result.evaluated_at}
- Case 수: {m.case_count} (Ground Truth 보유 {m.cases_with_ground_truth})
- Recall@1: {m.recall_at_1:.1%}
- Recall@5: {m.recall_at_5:.1%}
- MRR: {m.mrr:.3f}
- 검색 결과 없음 비율: {m.no_result_rate:.1%}
- P50 검색 지연시간: {m.latency_p50_ms:.0f}ms
- P95 검색 지연시간: {m.latency_p95_ms:.0f}ms
- 평균 Context Token(추정치): {m.avg_context_tokens:.0f}
- 금지 문서 오검색 비율: {m.forbidden_hit_rate:.1%}

### ACL Test (§4.7)

{acl_lines}

### Quality Gate (§4.7) — {"PASS" if g.passed else "FAIL"}

{gate_lines}

## 8. 알려진 제한사항

{_line(inputs.known_limitations)}

## 9. 보안등급과 접근 조건

- 분류등급: {_line(inputs.classification)}
- 접근 조건: {_line(inputs.access_conditions)}

## 10. 업데이트 방법

{_line(inputs.update_procedure)}

## 11. 호환 Runtime/Model

{_line(inputs.compatible_runtimes)}
"""
