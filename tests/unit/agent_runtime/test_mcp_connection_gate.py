"""D-094 연결 게이트 — 이 기능의 보안 경계 전부가 여기를 지난다.

`resolve_connection_target` 이 통과시킨 뒤에는 그냥 프로토콜을 말할 뿐이므로,
여기서 막지 못한 것은 아무데서도 안 막힌다.

테스트가 노리는 것은 "거부되는가" 가 아니라 **"내가 생각한 이유로 거부되는가"**
다. 필수 값 누락 같은 다른 이유로 거부되면 정작 노린 경로는 열려 있는 채로
초록불이 된다(tests/CLAUDE.md의 경고). 그래서 모든 테스트가 (1) 문제 요소만
정상으로 되돌리면 통과함을 먼저 확인하고 (2) 정확한 reason 을 검사한다.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from agent_runtime.mcp_client import (
    HttpTarget,
    MCPRegistrationError,
    MCPRegistrationReason,
    StdioTarget,
    resolve_connection_target,
)


@dataclass
class FakeSettings:
    runtime_mode: str = "local"
    mcp_server_install_roots: tuple[str, ...] = ()
    mcp_node_interpreter_path: str | None = None
    mcp_python_interpreter_path: str | None = None


@pytest.fixture
def bundle(tmp_path: Path) -> Path:
    """허용 루트 안에 실제로 존재하는 설치 폴더."""
    root = tmp_path / "installed"
    server = root / "srv"
    server.mkdir(parents=True)
    (server / "main.py").write_text("# entrypoint", encoding="utf-8")
    return server


@pytest.fixture
def settings(tmp_path: Path) -> FakeSettings:
    return FakeSettings(
        runtime_mode="local",
        mcp_server_install_roots=(str(tmp_path / "installed"),),
        mcp_python_interpreter_path=sys.executable,
        mcp_node_interpreter_path=sys.executable,
    )


def _stdio_manifest(entrypoint: str = "main.py", interpreter: str = "python") -> dict:
    return {
        "server_alias": "fs-helper",
        "transport": {
            "kind": "STDIO",
            "interpreter": interpreter,
            "entrypoint": entrypoint,
            "args": ["--root", "workspace"],
            "vendored_dependencies": True,
        },
    }


def _http_manifest(endpoint: str = "http://127.0.0.1:8500/mcp") -> dict:
    return {"server_alias": "office-connector", "transport": {"kind": "HTTP", "endpoint": endpoint}}


def _reason(fn) -> MCPRegistrationReason:
    with pytest.raises(MCPRegistrationError) as exc:
        fn()
    return exc.value.reason


# --- 출발점이 실제로 통과하는지부터 ------------------------------------------


def test_stdio_baseline_resolves(settings: FakeSettings, bundle: Path) -> None:
    """아래 모든 거부 테스트는 '이 상태에서 한 가지만 망가뜨린 것'이다.
    출발점이 애초에 실패하면 그 테스트들은 아무것도 증명하지 못한다."""
    target = resolve_connection_target(_stdio_manifest(), str(bundle), settings=settings)
    assert isinstance(target, StdioTarget)
    assert target.interpreter_path == sys.executable
    assert target.entrypoint_path == str(bundle / "main.py")
    assert target.args == ("--root", "workspace")
    assert target.cwd == str(bundle)


def test_http_resolves_without_install_path(settings: FakeSettings) -> None:
    target = resolve_connection_target(_http_manifest(), None, settings=settings)
    assert target == HttpTarget(endpoint="http://127.0.0.1:8500/mcp")


# --- 1겹: 운영자 opt-in ------------------------------------------------------


def test_registration_is_off_until_an_operator_names_a_root(bundle: Path) -> None:
    """Bundle 설치가 서버를 실행 가능하게 만들지 않는다 — D-079/D-080 과 같은 모양."""
    empty = FakeSettings(mcp_server_install_roots=(), mcp_python_interpreter_path=sys.executable)
    assert (
        _reason(lambda: resolve_connection_target(_stdio_manifest(), str(bundle), settings=empty))
        == MCPRegistrationReason.REGISTRATION_DISABLED
    )


def test_http_is_also_gated_by_the_opt_in(settings: FakeSettings) -> None:
    """실행이 없다고 해서 등록이 자유로운 것은 아니다 — 등록된 서버는 PEP 가
    police 하는 대상이 되고, 그 목록에 무엇이 들어가는지는 운영자가 정한다."""
    settings.mcp_server_install_roots = ()
    assert (
        _reason(lambda: resolve_connection_target(_http_manifest(), None, settings=settings))
        == MCPRegistrationReason.REGISTRATION_DISABLED
    )


# --- 2겹: hosted 에서 stdio 금지 ---------------------------------------------


def test_stdio_is_refused_in_hosted_mode(settings: FakeSettings, bundle: Path) -> None:
    """공유 서버에서 서드파티 코드가 '지금 대화 중인 사용자'의 감사 컨텍스트로
    실행되는 것을 막는다. 나머지 조건은 전부 정상이므로 거부 이유는 모드뿐이다."""
    settings.runtime_mode = "hosted"
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(bundle), settings=settings)
        )
        == MCPRegistrationReason.STDIO_NOT_ALLOWED_IN_HOSTED_MODE
    )


def test_http_still_works_in_hosted_mode(settings: FakeSettings) -> None:
    """hosted 에서 막는 것은 stdio 이지 MCP 자체가 아니다."""
    settings.runtime_mode = "hosted"
    assert isinstance(
        resolve_connection_target(_http_manifest(), None, settings=settings), HttpTarget
    )


def test_no_setting_turns_stdio_on_in_hosted_mode(settings: FakeSettings, bundle: Path) -> None:
    """설정으로 뚫을 수 있는 구멍이 없어야 한다. 설정 객체에 stdio 를 켜는
    이름의 필드를 무엇이든 얹어도 판정이 바뀌지 않는다 — 바뀐다면 그 순간
    D-094 의 '코드로 거부, 설정이 아니라'가 거짓이 된다."""
    settings.runtime_mode = "hosted"
    for attempt in ("mcp_stdio_enabled", "allow_stdio", "mcp_allow_stdio_in_hosted"):
        setattr(settings, attempt, True)
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(bundle), settings=settings)
        )
        == MCPRegistrationReason.STDIO_NOT_ALLOWED_IN_HOSTED_MODE
    )


# --- 3겹: 경로 봉쇄 ----------------------------------------------------------


def test_install_path_outside_allowed_roots_is_refused(
    settings: FakeSettings, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere" / "srv"
    outside.mkdir(parents=True)
    (outside / "main.py").write_text("#", encoding="utf-8")
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(outside), settings=settings)
        )
        == MCPRegistrationReason.INSTALL_PATH_OUTSIDE_ALLOWED_ROOTS
    )


def test_relative_install_path_is_refused(settings: FakeSettings) -> None:
    assert (
        _reason(lambda: resolve_connection_target(_stdio_manifest(), "srv", settings=settings))
        == MCPRegistrationReason.INSTALL_PATH_NOT_ABSOLUTE
    )


def test_missing_install_path_is_refused_for_stdio(settings: FakeSettings) -> None:
    assert (
        _reason(lambda: resolve_connection_target(_stdio_manifest(), None, settings=settings))
        == MCPRegistrationReason.INSTALL_PATH_REQUIRED
    )


def test_install_path_must_be_a_directory(settings: FakeSettings, bundle: Path) -> None:
    assert (
        _reason(
            lambda: resolve_connection_target(
                _stdio_manifest(), str(bundle / "main.py"), settings=settings
            )
        )
        == MCPRegistrationReason.INSTALL_PATH_NOT_A_DIRECTORY
    )


@pytest.mark.parametrize("entrypoint", ["../escape.py", "sub/../../escape.py"])
def test_entrypoint_escaping_the_bundle_is_refused(
    settings: FakeSettings, bundle: Path, entrypoint: str
) -> None:
    """매니페스트 스키마가 이 문자열 모양을 이미 거부하지만, 런타임도 독립적으로
    막는다 — 스키마 검증을 건너뛴 경로가 생겨도 실행까지 가지 않게."""
    (bundle.parent / "escape.py").write_text("#", encoding="utf-8")
    assert (
        _reason(
            lambda: resolve_connection_target(
                _stdio_manifest(entrypoint), str(bundle), settings=settings
            )
        )
        == MCPRegistrationReason.ENTRYPOINT_OUTSIDE_BUNDLE
    )


def test_entrypoint_symlink_pointing_out_is_refused(
    settings: FakeSettings, bundle: Path, tmp_path: Path
) -> None:
    """스키마는 문자열만 본다. symlink 는 파일시스템에만 있으므로 resolve 이후
    재검사가 이걸 막는 **유일한** 지점이다(D-079 가 같은 이유로 같은 규칙을 쓴다).
    Windows 에서 symlink 생성은 권한이 필요해 없으면 건너뛴다."""
    outside = tmp_path / "outside.py"
    outside.write_text("#", encoding="utf-8")
    link = bundle / "linked.py"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink 생성 권한 없음 (Windows 개발자 모드 필요)")
    assert (
        _reason(
            lambda: resolve_connection_target(
                _stdio_manifest("linked.py"), str(bundle), settings=settings
            )
        )
        == MCPRegistrationReason.ENTRYPOINT_OUTSIDE_BUNDLE
    )


def test_missing_entrypoint_file_is_refused(settings: FakeSettings, bundle: Path) -> None:
    assert (
        _reason(
            lambda: resolve_connection_target(
                _stdio_manifest("not-there.py"), str(bundle), settings=settings
            )
        )
        == MCPRegistrationReason.ENTRYPOINT_NOT_FOUND
    )


# --- 4겹: 인터프리터는 설정에서만 -------------------------------------------


def test_interpreter_must_be_configured(settings: FakeSettings, bundle: Path) -> None:
    """PATH 로 대체하지 않는다 — PATH 는 검토된 적 없는 런타임으로 조용히
    해석된다(D-084 와 같은 이유)."""
    settings.mcp_python_interpreter_path = None
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(bundle), settings=settings)
        )
        == MCPRegistrationReason.INTERPRETER_NOT_CONFIGURED
    )


def test_blank_interpreter_is_treated_as_unconfigured(
    settings: FakeSettings, bundle: Path
) -> None:
    settings.mcp_python_interpreter_path = "   "
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(bundle), settings=settings)
        )
        == MCPRegistrationReason.INTERPRETER_NOT_CONFIGURED
    )


def test_path_violation_is_not_masked_by_missing_interpreter(
    settings: FakeSettings, tmp_path: Path
) -> None:
    """둘 다 잘못됐을 때 '설정하세요' 라고 안내하면, 관리자가 설정을 채운 뒤에야
    실은 거부 대상이었다는 것을 알게 된다. 위반이 설정 안내보다 먼저다."""
    settings.mcp_python_interpreter_path = None
    outside = tmp_path / "elsewhere" / "srv"
    outside.mkdir(parents=True)
    (outside / "main.py").write_text("#", encoding="utf-8")
    assert (
        _reason(
            lambda: resolve_connection_target(_stdio_manifest(), str(outside), settings=settings)
        )
        == MCPRegistrationReason.INSTALL_PATH_OUTSIDE_ALLOWED_ROOTS
    )


# --- 호출자가 준 값으로 실행 대상이 넓어지지 않는다 --------------------------


def test_install_path_cannot_redirect_an_http_server(settings: FakeSettings, bundle: Path) -> None:
    """HTTP 는 install_path 를 쓰지 않는다. 호출자가 보내도 무시된다 — 쓰지도
    않는 값을 검증해 통과시키면 나중에 '검증된 경로'로 오해된다."""
    target = resolve_connection_target(_http_manifest(), str(bundle), settings=settings)
    assert target == HttpTarget(endpoint="http://127.0.0.1:8500/mcp")


def test_unknown_transport_kind_is_refused(settings: FakeSettings) -> None:
    manifest = {"server_alias": "x", "transport": {"kind": "WEBSOCKET", "endpoint": "ws://x"}}
    assert (
        _reason(lambda: resolve_connection_target(manifest, None, settings=settings))
        == MCPRegistrationReason.MANIFEST_INVALID
    )
