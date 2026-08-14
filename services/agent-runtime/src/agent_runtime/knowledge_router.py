"""Agentic Knowledge selection — the KNOWLEDGE_ROUTE stage.

Background: Desktop's chat used to fan out every search to *every*
installed+activated Knowledge (`knowledge_ids`, `agent_runtime.workflow`'s
Stage 1 fan-out). That dilutes evidence once several unrelated Knowledge
packages are installed — an HR-policy question should not also search an IT
runbook. This module lets a caller instead hand over `knowledge_candidates`
(id + metadata only) and have one LLM call choose the subset actually worth
searching, using nothing but that metadata and the current question.

Design (mirrors `agent_runtime.conversation.rewrite_query_for_search`, the
closest existing precedent for "one optional LLM call inside the workflow,
with a fallback"):

- Input to the LLM is ONLY the current turn's `question` plus each
  candidate's `knowledge_id`/`name`/`description`/`tags`/`classification`.
  Document text, citations, and prior turns' answers are NEVER sent here —
  this stage runs before KNOWLEDGE_SEARCH, so no document text even exists
  yet in this Run, and history's `["answer"]` fields are simply never read
  by this module (same trust-boundary discipline as `hub_query.py`'s D-078
  chokepoint, applied to a different destination: the LLM prompt, not the
  hub).
- Below `skip_threshold` candidates, routing is skipped entirely — no LLM
  call — because routing 1-2 Knowledge is pure latency for no benefit.
  Skipping is not an error; every candidate is searched.
- Fail-open, deliberately: an LLM error, timeout, unparseable response, or a
  response naming an id outside the candidate list all fall back to
  searching every candidate — never zero, never a guessed-at subset.
- An EMPTY selection (the model validly returned `"selected": []`) is
  treated the same as a failure: search every candidate. "We chose not to
  search anything" and "we searched and found nothing" are different facts —
  only the latter is what workflow.py's D-036 hallucination guard means by
  zero citations. Collapsing the two would silently change what
  INSUFFICIENT_EVIDENCE means for every existing caller. This is called
  "abstaining" below and is logged/emitted like any other fallback.

`route_knowledge_candidates` never raises — every failure path is a
returned `KnowledgeRouteResult` with `status="fallback"`, so a caller can
`await` it directly without its own try/except (same shape as
`rewrite_query_for_search`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from dataclasses import dataclass, replace
from typing import Any, Literal, TypedDict

logger = logging.getLogger(__name__)


class KnowledgeCandidate(TypedDict, total=False):
    knowledge_id: str
    name: str
    description: str
    tags: list[str]
    classification: str
    retrieval_profile: dict[str, Any]


class KnowledgeRouteChoice(TypedDict):
    knowledge_id: str
    reason: str


RouteStatus = Literal["ran", "skipped", "fallback"]


@dataclass(frozen=True)
class KnowledgeRouteResult:
    """`selected_ids` is always what the caller should actually search —
    regardless of `status`, it is never an empty list unless `candidates`
    itself normalized to empty (nothing was ever offered to route over).

    - `status="ran"`: the LLM call happened and returned a usable,
      non-empty subset. `fallback_reason` is `None`.
    - `status="skipped"`: candidate count was at/below the threshold (or
      there were no valid candidates at all) — the LLM was never called.
      `selected_ids` is every candidate id, `fallback_reason` is `None`.
    - `status="fallback"`: the LLM call happened but its result could not
      be trusted (error/timeout/unparseable/unknown id/empty selection) —
      `selected_ids` is every candidate id, `fallback_reason` says why.
    """

    selected_ids: list[str]
    selected: list[KnowledgeRouteChoice]
    excluded: list[KnowledgeRouteChoice]
    status: RouteStatus
    fallback_reason: str | None = None
    latency_ms: int | None = None


_ROUTE_SYSTEM_PROMPT = (
    "당신은 사내 지식 검색 라우터입니다. 사용자의 질문과 아래 후보 지식 자산 "
    "목록(이름, 설명, 태그, 분류)만 보고, 이 질문에 답하기 위해 검색이 "
    "필요한 지식 자산만 고르세요. 문서 본문은 주어지지 않습니다 — 목록에 "
    "적힌 정보만으로 판단하세요.\n"
    "규칙:\n"
    "- 반드시 JSON 객체 하나만 출력하세요. 다른 설명이나 코드 블록 표시를 "
    "덧붙이지 마세요.\n"
    "- 관련 있는지 확신할 수 없으면 포함하세요(누락보다 과다 포함이 "
    "안전합니다).\n"
    "- 모든 후보는 selected 또는 excluded 중 정확히 한 곳에만 넣으세요.\n"
    "- 각 항목마다 한국어로 한 문장 이내의 이유(reason)를 작성하세요.\n"
    '- 출력 형식: {"selected": [{"knowledge_id": "...", "reason": "..."}], '
    '"excluded": [{"knowledge_id": "...", "reason": "..."}]}'
)


def _normalize_candidates(candidates: list[dict[str, Any]]) -> list[KnowledgeCandidate]:
    """Defensive, same style as `conversation.bound_history`: a malformed
    entry (not a dict, or missing `knowledge_id`) is dropped rather than
    raising — a caller sending garbage degrades to "fewer candidates to
    route over", never a crashed Run."""
    normalized: list[KnowledgeCandidate] = []
    seen: set[str] = set()
    for raw in candidates:
        if not isinstance(raw, dict):
            continue
        knowledge_id = str(raw.get("knowledge_id") or "").strip()
        if not knowledge_id or knowledge_id in seen:
            continue
        seen.add(knowledge_id)
        candidate: KnowledgeCandidate = {"knowledge_id": knowledge_id}
        name = raw.get("name")
        if name:
            candidate["name"] = str(name)
        description = raw.get("description")
        if description:
            candidate["description"] = str(description)
        tags = raw.get("tags")
        if isinstance(tags, list):
            candidate["tags"] = [str(t) for t in tags]
        classification = raw.get("classification")
        if classification:
            candidate["classification"] = str(classification)
        normalized.append(candidate)
    return normalized


