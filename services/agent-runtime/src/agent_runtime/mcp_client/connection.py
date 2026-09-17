"""D-094: 매니페스트 + 배포 설정 → "무엇에 연결할 것인가" 를 결정한다.

이 모듈이 이 기능의 보안 경계 전부다. 여기를 통과한 뒤에는 그냥 MCP
프로토콜을 말할 뿐이므로, **실행 대상을 정하는 판단은 전부 여기 한 곳에**
모여 있어야 한다 — 두 곳에서 정하면 한 곳만 고쳐진다.

여기서 강제하는 것(각각 D-094 의 네 겹 중 하나에 대응):

1. 운영자 opt-in — `mcp_server_install_roots` 가 비어 있으면 전면 거부.
   Bundle 설치가 서버를 실행 가능하게 만들지 않는다.
2. hosted 모드에서 stdio 거부 — 별도 스위치 없음.
3. 경로 봉쇄 — `Path.resolve()` **이후** 담김 검사라 허용 루트 안의 symlink 가
   밖을 가리켜도 통과하지 못한다(D-079 가 같은 이유로 같은 규칙을 쓴다).
   entrypoint 도 install_path 기준으로 resolve 한 뒤 다시 검사한다 — 매니페스트
   스키마가 `..`/절대경로 모양을 이미 거부하지만, 스키마는 **문자열 모양**만
   보고 symlink 는 파일시스템에만 있다.
4. 인터프리터는 설정에서만 — PATH 탐색 없음(D-084 와 같은 이유: PATH 는 검토된
   적 없는 런타임으로 조용히 해석된다).

호출자가 준 값으로 실행 대상이 넓어지는 경로는 없다: endpoint 는 매니페스트,
entrypoint 는 매니페스트, 인터프리터는 설정에서만 온다. `install_path` 만
호출자가 주는데, 그것은 허용 루트 안으로만 좁힐 수 있다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from agent_runtime.mcp_client.errors import MCPRegistrationError, MCPRegistrationReason


@dataclass(frozen=True)
class HttpTarget:
    """실행하는 것이 없다. hosted 에서 허용되는 유일한 형태."""

    endpoint: str


@dataclass(frozen=True)
class StdioTarget:
    """자식 프로세스로 띄울 대상. 세 값 모두 검증을 마친 절대 경로/인자다."""

    interpreter_path: str
    entrypoint_path: str
    args: tuple[str, ...]
    cwd: str


ConnectionTarget = HttpTarget | StdioTarget


def _resolved_roots(roots: tuple[str, ...]) -> list[Path]:
    out: list[Path] = []
    for raw in roots:
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            out.append(Path(stripped).expanduser().resolve())
        except OSError:
            # 설정에 든 잘못된 경로 하나가 나머지 허용 루트를 무력화하지 않게
            # 건너뛴다. 전부 걸러지면 아래에서 "등록 비활성" 로 귀결된다.
            continue
    return out


def _is_contained(candidate: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        return True
    return False


def _interpreter_path(interpreter: str, settings: Any) -> str:
    configured = {
        "node": settings.mcp_node_interpreter_path,
        "python": settings.mcp_python_interpreter_path,
    }.get(interpreter)
    if not configured or not str(configured).strip():
        raise MCPRegistrationError(
            MCPRegistrationReason.INTERPRETER_NOT_CONFIGURED,
            detail=f"interpreter={interpreter}",
        )
    return str(configured).strip()


def resolve_connection_target(
    manifest: dict,
    install_path: str | None,
    *,
    settings: Any,
    runtime_mode: Literal["local", "hosted"] | None = None,
) -> ConnectionTarget:
    """검증을 마친 연결 대상을 돌려주거나, 정확히 하나의 사유로 거부한다.

    `manifest` 는 이미 `mcp-server-manifest` 스키마로 검증된 것이어야 한다 —
    이 함수는 스키마가 보장하는 모양(예: transport 가 두 형태 중 하나)을
    전제로 하고, 스키마가 볼 수 없는 것(파일시스템 실체, 배포 설정)만 본다.
    """
    mode = runtime_mode or settings.runtime_mode

    # 기능 스위치. 실행이 없다고 해서 등록이 자유로운 것은 아니다 — 등록된
    # 서버는 PEP 가 police 하는 대상이 되고, 그 목록에 무엇이 들어가는지는
    # 운영자가 정한다. 다만 그 스위치는 stdio 경로 설정이 아니라 **자기 이름을
    # 가진 설정**이어야 한다(아래 stdio 분기의 루트 검사와 별개다).
    if not getattr(settings, "mcp_server_registration_enabled", False):
        raise MCPRegistrationError(MCPRegistrationReason.REGISTRATION_DISABLED)

    transport = manifest.get("transport")
    if not isinstance(transport, dict):
        raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)
    kind = transport.get("kind")

    if kind == "HTTP":
        endpoint = transport.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint.strip():
            raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)
        # HTTP 는 실행하는 것이 없으므로 install_path 를 요구하지도, 쓰지도
        # 않는다. 호출자가 보냈더라도 무시한다 — 쓰지 않는 값을 검증해 통과
        # 시키면 나중에 누군가 "이미 검증된 경로" 로 오해한다.
        return HttpTarget(endpoint=endpoint.strip())

    if kind != "STDIO":
        raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)

    # --- 여기부터 stdio: 이 배포에서 코드를 실행하게 되는 유일한 경로 --------

    if mode != "local":
        # 설정으로 뚫을 수 있는 구멍을 두지 않는다(D-094). hosted 인데 이걸
        # 켜고 싶다는 요구가 오면 그것은 이 결정을 다시 여는 일이지, 플래그를
        # 추가하는 일이 아니다.
        raise MCPRegistrationError(MCPRegistrationReason.STDIO_NOT_ALLOWED_IN_HOSTED_MODE)

    # 설치 루트는 **stdio 전용** 설정이다 — "이 배포에서 서드파티 코드를 어디서
    # 실행해도 되는가". 처음에는 이 검사를 함수 맨 앞에 두었는데, 그러면 로컬에서
    # 아무것도 실행하지 않는 HTTP 서버를 등록하는 데도 의미 없는 경로를 설정해야
    # 했다(실제로 office-mcp-server 를 등록해 보려다 막혔다). 실행과 무관한 것을
    # 실행 설정으로 막으면 운영자는 그 설정을 아무 값으로나 채우게 되고, 그러면
    # 정작 stdio 를 막으려던 통제가 형해화된다.
    roots = _resolved_roots(tuple(settings.mcp_server_install_roots))
    if not roots:
        raise MCPRegistrationError(MCPRegistrationReason.REGISTRATION_DISABLED)

    if not install_path or not install_path.strip():
        raise MCPRegistrationError(MCPRegistrationReason.INSTALL_PATH_REQUIRED)
    raw = install_path.strip()
    if not Path(raw).is_absolute():
        raise MCPRegistrationError(MCPRegistrationReason.INSTALL_PATH_NOT_ABSOLUTE)

    try:
        bundle_root = Path(raw).expanduser().resolve()
    except OSError:
        raise MCPRegistrationError(MCPRegistrationReason.INSTALL_PATH_NOT_A_DIRECTORY) from None

    if not _is_contained(bundle_root, roots):
        raise MCPRegistrationError(MCPRegistrationReason.INSTALL_PATH_OUTSIDE_ALLOWED_ROOTS)
    if not bundle_root.is_dir():
        raise MCPRegistrationError(MCPRegistrationReason.INSTALL_PATH_NOT_A_DIRECTORY)

    # 인터프리터를 경로 검사보다 **먼저** 확인하지 않는 것은 의도다: 설정
    # 누락은 관리자가 고칠 일이고 경로 위반은 거부할 일이라, 위반을 설정 안내로
    # 덮지 않는다.
    interpreter = transport.get("interpreter")
    if interpreter not in ("node", "python"):
        raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)

    entrypoint = transport.get("entrypoint")
    if not isinstance(entrypoint, str) or not entrypoint.strip():
        raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)

    try:
        entry = (bundle_root / entrypoint.strip()).resolve()
    except OSError:
        raise MCPRegistrationError(MCPRegistrationReason.ENTRYPOINT_OUTSIDE_BUNDLE) from None

    # 스키마는 문자열 모양만 본다. symlink 는 파일시스템에만 있으므로 resolve
    # 이후 다시 검사한다 — 이 한 줄이 "Bundle 안의 링크가 밖을 가리키는" 경우를
    # 막는 유일한 지점이다.
    try:
        entry.relative_to(bundle_root)
    except ValueError:
        raise MCPRegistrationError(MCPRegistrationReason.ENTRYPOINT_OUTSIDE_BUNDLE) from None

    if not entry.is_file():
        raise MCPRegistrationError(MCPRegistrationReason.ENTRYPOINT_NOT_FOUND)

    interpreter_path = _interpreter_path(interpreter, settings)

    raw_args = transport.get("args") or []
    if not isinstance(raw_args, list) or any(not isinstance(a, str) for a in raw_args):
        raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)

    return StdioTarget(
        interpreter_path=interpreter_path,
        entrypoint_path=str(entry),
        args=tuple(raw_args),
        # 서버가 자기 Bundle 안을 상대경로로 참조할 수 있게 하되, 그 밖은
        # 보이지 않게 한다. 격리는 아니다 — 격리가 아님은 D-094 에 그대로
        # 적혀 있다.
        cwd=str(bundle_root),
    )
