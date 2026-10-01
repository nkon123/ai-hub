"""Tool 이 돌려준 오류 문구를 사용자에게 보이는 쪽 — 길이·형태 상한.

실사용(2026-10-01): git-repo 서버가 "repos.json 이 없습니다" 라고 말했는데 화면에는 늘
"MCP Tool 이 오류를 반환했습니다." 만 나와 무엇을 고칠지 알 수 없었다.
"""

from __future__ import annotations

from agent_runtime.adapters.mcp_protocol import _tool_error_message


def test_uses_the_tools_own_message() -> None:
    message = _tool_error_message([{"type": "text", "text": "repos.json 이 없습니다. repos.example.json 을 복사하세요."}])
    assert message == "MCP Tool 이 오류를 반환했습니다: repos.json 이 없습니다. repos.example.json 을 복사하세요."


def test_collapses_whitespace_into_one_line() -> None:
    message = _tool_error_message([{"type": "text", "text": "첫 줄\n\n   둘째 줄\t끝"}])
    assert message.endswith(": 첫 줄 둘째 줄 끝")
    assert "\n" not in message


def test_long_text_is_cut() -> None:
    message = _tool_error_message([{"type": "text", "text": "가" * 5000}])
    assert len(message) < 400 and message.endswith("…")


def test_falls_back_to_the_generic_sentence() -> None:
    generic = "MCP Tool 이 오류를 반환했습니다."
    assert _tool_error_message([]) == generic
    assert _tool_error_message(None) == generic
    assert _tool_error_message([{"type": "image", "data": "x"}]) == generic
    assert _tool_error_message([{"type": "text", "text": "   "}]) == generic
