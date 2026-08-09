"""Pure functions for rendering the standard Knowledge chat prompt."""

from __future__ import annotations

import json
from typing import Any


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
) -> list[dict[str, str]]:
    """Build the LLM messages list: system + rendered user template.

    `tool_results` is additive/optional — omitting it (the Knowledge-only
    workflow's call site) reproduces the exact prior behavior."""
    context_block = build_context_block(citations)
    tool_evidence_block = (
        build_tool_evidence_block(tool_results) if tool_results is not None else None
    )
    user_content = render_template(template, context_block, question, tool_evidence_block)
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
