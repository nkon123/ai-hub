"""`tool_route_include_profile_tools` — 동봉 Runtime 은 Office Profile 의 내장 DB Tool 을 후보에서 뺀다.

실사용(2026-10-01): 설치본에는 office-mcp-server 가 없는데 AI 가 "docs 폴더에는 뭐가 있어?" 에
`db_metadata.get_tables` 를 골라 "MCP Server에 연결할 수 없습니다" 로 실패했다. 등록된 MCP 서버의
Tool 은 이 설정과 무관하게 후보에 남아야 한다.
"""

from __future__ import annotations

import pytest
from agent_runtime import mcp_tools
from agent_runtime.config import settings

PROFILE = {
    "allowed_mcp_servers": [
        {"alias": "oracle-connector", "allowed_tools": ["db_metadata.get_tables", "table_count.query"]}
    ]
}


class _FakeServer:
    state = "ACTIVE"
    server_alias = "git-repo"
    tool_names = ["git.list_files"]


class _FakeRegistry:
    def list_servers(self):
        return [_FakeServer()]


@pytest.fixture()
def registered_git_tool(monkeypatch):
    import agent_runtime.mcp_server_registry as registry_module

    monkeypatch.setattr(registry_module, "get_registry", lambda: _FakeRegistry())
    monkeypatch.setattr(
        mcp_tools,
        "_spec_for",
        lambda name: (
            {"input_schema": {"type": "object"}, "description": "git"}
            if name in {"git.list_files", "db_metadata.get_tables", "table_count.query"}
            else None
        ),
    )


def _names(profile) -> list[str]:
    return [c["tool_name"] for c in mcp_tools.list_candidate_tools(profile)]


def test_default_keeps_profile_tools(registered_git_tool, monkeypatch) -> None:
    monkeypatch.setattr(settings, "tool_route_include_profile_tools", True)
    assert _names(PROFILE) == ["db_metadata.get_tables", "table_count.query", "git.list_files"]


def test_turned_off_keeps_only_registered_servers_tools(registered_git_tool, monkeypatch) -> None:
    monkeypatch.setattr(settings, "tool_route_include_profile_tools", False)
    assert _names(PROFILE) == ["git.list_files"]


def test_turned_off_does_not_stop_the_profile_from_authorising_a_call(monkeypatch) -> None:
    """후보에서 빠지는 것과 호출이 허용되는 것은 별개다 — 명시 호출(`mcp_tool`)은 그대로."""
    monkeypatch.setattr(settings, "tool_route_include_profile_tools", False)
    assert mcp_tools.resolve_allowed_alias(PROFILE, "db_metadata.get_tables") == "oracle-connector"
