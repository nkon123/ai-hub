"""D-094 `/local/v1/mcp-servers*` — 등록 표면.

등록이 **거부하는 것**이 이 기능의 본체다. D-080 에서는 Office Profile 이 서버
목록을 들고 있는 것이 안전 경계였는데, 임의의 서드파티 서버를 붙이는 순간 그
경계가 사라진다. 그래서 여기서 확인하는 것은 "등록이 되는가"보다:

* 요청이 **연결 방법을 정할 수 없는가** — 요청 본문에 endpoint/command/env 가
  있으면 요청자가 곧 실행 명령을 정하게 되어 매니페스트 승인과 설치 루트 제한이
  한꺼번에 우회된다.
* 서버가 내놓는 Tool 중 **승인된 것만** 등록되는가(합집합이 아니라 교집합).
* 실패가 목록에서 사라지지 않는가 — 사라지면 "설치가 안 된 것"과 "활성화에
  실패한 것"을 구분할 수 없다.

실제 프로세스나 네트워크는 쓰지 않는다. 핸드셰이크 지점만 교체한다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agent_runtime import mcp_server_registry as registry_module
from agent_runtime.mcp_client import DiscoveredTool, HandshakeResult, compute_tools_snapshot_hash
from agent_runtime.mcp_server_registry import get_registry

BASE = "/local/v1/mcp-servers"


#: 승인된 유효 매니페스트를 픽스처에서 읽어 쓴다. 손으로 다시 적으면 스키마가
#: 바뀔 때 테스트만 조용히 낡는다 — 실제로 처음 이 파일을 쓸 때 transport 모양을
#: 틀리게 적어 전부 `manifest_invalid` 로 떨어졌다.
_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "fixtures" / "valid" / "mcp-server-office-connector" / "mcp-server-manifest.json"
)


def _manifest(**over) -> dict:
    manifest = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    manifest.pop("tools_snapshot_hash", None)
    manifest.update(over)
    return manifest


def _approved_tool_names() -> list[str]:
    return [t["tool_name"] for t in _manifest()["declared_tools"]]


def _fake_handshake(tool_names: tuple[str, ...], *, protocol_version: str = "2025-06-18"):
    tools = tuple(DiscoveredTool(tool_name=n, input_schema={}) for n in tool_names)

    async def _handshake(target, *, timeout_seconds: float = 20.0):
        return HandshakeResult(
            protocol_version=protocol_version,
            server_name="fake",
            tools=tools,
            snapshot_hash=compute_tools_snapshot_hash(tools),
        )

    return _handshake


@pytest.fixture(autouse=True)
def _enabled(monkeypatch, tmp_path):
    """설치 루트가 설정돼 있어야 등록 기능 자체가 켜진다."""
    from agent_runtime.config import settings

    monkeypatch.setattr(settings, "mcp_server_registration_enabled", True, raising=False)
    monkeypatch.setattr(settings, "mcp_server_install_roots", (str(tmp_path),), raising=False)
    monkeypatch.setattr(settings, "runtime_mode", "local", raising=False)
    get_registry().clear()
    yield
    get_registry().clear()


async def _register(client, **over):
    body = {"manifest": _manifest(**over.pop("manifest_over", {})), "source": "DESKTOP_INSTALL"}
    body.update(over)
    return await client.post(BASE, json=body)


# --- 요청이 연결 방법을 정할 수 없다 ----------------------------------------


def test_request_model_has_no_connection_fields() -> None:
    """endpoint/command/args/env/interpreter_path 중 무엇이라도 요청으로 받으면
    승인된 매니페스트와 배포 설정이 정해야 할 것을 요청자가 정하게 된다."""
    from agent_runtime.routers.mcp_servers import RegisterMcpServerRequest

    fields = set(RegisterMcpServerRequest.model_fields)
    forbidden = {"endpoint", "url", "command", "args", "env", "interpreter_path", "cwd"}
    assert not (fields & forbidden), f"연결 방법을 정하는 필드가 있다: {fields & forbidden}"


@pytest.mark.asyncio
async def test_unknown_request_fields_are_ignored_not_honored(client, monkeypatch) -> None:
    """모르는 필드를 보내도 연결 대상이 바뀌지 않아야 한다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    res = await client.post(
        BASE,
        json={
            "manifest": _manifest(),
            "source": "DESKTOP_INSTALL",
            "command": "cmd.exe",
            "env": {"PATH": "C:\\evil"},
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["entry"]["state"] == "ACTIVE"


# --- 승인된 것만 등록된다 ----------------------------------------------------


@pytest.mark.asyncio
async def test_only_the_intersection_of_approved_and_offered_is_registered(client, monkeypatch) -> None:
    """서버가 나중에 Tool 을 추가해도 자동으로 쓰이지 않는다 — 아무도 그것을
    검토하지 않았다."""
    monkeypatch.setattr(
        registry_module, "handshake", _fake_handshake((_approved_tool_names()[0], "delete_everything"))
    )
    res = await _register(client)
    assert res.status_code == 200, res.text
    assert res.json()["entry"]["tool_names"] == [_approved_tool_names()[0]]


@pytest.mark.asyncio
async def test_no_overlap_is_refused(client, monkeypatch) -> None:
    """승인된 Tool 을 서버가 하나도 내놓지 않으면 등록할 것이 없다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(("something_else",)))
    res = await _register(client)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "no_approved_tool_available"


@pytest.mark.asyncio
async def test_a_changed_tool_snapshot_is_refused(client, monkeypatch) -> None:
    """승인 시점과 구성이 달라졌으면 멈춘다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    # 형식은 유효하되 값만 다른 해시를 쓴다 — 형식이 틀리면 스키마 단계에서
    # 먼저 걸려 정작 확인하려던 대조 로직에 닿지 못한다.
    res = await _register(
        client, manifest_over={"tools_snapshot_hash": "sha256:" + "0" * 64}
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "tools_snapshot_mismatch"


# --- 거부 ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_invalid_manifest_is_refused_without_connecting(client, monkeypatch) -> None:
    """스키마가 거부하는 매니페스트로는 서버를 띄우지도 않는다."""
    called = {"n": 0}

    async def _boom(*a, **k):
        called["n"] += 1
        raise AssertionError("거부될 요청으로 서버에 연결하면 안 된다")

    monkeypatch.setattr(registry_module, "handshake", _boom)
    res = await _register(client, manifest_over={"declared_tools": []})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "manifest_invalid"
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_an_unknown_source_is_refused(client, monkeypatch) -> None:
    """임의 출처에서 끌어오는 경로를 만들지 않는다(구현 원칙 7)."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    res = await _register(client, source="RANDOM_URL")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "unsupported_source"


@pytest.mark.asyncio
async def test_registration_disabled_when_the_feature_is_off(
    client, monkeypatch
) -> None:
    """운영자가 기능을 꺼 둘 수 있어야 한다 — 다만 그 스위치는 stdio 경로
    설정이 아니라 자기 이름을 가진 설정이다."""
    from agent_runtime.config import settings

    monkeypatch.setattr(settings, "mcp_server_registration_enabled", False, raising=False)
    res = await _register(client)
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "mcp_server_registration_disabled"


@pytest.mark.asyncio
async def test_a_refusal_does_not_leak_paths_or_schema_internals(client, monkeypatch) -> None:
    """거부 메시지가 배포 구조를 알려 주면 안 된다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    res = await _register(client, manifest_over={"declared_tools": []})
    message = res.json()["error"]["message"]
    assert "\\" not in message and "/" not in message, message


# --- 목록 ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_failed_registration_still_appears_in_the_list(client, monkeypatch) -> None:
    """목록에서 사라지면 '설치가 안 된 것'과 '활성화에 실패한 것'을 구분할 수
    없다. 상태와 사유를 들고 있어야 무엇을 고칠지 말해 줄 수 있다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(("something_else",)))
    await _register(client)

    entries = (await client.get(BASE)).json()["entries"]
    assert len(entries) == 1
    assert entries[0]["state"] == "FAILED"
    assert entries[0]["reason"] == "no_approved_tool_available"


@pytest.mark.asyncio
async def test_the_list_reports_whether_registration_is_possible(client) -> None:
    """화면이 이 배포에서 불가능한 기능을 눌러 보게 만들지 않도록 먼저 알려 준다."""
    body = (await client.get(BASE)).json()
    assert body["mcp_server_registration_enabled"] is True
    assert body["stdio_supported"] is True


@pytest.mark.asyncio
async def test_the_list_never_exposes_install_paths(client, monkeypatch) -> None:
    """설치 경로는 배포 구조다 — 목록에 실어 보내지 않는다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    await _register(client, install_path=None)
    rendered = str((await client.get(BASE)).json())
    assert "install_path" not in rendered


# --- 해제 ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deregister_removes_the_server(client, monkeypatch) -> None:
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    await _register(client)

    res = await client.delete(f"{BASE}/office-connector")
    assert res.status_code == 200
    assert res.json()["removed"] is True
    assert (await client.get(BASE)).json()["entries"] == []


@pytest.mark.asyncio
async def test_deregistering_something_unknown_is_not_an_error(client) -> None:
    """제거 시점에 조건 없이 호출할 수 있어야 '설치는 지웠는데 등록은 남은'
    상태가 생기지 않는다."""
    res = await client.delete(f"{BASE}/없는-서버")
    assert res.status_code == 200
    assert res.json()["removed"] is False


# --- PEP 로 넘어가는 정책 ----------------------------------------------------


@pytest.mark.asyncio
async def test_registered_policy_comes_from_the_manifest_not_the_server(client, monkeypatch) -> None:
    """서버는 신뢰 대상이 아니다 — 자기 권한을 스스로 주장할 수 없다."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tuple(_approved_tool_names())))
    await _register(client)

    policy = get_registry().get_policy("office-connector", _approved_tool_names()[0])
    assert policy is not None
    assert policy.allowed_roles == tuple(
        _manifest()["declared_tools"][0]["permissions"]["allowed_roles"]
    )
    assert policy.risk_level == "READ_ONLY"


@pytest.mark.asyncio
async def test_policy_is_unavailable_for_a_failed_server(client, monkeypatch) -> None:
    """활성화되지 않은 서버의 Tool 은 정책이 없고, PEP 는 정책 없음을 거부로
    처리한다(Default Deny)."""
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(("something_else",)))
    await _register(client)
    assert get_registry().get_policy("office-connector", _approved_tool_names()[0]) is None
