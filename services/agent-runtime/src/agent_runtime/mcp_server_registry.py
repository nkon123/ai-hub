"""D-094 — 설치된 MCP Server 자산을 활성화하고 거버넌스 메타데이터를 보관한다.

D-080 의 `mcp_tool_registry` 를 대체한다. 등록 단위가 "Office Profile 이 이미
이름을 아는 서버 안의 Tool 하나" 에서 "서버 하나" 로 바뀌었고, 그 서버가 사내
것일 수도 남이 만든 것일 수도 있다.

## 등록이 무엇을 보장하는가

D-080 에서는 Office Profile 이 서버 목록을 들고 있는 것이 안전 경계였다. 임의의
서드파티 서버를 붙이는 순간 그 경계는 없어진다. 대신 네 겹으로 막는다:

1. **매니페스트 검증** — 승인된 계약(`mcp-server-manifest` 스키마)과 맞는가.
   `risk_level=WRITE` 인데 확인 정책이 없는 Tool 같은 것은 스키마가 거부한다.
2. **연결 경계**(`mcp_client.connection`) — stdio 는 허용된 설치 루트 안,
   해석기는 배포 설정에서만. 매니페스트가 실행 명령을 정하지 못한다.
3. **핸드셰이크 대조** — 서버가 실제로 내놓는 `tools/list` 를 승인 시점 스냅샷과
   비교하고, **교집합만** 등록한다. 서버가 나중에 Tool 을 추가해도 자동으로
   쓰이지 않는다.
4. **거버넌스 메타데이터** — 역할/조직/등급/확인 정책은 전부 **매니페스트**(=
   검토자가 승인한 것)에서 온다. 서버가 자기 권한을 주장할 수 없다.

## 왜 메모리인가

`local_agent_registry` / `local_index_registry` 와 같다. 등록은 이 런타임
프로세스가 살아 있는 동안의 활성화이고, Desktop 은 시작할 때마다 설치된 자산을
다시 등록한다. 프로세스가 죽으면 stdio 자식도 같이 죽으므로 남겨 둘 상태가 없다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ai_asset_schemas.validator import SchemaType, ValidationError, validate

from agent_runtime.config import settings as default_settings
from agent_runtime.mcp_client import (
    MCPRegistrationError,
    MCPRegistrationReason,
    ToolPolicy,
    approved_tool_intersection,
    compute_tools_snapshot_hash,
    handshake,
    resolve_connection_target,
)

_logger = logging.getLogger("agent_runtime")

#: 계약(`mcp-server-registration.schema.json`)의 `source` 허용값.
#: Portal 배포와 Desktop 설치만 인정한다 — 임의 URL 에서 끌어오는 경로를
#: 만들지 않는다(루트 CLAUDE.md 구현 원칙 7).
ALLOWED_SOURCES = ("PORTAL_DISTRIBUTION", "DESKTOP_INSTALL", "OFFLINE_BUNDLE")


@dataclass
class RegisteredServer:
    """등록된 서버 하나. `tool_policies` 가 PEP 가 읽는 유일한 권한 근거다."""

    server_alias: str
    transport_kind: str
    state: str  # ACTIVE | FAILED | UNREACHABLE
    protocol_version: str
    tool_names: tuple[str, ...]
    provenance: str
    registered_at: str
    last_checked_at: str | None = None
    reason: str | None = None
    message: str | None = None
    tool_policies: dict[str, ToolPolicy] = field(default_factory=dict)
    manifest: dict = field(default_factory=dict)
    install_path: str | None = None

    def to_entry(self) -> dict:
        """계약의 `MCPServerRegistrationEntry`. `tool_policies`/`manifest`/
        `install_path` 는 **내보내지 않는다** — 설치 경로는 배포 구조를 드러내고,
        정책은 내부 판단 근거다."""
        return {
            "server_alias": self.server_alias,
            "transport_kind": self.transport_kind,
            "state": self.state,
            "protocol_version": self.protocol_version,
            "tool_names": list(self.tool_names),
            "provenance": self.provenance,
            "reason": self.reason,
            "message": self.message,
            "registered_at": self.registered_at,
            "last_checked_at": self.last_checked_at,
        }


def _now() -> str:
    return datetime.now(UTC).isoformat()


class MCPServerRegistry:
    def __init__(self) -> None:
        self._servers: dict[str, RegisteredServer] = {}

    # --- 조회 -------------------------------------------------------------

    def list_servers(self) -> list[RegisteredServer]:
        return sorted(self._servers.values(), key=lambda s: s.server_alias)

    def get(self, server_alias: str) -> RegisteredServer | None:
        return self._servers.get(server_alias)

    def get_policy(self, server_alias: str, tool_name: str) -> ToolPolicy | None:
        """PEP 가 디스패치 직전에 읽는 지점.

        등록되지 않은 서버/Tool 은 `None` 이고, `policy.decide` 는 `None` 을
        Default Deny 로 처리한다 — "모르는 것은 거부" 가 여기서 성립한다.
        """
        server = self._servers.get(server_alias)
        if server is None or server.state != "ACTIVE":
            return None
        return server.tool_policies.get(tool_name)

    # --- 등록 -------------------------------------------------------------

    async def register(
        self,
        manifest: dict,
        install_path: str | None,
        source: str,
        *,
        settings=None,
    ) -> RegisteredServer:
        """검증 → 연결 → 대조 → 등록. 실패는 전부 `MCPRegistrationError` 다.

        순서가 중요하다. 값싸고 확실한 거부(설정/스키마/출처)를 먼저 하고, 실제
        프로세스를 띄우거나 네트워크를 쓰는 검사는 마지막에 한다 — 거부될 요청
        때문에 서드파티 실행 파일을 띄우지 않기 위해서다.
        """
        settings = settings or default_settings

        if not settings.mcp_server_install_roots:
            raise MCPRegistrationError(MCPRegistrationReason.REGISTRATION_DISABLED)

        if source not in ALLOWED_SOURCES:
            raise MCPRegistrationError(
                MCPRegistrationReason.UNSUPPORTED_SOURCE, detail=f"source={source}"
            )

        try:
            validate(manifest, SchemaType.MCP_SERVER)
        except ValidationError as exc:
            # 스키마 오류 본문을 사용자에게 그대로 내보내지 않는다 — 내부 구조를
            # 드러낸다. `detail` 은 로그 전용이다(errors.py 참고).
            raise MCPRegistrationError(
                MCPRegistrationReason.MANIFEST_INVALID, detail="; ".join(exc.errors[:5])
            ) from exc

        server_alias = manifest.get("server_alias") or ""
        if not server_alias:
            raise MCPRegistrationError(MCPRegistrationReason.SERVER_ALIAS_INVALID)

        # 연결 경계 — stdio 허용 여부, 설치 루트 포함, 해석기 설정까지 여기서 본다.
        target = resolve_connection_target(manifest, install_path, settings=settings)

        declared_tools = manifest.get("declared_tools") or []
        # 스키마의 transport 는 `{"kind": "HTTP"|"STDIO", ...}` 한 가지 모양이다
        # (`connection.resolve_connection_target` 이 읽는 것과 같은 필드).
        transport_kind = (manifest.get("transport") or {}).get("kind", "HTTP")

        try:
            result = await handshake(
                target, timeout_seconds=settings.mcp_connect_timeout_seconds
            )
        except MCPRegistrationError as exc:
            self._remember_failure(manifest, transport_kind, exc)
            raise

        expected = manifest.get("tools_snapshot_hash")
        if expected and expected != result.snapshot_hash:
            exc = MCPRegistrationError(
                MCPRegistrationReason.TOOLS_SNAPSHOT_MISMATCH,
                detail=f"expected={expected} actual={result.snapshot_hash}",
            )
            self._remember_failure(manifest, transport_kind, exc)
            raise exc

        tool_names = approved_tool_intersection(declared_tools, result.tools)
        if not tool_names:
            exc = MCPRegistrationError(MCPRegistrationReason.NO_APPROVED_TOOL_AVAILABLE)
            self._remember_failure(manifest, transport_kind, exc)
            raise exc

        classification = manifest.get("classification")
        policies = {
            declared["tool_name"]: ToolPolicy.from_declared_tool(
                declared, server_classification=classification
            )
            for declared in declared_tools
            if isinstance(declared, dict) and declared.get("tool_name") in tool_names
        }

        entry = RegisteredServer(
            server_alias=server_alias,
            transport_kind=transport_kind,
            state="ACTIVE",
            protocol_version=result.protocol_version,
            tool_names=tool_names,
            provenance=manifest.get("provenance", "THIRD_PARTY"),
            registered_at=_now(),
            last_checked_at=_now(),
            tool_policies=policies,
            manifest=manifest,
            install_path=install_path,
        )
        self._servers[server_alias] = entry

        _logger.info(
            "mcp.server.registered alias=%s transport=%s provenance=%s tools=%d "
            "approved=%d offered=%d",
            server_alias, transport_kind, entry.provenance, len(tool_names),
            len(declared_tools), len(result.tools),
        )
        return entry

    def _remember_failure(
        self, manifest: dict, transport_kind: str, exc: MCPRegistrationError
    ) -> None:
        """실패도 목록에 남긴다.

        남기지 않으면 화면에는 그 서버가 **아예 없는** 것으로 보이고, 사용자는
        설치가 안 된 것인지 활성화에 실패한 것인지 구분할 수 없다. 상태와 사유를
        들고 있어야 "무엇을 고쳐야 하는가"를 말해 줄 수 있다.
        """
        alias = manifest.get("server_alias") or ""
        if not alias:
            return
        unreachable = {
            MCPRegistrationReason.HANDSHAKE_FAILED,
            MCPRegistrationReason.TOOLS_LIST_FAILED,
        }
        self._servers[alias] = RegisteredServer(
            server_alias=alias,
            transport_kind=transport_kind,
            state="UNREACHABLE" if exc.reason in unreachable else "FAILED",
            protocol_version=manifest.get("protocol_version", ""),
            tool_names=(),
            provenance=manifest.get("provenance", "THIRD_PARTY"),
            registered_at=_now(),
            last_checked_at=_now(),
            reason=str(exc.reason),
            message=str(exc),
        )
        _logger.warning(
            "mcp.server.registration_failed alias=%s reason=%s", alias, exc.reason
        )

    # --- 해제 -------------------------------------------------------------

    def deregister(self, server_alias: str) -> bool:
        """등록 해제. 없던 것을 지워도 오류가 아니다 — 제거 시점에 조건 없이
        호출할 수 있어야 하고, 그래야 "설치는 지웠는데 등록은 남은" 상태가
        생기지 않는다."""
        removed = self._servers.pop(server_alias, None)
        if removed is not None:
            _logger.info("mcp.server.deregistered alias=%s", server_alias)
        return removed is not None

    def clear(self) -> None:
        self._servers.clear()


_registry = MCPServerRegistry()


def get_registry() -> MCPServerRegistry:
    return _registry
