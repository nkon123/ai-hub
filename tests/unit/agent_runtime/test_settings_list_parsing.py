"""목록 설정(`mcp_server_install_roots` 등)을 `.env` 에 사람이 쓰는 모양 그대로
써도 기동하는지 고정한다.

**실제로 있었던 일(2026-09-18, 사내 PC)**: agent-runtime 이 기동 중
`SettingsError: error parsing value for field "mcp_server_install_roots" from
source "DotEnvSettingsSource"` 로 죽었다. 원인은 pydantic-settings 가 복합
타입(tuple/list) 값을 **JSON 으로만** 읽는다는 것이었고, `.env` 에 적힌 값은
평문 Windows 경로였다. 이 메시지는 무엇이 잘못됐는지도, 어떻게 고치는지도
말하지 않는다 — 설정 파일 문법 하나 때문에 서비스가 아예 뜨지 않는다.

그래서 이 suite 가 고정하는 것은 두 가지다:
1. 사람이 쓰는 세 모양(평문 / `os.pathsep` 구분 / JSON 배열)이 **모두** 같은
   결과를 준다.
2. 애매하게 잘못된 값은 조용히 이상한 경로로 통과하지 않고, **무엇을 고쳐야
   하는지 말하는 오류**로 거부된다. 특히 `[`로 시작하는데 JSON 이 아닌 값을
   구분자 분리로 넘겨 버리면 `["C:\\a"]` 같은 문자열이 경로 하나가 되어
   "설정은 했는데 아무것도 안 잡히는" 상태가 된다 — 기동 실패보다 나쁘다.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from agent_runtime.config import AgentRuntimeSettings
from pydantic import ValidationError

KEY = "AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS"


def _settings_from_env_file(tmp_path: Path, line: str) -> AgentRuntimeSettings:
    """`.env` 한 줄만 있는 파일을 만들어 그것으로 설정을 읽는다 — 실제 실패가
    일어난 경로(DotEnvSettingsSource)를 그대로 지난다."""
    env_path = tmp_path / ".env"
    env_path.write_text(line + "\n", encoding="utf-8")
    # 클래스 본문 안에서 같은 이름에 대입하면 오른쪽 읽기가 그 클래스 지역
    # 이름을 먼저 보게 되어 `NameError` 가 난다 — 이름을 나눠 둔다.
    env_file_path = str(env_path)

    class _Settings(AgentRuntimeSettings):
        class Config(AgentRuntimeSettings.Config):  # type: ignore[misc]
            env_file = env_file_path

    return _Settings()


def test_plain_single_path(tmp_path: Path) -> None:
    settings = _settings_from_env_file(tmp_path, rf"{KEY}=C:\Users\hong\assets\mcp-servers")
    assert settings.mcp_server_install_roots == (r"C:\Users\hong\assets\mcp-servers",)


def test_pathsep_separated_paths(tmp_path: Path) -> None:
    line = f"{KEY}=" + os.pathsep.join([r"C:\Users\hong\a", r"C:\Users\hong\b"])
    settings = _settings_from_env_file(tmp_path, line)
    assert settings.mcp_server_install_roots == (r"C:\Users\hong\a", r"C:\Users\hong\b")


def test_json_array_still_works(tmp_path: Path) -> None:
    """기존 `.env` 를 깨뜨리지 않는다 — 이 저장소의 `.env.example` 이 지금까지
    안내해 온 모양이다."""
    settings = _settings_from_env_file(tmp_path, f'{KEY}=["C:/Users/hong/a","C:/Users/hong/b"]')
    assert settings.mcp_server_install_roots == ("C:/Users/hong/a", "C:/Users/hong/b")


def test_empty_value_means_disabled(tmp_path: Path) -> None:
    settings = _settings_from_env_file(tmp_path, f"{KEY}=")
    assert settings.mcp_server_install_roots == ()


def test_blank_lines_and_spacing_are_tolerated(tmp_path: Path) -> None:
    line = f"{KEY}=" + os.pathsep.join(["  /srv/a  ", "", " /srv/b"])
    settings = _settings_from_env_file(tmp_path, line)
    assert settings.mcp_server_install_roots == ("/srv/a", "/srv/b")


def test_broken_json_array_is_rejected_with_a_fixable_message(tmp_path: Path) -> None:
    """Windows 경로를 JSON 배열에 그대로 넣으면(`\\U` 는 JSON 에서 잘못된
    이스케이프) 거부되고, 메시지가 고치는 방법을 말한다. **구분자 분리로
    넘어가 통째로 경로 하나가 되지 않는다.**"""
    with pytest.raises(ValidationError) as excinfo:
        _settings_from_env_file(tmp_path, rf'{KEY}=["C:\Users\hong\a"]')
    message = str(excinfo.value)
    assert "역슬래시를 두 번" in message
    assert os.pathsep in message


def test_unterminated_json_array_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        _settings_from_env_file(tmp_path, f'{KEY}=["C:/a", "C:/b"')


def test_double_quoted_path_is_rejected_instead_of_silently_mangled(tmp_path: Path) -> None:
    """`.env` 에서 큰따옴표로 감싸면 python-dotenv 가 `\\a` 를 BEL 로 바꾼다.
    그 결과 존재하지 않는 경로가 조용히 설정되어 "켰는데 아무것도 안 잡힌다"가
    된다 — 제어문자가 섞인 값은 거부한다."""
    with pytest.raises(ValidationError) as excinfo:
        _settings_from_env_file(tmp_path, rf'{KEY}="C:\Users\hong\assets"')
    assert "제어문자" in str(excinfo.value)


def test_same_rule_applies_to_the_other_list_settings(tmp_path: Path) -> None:
    """세 목록 설정이 같은 규칙을 쓴다 — 하나만 고치면 다음 사람이 다른
    필드에서 같은 오류를 만난다."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "\n".join(
            [
                "AGENT_RUNTIME_LOCAL_AGENT_ROOTS=" + os.pathsep.join(["/srv/x", "/srv/y"]),
                "AGENT_RUNTIME_MCP_TOOL_REGISTRATION_ALLOWED_ALIASES=office-connector",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    env_file_path = str(env_path)

    class _Settings(AgentRuntimeSettings):
        class Config(AgentRuntimeSettings.Config):  # type: ignore[misc]
            env_file = env_file_path

    settings = _Settings()
    assert settings.local_agent_roots == ("/srv/x", "/srv/y")
    assert settings.mcp_tool_registration_allowed_aliases == ("office-connector",)
