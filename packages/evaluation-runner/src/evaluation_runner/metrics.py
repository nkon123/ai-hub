"""Search quality metrics — 04-knowledge-platform.md §4.4 required set:
Recall@1, Recall@5, MRR, 검색 결과 없음 비율, P50/P95 Search Latency, 평균
Context Token.

Recall@K/MRR are computed at document level (see matching.py / D-045):
a case counts as a hit at K if any document id among the top-K deduplicated,
rank-ordered retrieved documents is in the case's expected_document_ids.
Cases with an empty expected_document_ids (deliberate no-answer / distractor
cases) are excluded from the Recall@1/Recall@5/MRR denominator but still
count toward no_result_rate, latency, avg_context_tokens, and
forbidden_hit_rate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from evaluation_runner.matching import document_id_from_citation, normalize_expected_document_id
from evaluation_runner.models import EvaluationCase
from evaluation_runner.search_client import SearchResponse


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token). 04-knowledge-platform.md §3.11:
    "Token 계산은 실제 Generation Model Tokenizer와 다를 수 있으므로 안전
    여유를 둔다" — this is a documented heuristic, not a real tokenizer, and
    is only used for the avg_context_token metric, never for truncation
    decisions (search-runtime itself owns any real context budget)."""
    if not text:
        return 0
    return max(1, len(text) // 4)


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    question: str
    expected_document_ids: list[str]
    retrieved_document_ids: list[str]
    hit_at_1: bool
    hit_at_5: bool
    reciprocal_rank: float
    latency_ms: int
    returned_count: int
    context_tokens: int
    forbidden_hit: bool
    tags: list[str] = field(default_factory=list)

    @property
    def has_ground_truth(self) -> bool:
        return len(self.expected_document_ids) > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "question": self.question,
            "expected_document_ids": self.expected_document_ids,
            "retrieved_document_ids": self.retrieved_document_ids,
            "hit_at_1": self.hit_at_1,
            "hit_at_5": self.hit_at_5,
            "reciprocal_rank": self.reciprocal_rank,
            "latency_ms": self.latency_ms,
            "returned_count": self.returned_count,
            "context_tokens": self.context_tokens,
            "forbidden_hit": self.forbidden_hit,
            "tags": self.tags,
        }


def evaluate_case(case: EvaluationCase, response: SearchResponse) -> CaseResult:
    expected = {normalize_expected_document_id(d) for d in case.expected_document_ids}
    forbidden = {normalize_expected_document_id(d) for d in case.forbidden_document_ids}

    ranked_doc_ids: list[str] = []
    seen: set[str] = set()
    for citation in response.citations:
        doc_id = document_id_from_citation(citation)
        if doc_id and doc_id not in seen:
            seen.add(doc_id)
            ranked_doc_ids.append(doc_id)

    hit_at_1 = bool(expected) and any(d in expected for d in ranked_doc_ids[:1])
    hit_at_5 = bool(expected) and any(d in expected for d in ranked_doc_ids[:5])

    reciprocal_rank = 0.0
    if expected:
        for rank, doc_id in enumerate(ranked_doc_ids, start=1):
            if doc_id in expected:
                reciprocal_rank = 1.0 / rank
                break

    forbidden_hit = bool(forbidden) and any(d in forbidden for d in ranked_doc_ids)

    context_tokens = sum(
        estimate_tokens(c.excerpt) + estimate_tokens(c.parent_context) for c in response.citations
    )

    return CaseResult(
        case_id=case.case_id,
        question=case.question,
        expected_document_ids=sorted(expected),
        retrieved_document_ids=ranked_doc_ids,
        hit_at_1=hit_at_1,
        hit_at_5=hit_at_5,
        reciprocal_rank=reciprocal_rank,
        latency_ms=response.latency_ms,
        returned_count=len(response.citations),
        context_tokens=context_tokens,
        forbidden_hit=forbidden_hit,
        tags=list(case.tags),
    )


@dataclass(frozen=True)
class EvaluationMetrics:
    case_count: int
    cases_with_ground_truth: int
    recall_at_1: float
    recall_at_5: float
    mrr: float
    no_result_rate: float
    latency_p50_ms: float
    latency_p95_ms: float
    avg_context_tokens: float
    forbidden_hit_rate: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_count": self.case_count,
            "cases_with_ground_truth": self.cases_with_ground_truth,
            "recall_at_1": self.recall_at_1,
            "recall_at_5": self.recall_at_5,
            "mrr": self.mrr,
            "no_result_rate": self.no_result_rate,
            "latency_p50_ms": self.latency_p50_ms,
            "latency_p95_ms": self.latency_p95_ms,
            "avg_context_tokens": self.avg_context_tokens,
            "forbidden_hit_rate": self.forbidden_hit_rate,
        }


def _percentile(values: list[float], pct: float) -> float:
    """Linear-interpolation percentile (same method as numpy's default)."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * pct
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def aggregate_metrics(case_results: list[CaseResult]) -> EvaluationMetrics:
    n = len(case_results)
    with_gt = [c for c in case_results if c.has_ground_truth]
    ng = len(with_gt)

    recall_at_1 = (sum(1 for c in with_gt if c.hit_at_1) / ng) if ng else 0.0
    recall_at_5 = (sum(1 for c in with_gt if c.hit_at_5) / ng) if ng else 0.0
    mrr = (sum(c.reciprocal_rank for c in with_gt) / ng) if ng else 0.0

    no_result_rate = (sum(1 for c in case_results if c.returned_count == 0) / n) if n else 0.0
    latencies = [float(c.latency_ms) for c in case_results]
    latency_p50 = _percentile(latencies, 0.5)
    latency_p95 = _percentile(latencies, 0.95)
    avg_context_tokens = (sum(c.context_tokens for c in case_results) / n) if n else 0.0
    forbidden_hit_rate = (sum(1 for c in case_results if c.forbidden_hit) / n) if n else 0.0

    return EvaluationMetrics(
        case_count=n,
        cases_with_ground_truth=ng,
        recall_at_1=recall_at_1,
        recall_at_5=recall_at_5,
        mrr=mrr,
        no_result_rate=no_result_rate,
        latency_p50_ms=latency_p50,
        latency_p95_ms=latency_p95,
        avg_context_tokens=avg_context_tokens,
        forbidden_hit_rate=forbidden_hit_rate,
    )
