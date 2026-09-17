"""`.env` 를 **프로세스의 CWD 와 무관하게** 읽는지 고정한다.

처음 구현은 `env_file = ".env"` 였다. pydantic-settings 는 그 상대 경로를
프로세스의 CWD 기준으로 푸는데, `make dev-agent-runtime` 이 `cd
services/agent-runtime` 후 기동하는 덕에 우연히 동작하고 있었다. 저장소
루트에서 띄우면 파일이 **조용히** 무시되고(오류도 경고도 없다) 모든 값이
기본값으로 돌아간다 — 실측: `mcp_server_registration_enabled=False`,
`mcp_server_install_roots=()`. 증상은 "설정을 넣었는데 반영이 안 된다" 하나뿐이라
원인을 짐작하기 어렵다.

이 저장소가 반복해서 겪은 실패 유형이다(설정이 있는데 읽는 쪽이 다른 것을
본다 — CORS origin 하드코딩, `config/ollama.json`, `.env` BOM). 그래서 "어디서
띄우든 같은 파일"이라는 성질을 테스트로 고정한다.
"""

from __future__ import annotations

from pathlib import Path

from agent_runtime import config


def test_env_file_path_is_absolute() -> None:
    env_file = config.AgentRuntimeSettings.Config.env_file
    assert Path(env_file).is_absolute(), (
        f"env_file 이 상대 경로다({env_file!r}) — 프로세스를 어디서 띄우느냐에 "
        "따라 설정이 조용히 무시된다"
    )


def test_env_file_points_at_this_service_folder() -> None:
    env_file = Path(config.AgentRuntimeSettings.Config.env_file)
    assert env_file.name == ".env"
    assert env_file.parent == config._SERVICE_ROOT
    # 서비스 루트는 `pyproject.toml` 이 있는 곳이다 — 경로 계산이 한 단계
    # 어긋나면(상위/하위) 여기서 깨진다.
    assert (config._SERVICE_ROOT / "pyproject.toml").is_file()
    assert (config._SERVICE_ROOT / ".env.example").is_file()
