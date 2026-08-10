"""Multi-turn conversation support (Desktop 대화 고도화).

Pure, unit-testable helpers used by `workflow.run_knowledge_chat`:

- `bound_history`: caps prior-turn growth (oldest-first eviction) by both
  turn count and an approximate character budget — both are
  `AgentRuntimeSettings` fields (`max_history_turns`/`max_history_chars`),
  never literals, per this repo's CORS-hardcoding lesson (see
  `agent_runtime.config`'s own comment on that mistake).
- `build_history_block`: renders bounded history as a plain Korean
  transcript for prompt injection.
- `rewrite_query_for_search`: 04-knowledge-platform.md §3.4 Query Rewrite,
  gated on history being non-empty (a first turn — no history — never pays
  this extra LLM call and never changes the search query, so every existing
  caller that omits history, including the 4 published Hosted chatbots, is
  byte-for-byte unaffected).

CRITICAL — what this module deliberately does NOT do: it never influences
the D-036 hallucination guard in workflow.py (`len(citations) == 0 and
len(tool_results) == 0` -> INSUFFICIENT_EVIDENCE, LLM never called). History
can change *what gets searched for* (via query rewrite) and can be *shown to
the LLM as conversational context* once the gate has already passed, but it
can never substitute for Knowledge evidence — see
`tests/integration/agent_runtime/test_runs.py`'s
`test_history_does_not_bypass_hallucination_guard` for the regression test
proving this.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import suppress
from typing import Any, TypedDict

logger = logging.getLogger(__name__)


class ConversationTurn(TypedDict):
    question: str
    answer: str


def bound_history(
    history: list[dict[str, Any]] | None,
    *,
    max_turns: int,
    max_chars: int,
) -> list[ConversationTurn]:
    """Normalizes caller-supplied history (arbitrary dicts off the wire) into
    well-formed turns, then bounds growth two ways, oldest-first eviction:

    1. keep at most the `max_turns` most recent turns;
    2. of those, drop further from the oldest end until the total rendered
       size is within `max_chars` (a conservative character-based proxy —
       this PoC has no LLM tokenizer dependency wired in here, mirroring
       04-knowledge-platform.md §3.11's "안전 여유를 둔다" philosophy for its
       own token budget).

    `max_turns <= 0` or `max_chars <= 0` disables history entirely (returns
    `[]`) rather than raising — a misconfigured setting degrades to today's
    no-history behavior, never crashes a run.
    """
    if not history or max_turns <= 0 or max_chars <= 0:
        return []

    normalized: list[ConversationTurn] = []
    for raw_turn in history:
        if not isinstance(raw_turn, dict):
            continue
        question = str(raw_turn.get("question") or "").strip()
        answer = str(raw_turn.get("answer") or "").strip()
        if not question and not answer:
            continue
        normalized.append({"question": question, "answer": answer})

    bounded = normalized[-max_turns:]

    def _size(turns: list[ConversationTurn]) -> int:
        return sum(len(t["question"]) + len(t["answer"]) for t in turns)

    while bounded and _size(bounded) > max_chars:
        bounded.pop(0)

    return bounded


def build_history_block(history: list[ConversationTurn]) -> str:
    """Renders bounded history as a plain Korean transcript, oldest first.
    Empty input renders to an empty string (callers skip the block
    entirely rather than emit an empty header — see workflow.py)."""
    lines: list[str] = []
    for turn in history:
        if turn["question"]:
            lines.append(f"사용자: {turn['question']}")
        if turn["answer"]:
            lines.append(f"어시스턴트: {turn['answer']}")
    return "\n".join(lines)


_QUERY_REWRITE_SYSTEM_PROMPT = (
    "당신은 사내 지식 검색 시스템의 Query 재작성기입니다. 아래 최근 대화와 "
    "사용자의 새 질문을 보고, 그 질문 하나만으로도 지식 검색이 가능한 완전한 "
    "한국어 검색 Query 한 줄을 만드세요.\n"
    "규칙:\n"
    "- 절대 질문에 답하지 마세요. 재작성된 검색 Query만 출력하세요.\n"
    "- 대화에 없는 사실을 새로 추가하지 마세요.\n"
    "- 고유명사·코드·숫자는 원문 그대로 보존하세요.\n"
    "- 출력은 반드시 한 줄이어야 합니다."
)


async def rewrite_query_for_search(
    question: str,
    history: list[ConversationTurn],
    llm_adapter: Any,
    *,
    model_alias: str,
    timeout_seconds: float,
) -> tuple[str, dict[str, Any]]:
    """04-knowledge-platform.md §3.4 Query Rewrite — an LLM call that turns a
    context-dependent follow-up ("그럼 신청은 어떻게 해?") into a standalone
    search query ("육아휴직 신청 절차") using the bounded conversation
    history, so Knowledge search retrieves on the actual topic instead of the
    follow-up's bare (often near-empty-signal) text.

    Returns `(search_query, meta)`:
    - `search_query` is the text to hand to `KnowledgeAdapter.search` —
      either the rewritten query, or `question` unchanged on any fallback.
    - `meta` is a small dict suitable for a `knowledge.query_rewritten` run
      event (never written to application logs — only the run's own SSE
      event trail, the same trust boundary `run.started`'s `question` field
      already uses).

    §3.4 rules honored: never used when there is no history (gate below);
    Timeout 또는 Output 오류 시 원문 Fallback (both the `asyncio.wait_for`
    timeout and any adapter/transport exception fall back to `question`
    unchanged, never raise into the caller); a single-line result only (any
    extra lines from a non-compliant model are discarded, not concatenated).
    """
    if not history:
        return question, {"rewritten": False, "reason": "no_history"}

    history_block = build_history_block(history)
    messages = [
        {"role": "system", "content": _QUERY_REWRITE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"최근 대화:\n{history_block}\n\n새 질문: {question}\n\n검색 Query:",
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
    except Exception:  # noqa: BLE001 — §3.4: any rewrite failure falls back, never fails the run
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info("knowledge.query_rewrite.fallback latency_ms=%d", latency_ms)
        return question, {
            "rewritten": False,
            "reason": "error_or_timeout",
            "latency_ms": latency_ms,
        }
    finally:
        with suppress(Exception):
            await agen.aclose()

    latency_ms = int((time.monotonic() - started) * 1000)
    raw = "".join(parts).strip()
    rewritten = raw.splitlines()[0].strip() if raw else ""

    if not rewritten:
        return question, {"rewritten": False, "reason": "empty_output", "latency_ms": latency_ms}

    return rewritten, {
        "rewritten": True,
        "original_query": question,
        "rewritten_query": rewritten,
        "latency_ms": latency_ms,
    }