def _render_candidate_block(candidates: list[KnowledgeCandidate]) -> str:
    lines: list[str] = []
    for c in candidates:
        tags = ", ".join(c.get("tags", [])) or "(없음)"
        lines.append(
            f"- knowledge_id: {c['knowledge_id']}\n"
            f"  이름: {c.get('name', '(없음)')}\n"
            f"  설명: {c.get('description', '(없음)')}\n"
            f"  태그: {tags}\n"
            f"  분류: {c.get('classification', '(없음)')}"
        )
    return "\n".join(lines)


def _search_all(
    candidates: list[KnowledgeCandidate],
    reason: str,
    *,
    status: RouteStatus,
    fallback_reason: str | None,
) -> KnowledgeRouteResult:
    ids = [c["knowledge_id"] for c in candidates]
    choices: list[KnowledgeRouteChoice] = [{"knowledge_id": cid, "reason": reason} for cid in ids]
    return KnowledgeRouteResult(
        selected_ids=ids,
        selected=choices,
        excluded=[],
        status=status,
        fallback_reason=fallback_reason,
    )


def _parse_json_object(raw: str) -> dict[str, Any] | None:
    """Tolerant JSON extraction: a well-behaved model returns a bare JSON
    object; a local model may still wrap it in prose or a code fence. Try
    the whole string first, then the substring between the first `{` and
    the last `}`. Anything else is unparseable — the caller falls back."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


async def route_knowledge_candidates(
    question: str,
    candidates: list[dict[str, Any]],
    llm_adapter: Any,
    *,
    model_alias: str,
    timeout_seconds: float,
    skip_threshold: int,
) -> KnowledgeRouteResult:
    """Chooses the subset of `candidates` worth searching for `question`.

    Never raises. See `KnowledgeRouteResult`'s docstring for what each
    `status` means and what `selected_ids` is in each case."""
    normalized = _normalize_candidates(candidates)
    if not normalized:
        # Nothing valid was ever offered to route over — there is no "all
        # candidates" to fall back to. The caller (workflow.py) treats this
        # exactly like `knowledge_candidates` had never been supplied.
        return KnowledgeRouteResult(
            selected_ids=[], selected=[], excluded=[], status="skipped", fallback_reason=None
        )

    if len(normalized) <= skip_threshold:
        return _search_all(
            normalized,
            "후보 지식 자산 수가 적어 전체를 검색합니다.",
            status="skipped",
            fallback_reason=None,
        )

    candidate_ids = {c["knowledge_id"] for c in normalized}
    messages = [
        {"role": "system", "content": _ROUTE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"질문: {question}\n\n"
                f"후보 지식 자산:\n{_render_candidate_block(normalized)}\n\n"
                "JSON:"
            ),
        },
    ]

    started = time.monotonic()
    agen = llm_adapter.generate(messages, model_alias=model_alias, stream=True)
    parts: list[str] = []
    try:

        async def _collect() -> None:
            async for token in agen:
                parts.append(token)

        await asyncio.wait_for(_collect(), timeout=timeout_seconds)
    except Exception:  # noqa: BLE001 — any routing failure falls back, never fails the run
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info("knowledge.route.fallback reason=error_or_timeout latency_ms=%d", latency_ms)
        result = _search_all(
            normalized,
            "라우팅 호출에 실패하여 전체를 검색합니다.",
            status="fallback",
            fallback_reason="error_or_timeout",
        )
        return _with_latency(result, latency_ms)
    finally:
        with suppress(Exception):
            await agen.aclose()

    latency_ms = int((time.monotonic() - started) * 1000)
    raw = "".join(parts).strip()
    parsed = _parse_json_object(raw)

    if parsed is None or not isinstance(parsed.get("selected"), list):
        logger.info("knowledge.route.fallback reason=unparseable latency_ms=%d", latency_ms)
        result = _search_all(
            normalized,
            "라우팅 결과를 해석할 수 없어 전체를 검색합니다.",
            status="fallback",
            fallback_reason="unparseable",
        )
        return _with_latency(result, latency_ms)

    selected_ids: list[str] = []
    selected_reasons: dict[str, str] = {}
    for entry in parsed["selected"]:
        if not isinstance(entry, dict):
            continue
        kid = str(entry.get("knowledge_id") or "").strip()
        if not kid:
            continue
        if kid not in candidate_ids:
            logger.info("knowledge.route.fallback reason=invalid_ids latency_ms=%d", latency_ms)
            result = _search_all(
                normalized,
                "라우팅 결과에 알 수 없는 지식 자산이 포함되어 전체를 검색합니다.",
                status="fallback",
                fallback_reason="invalid_ids",
            )
            return _with_latency(result, latency_ms)
        if kid not in selected_reasons:
            selected_ids.append(kid)
        reason = entry.get("reason")
        selected_reasons[kid] = str(reason) if reason else "관련 있는 지식으로 선택되었습니다."

    if not selected_ids:
        # Valid JSON, but the router chose nothing — "abstained". Treated
        # identically to a failure (search everything), never as "search
        # nothing" — see this module's docstring for why that distinction
        # matters for the D-036 hallucination guard.
        logger.info("knowledge.route.abstained latency_ms=%d", latency_ms)
        result = _search_all(
            normalized,
            "라우터가 아무 것도 선택하지 않아 전체를 검색합니다.",
            status="fallback",
            fallback_reason="abstained",
        )
        return _with_latency(result, latency_ms)

    excluded_reasons: dict[str, str] = {}
    excluded_raw = parsed.get("excluded")
    if isinstance(excluded_raw, list):
        for entry in excluded_raw:
            if not isinstance(entry, dict):
                continue
            kid = str(entry.get("knowledge_id") or "").strip()
            if kid in candidate_ids and kid not in selected_reasons:
                reason = entry.get("reason")
                excluded_reasons[kid] = str(reason) if reason else "관련성이 낮아 제외되었습니다."

    selected_choices: list[KnowledgeRouteChoice] = [
        {"knowledge_id": kid, "reason": selected_reasons[kid]} for kid in selected_ids
    ]
    excluded_choices: list[KnowledgeRouteChoice] = [
        {
            "knowledge_id": c["knowledge_id"],
            "reason": excluded_reasons.get(c["knowledge_id"], "관련성이 낮아 제외되었습니다."),
        }
        for c in normalized
        if c["knowledge_id"] not in selected_reasons
    ]

    return KnowledgeRouteResult(
        selected_ids=selected_ids,
        selected=selected_choices,
        excluded=excluded_choices,
        status="ran",
        fallback_reason=None,
        latency_ms=latency_ms,
    )


def _with_latency(result: KnowledgeRouteResult, latency_ms: int) -> KnowledgeRouteResult:
    return replace(result, latency_ms=latency_ms)
