"""`AGENT_RUNTIME_POC_MCP_USER_ROLES` — Desktop 대화의 로컬 사용자 역할.

고정 상수 `["USER"]` 였을 때 CREATOR/ADMIN 만 허용하는 MCP 서버를 어떤 설정으로도
부를 수 없었다(2026-09-18 실사용). 설정으로 뺀 뒤 고정할 것: 기본값은 그대로
USER, 사람이 쓰는 세 모양이 같은 결과, 그리고 빈 값은 **조용히 전부 거부**로
가지 않고 기동 시점에 거부된다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from agent_runtime.config import AgentRuntimeSettings
from pydantic import ValidationError

KEY = "AGENT_RUNTIME_POC_MCP_USER_ROLES"


def _settings_from_env_file(tmp_path: Path, line: str | None) -> AgentRuntimeSettings:
    env_path = tmp_path / ".env"
    env_path.write_text((line or "") + "\n", encoding="utf-8")
    env_file_path = str(env_path)

    class _Settings(AgentRuntimeSettings):
        class Config(AgentRuntimeSettings.Config):  # type: ignore[misc]
            env_file = env_file_path

    return _Settings()


def test_default_is_unchanged_user(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(KEY, raising=False)
    assert _settings_from_env_file(tmp_path, None).poc_mcp_user_roles == ("USER",)


@pytest.mark.parametrize(
    "value",
    ["USER,CREATOR", "USER;CREATOR", '["USER", "CREATOR"]', " user , creator ", "USER,CREATOR,USER"],
)
def test_human_written_forms_agree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.delenv(KEY, raising=False)
    settings = _settings_from_env_file(tmp_path, f"{KEY}={value}")
    assert settings.poc_mcp_user_roles == ("USER", "CREATOR")


def test_empty_value_is_refused_not_silently_deny_all(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(KEY, raising=False)
    with pytest.raises(ValidationError, match="역할이 비어"):
        _settings_from_env_file(tmp_path, f"{KEY}= , ")


def test_broken_json_says_how_to_fix(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(KEY, raising=False)
    with pytest.raises(ValidationError, match="USER,CREATOR"):
        _settings_from_env_file(tmp_path, f"{KEY}=[USER, CREATOR")
