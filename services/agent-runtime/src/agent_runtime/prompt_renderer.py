"""Pure functions for rendering the standard Knowledge chat prompt."""

from __future__ import annotations

import json
from typing import Any

from agent_runtime.conversation import ConversationTurn, build_history_block

# Wraps the rendered history block when injected into the user message —
# explicitly labels it as context, not evidence, so the model is told in the
# prompt itself (in addition to the mechanical D-036 citation gate in
# workflow.py, which is what actually enforces this) not to treat prior
# conversation turns as a substitute for Knowledge citations.
_HISTORY_HEADER = "[이전 대화 — 맥락 참고용, 답변의 근거로 사용하지 마세요]"
_HISTORY_GUIDANCE = (
    "위 이전 대화는 질문의 맥락을 이해하기 위한 참고 자료일 뿐입니다. "
    "답변은 반드시 아래 제공된 Knowledge 발췌만을 근거로 작성하세요."
)


def build_context_block(citations: list[dict[str, Any]]) -> str:
    """Render a numbered context block from ranked citation dicts."""
    lines: list[str] = []
    for i, citation in enumerate(citations, start=1):
        title = citation.get("document_title", "")
        section = citation.get("section", "")
        page = citation.get("page", "")
        excerpt = citation.get("excerpt", "")
        lines.append(
            f"[{i}] {title} (섹션: {section}, 페이지: {page})\n{excerpt}"
        )
    return "\n\n".join(lines)


def build_tool_evidence_block(tool_results: list[dict[str, Any]]) -> str:
    """Render a numbered block from MCP Tool call results (the common
    envelope produced by workflow.py's MCP_TOOL_CALL stage) — cited evidence
    alongside Knowledge citations, per 02-desktop-and-agent-runtime.md §5.2's
    MCP Client rule "Tool 결과를 공통 Envelope로 변환"."""
    if not tool_results:
        return "(호출된 Tool 없음)"
    lines: list[str] = []
    for i, result in enumerate(tool_results, start=1):
        tool_name = result.get("tool_name", "")
        output = json.dumps(result.get("output", {}), ensure_ascii=False)
        lines.append(f"[Tool {i}] {tool_name}\n{output}")
    return "\n\n".join(lines)


def render_template(
    template: str,
    context_block: str,
    question: str,
    tool_evidence_block: str | None = None,
) -> str:
    """Replace literal {{context_chunks}}/{{question}} placeholders, and
    {{tool_evidence}} when `tool_evidence_block` is given (the standard
    Knowledge-only template has no such placeholder, so passing None here
    is a no-op for it)."""
    rendered = template.replace("{{context_chunks}}", context_block).replace(
        "{{question}}", question
    )
    if tool_evidence_block is not None:
        rendered = rendered.replace("{{tool_evidence}}", tool_evidence_block)
    return rendered


def build_messages(
    system_prompt: str,
    template: str,
    citations: list[dict[str, Any]],
    question: str,
    tool_results: list[dict[str, Any]] | None = None,
    history: list[ConversationTurn] | None = None,
) -> list[dict[str, str]]:
    """Build the LLM messages list: system + rendered user template.

    `tool_results` is additive/optional — omitting it (the Knowledge-only
    workflow's call site) reproduces the exact prior behavior.

    `history` (additive/optional, Desktop 대화 고도화) is prepended to the
    rendered template's user content as a clearly-labeled context-only block
    — never merged into `{{context_chunks}}`, so no prompt template file
    needs to know about it (including any operator-authored Registry prompt
    — this never touches an approved Prompt asset's own template text).
    Omitting it (every existing caller) reproduces the exact prior output
    byte-for-byte. This is a soft, prompt-level nudge only; the actual
    grounding guarantee is the D-036 citation gate in workflow.py, which
    runs before this function is ever called and does not consult `history`
    at all — see `agent_runtime.conversation`'s module docstring."""
    context_block = build_context_block(citations)
    tool_evidence_block = (
        build_tool_evidence_block(tool_results) if tool_results is not None else None
    )
    user_content = render_template(template, context_block, question, tool_evidence_block)
    if history:
        history_block = build_history_block(history)
        user_content = (
            f"{_HISTORY_HEADER}\n{history_block}\n\n{_HISTORY_GUIDANCE}\n\n{user_content}"
        )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
