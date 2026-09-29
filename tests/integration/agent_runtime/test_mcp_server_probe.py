"""D-107 — `POST /local/v1/mcp-servers/probe` 와 `source=DESKTOP_LOCAL`.

Desktop 에서 사용자가 직접 추가하는 서버는 매니페스트가 없다. probe 는 그
서버에 한 번 연결해 `tools/list` 를 읽기만 하고, 무엇을 실행할지는 등록과
**같은 경로**(스키마 → `resolve_connection_target`)로만 정한다. 이 파일은 그
경로가 정말 같은지(루트 밖 거부, 등록 스위치), probe 가 아무것도 등록하지
않는지, 그리고 실제 MCP 서버(`samples/mcp-servers/hello-mcp`)에서 설명과
힌트가 읽히는지를 고정한다.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from agent_runtime import mcp_server_registry as registry_module
from agent_runtime.mcp_client import DiscoveredTool, HandshakeResult, compute_tools_snapshot_hash
from agent_runtime.mcp_server_registry import get_registry

BASE = "/local/v1/mcp-servers"
_HELLO = Path(__file__).resolve().parents[3] / "samples" / "mcp-servers" / "hello-mcp"


@pytest.fixture()
def install_root(monkeypatch, tmp_path):
    from agent_runtime.config import settings

    root = tmp_path / "mcp-servers"
    root.mkdir()
    monkeypatch.setattr(settings, "mcp_server_registration_enabled", True, raising=False)
    monkeypatch.setattr(settings, "mcp_server_install_roots", (str(root),), raising=False)
    monkeypatch.setattr(settings, "runtime_mode", "local", raising=False)
    monkeypatch.setattr(settings, "mcp_python_interpreter_path", sys.executable, raising=False)
    get_registry().clear()
    yield root
    get_registry().clear()


def _stdio(entrypoint: str = "server.py") -> dict:
    return {"kind": "STDIO", "interpreter": "python", "entrypoint": entrypoint, "args": []}


def _fake_handshake(*tools: DiscoveredTool):
    async def _handshake(target, *, timeout_seconds: float = 20.0):
        return HandshakeResult(
            protocol_version="2025-06-18",
            server_name="fake",
            tools=tools,
            snapshot_hash=compute_tools_snapshot_hash(tools),
        )

    return _handshake


def _server_dir(root: Path) -> Path:
    d = root / "_local" / "hello" / "1.0.0" / "source"
    d.mkdir(parents=True)
    (d / "server.py").write_text("# placeholder\n", encoding="utf-8")
    return d


def test_probe_request_model_has_no_connection_fields() -> None:
    from agent_runtime.routers.mcp_servers import ProbeMcpServerRequest

    assert set(ProbeMcpServerRequest.model_fields) == {"transport", "install_path", "trace_id"}


@pytest.mark.asyncio
async def test_probe_reports_tools_hints_and_local_user_without_registering(
    client, monkeypatch, install_root
) -> None:
    monkeypatch.setattr(
        registry_module,
        "handshake",
        _fake_handshake(
            DiscoveredTool("files.read", {"type": "object"}, "파일 읽기", True, False),
            DiscoveredTool("files.delete", {"type": "object"}, None, None, True),
        ),
    )
    res = await client.post(
        f"{BASE}/probe",
        json={"transport": _stdio(), "install_path": str(_server_dir(install_root))},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert [t["tool_name"] for t in body["tools"]] == ["files.read", "files.delete"]
    assert body["tools"][0] == {
        "tool_name": "files.read",
        "description": "파일 읽기",
        "input_schema": {"type": "object"},
        "read_only_hint": True,
        "destructive_hint": False,
    }
    assert body["tools_snapshot_hash"].startswith("sha256:")
    assert body["local_user_context"]["organization_id"]
    assert body["local_user_context"]["roles"] == ["USER"]
    # 등록하지 않는다 — 실패든 성공이든 목록에 남지 않는다.
    listed = await client.get(BASE)
    assert listed.json()["entries"] == []


@pytest.mark.asyncio
async def test_probe_refuses_code_outside_the_install_root(
    client, monkeypatch, install_root, tmp_path
) -> None:
    """probe 도 루트 밖 코드는 실행하지 않는다 — 등록과 같은 판정이다."""
    called = False

    async def _must_not_connect(*args, **kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(registry_module, "handshake", _must_not_connect)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "server.py").write_text("# x\n", encoding="utf-8")
    res = await client.post(
        f"{BASE}/probe", json={"transport": _stdio(), "install_path": str(outside)}
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "install_path_outside_allowed_roots"
    assert called is False


@pytest.mark.asyncio
async def test_probe_is_off_when_registration_is_off(client, monkeypatch, install_root) -> None:
    from agent_runtime.config import settings

    monkeypatch.setattr(settings, "mcp_server_registration_enabled", False, raising=False)
    res = await client.post(
        f"{BASE}/probe", json={"transport": {"kind": "HTTP", "endpoint": "http://127.0.0.1:9/mcp"}}
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "mcp_server_registration_disabled"


@pytest.mark.asyncio
async def test_probe_validates_transport_with_the_manifest_schema(client, install_root) -> None:
    """transport 모양 검사를 따로 두지 않고 매니페스트 스키마를 쓴다 —
    절대경로·`..` entrypoint 는 스키마가 먼저 거부한다."""
    for transport in (
        _stdio("../escape.py"),
        _stdio("C:/abs.py"),
        {"kind": "SHELL", "command": "cmd.exe"},
    ):
        res = await client.post(
            f"{BASE}/probe", json={"transport": transport, "install_path": str(install_root)}
        )
        assert res.status_code == 400, transport
        assert res.json()["error"]["code"] == "manifest_invalid"


@pytest.mark.asyncio
async def test_desktop_local_source_registers(client, monkeypatch, install_root) -> None:
    tool = DiscoveredTool("hello.echo", {"type": "object"})
    monkeypatch.setattr(registry_module, "handshake", _fake_handshake(tool))
    manifest = registry_module._probe_manifest(_stdio())
    manifest.update(
        server_alias="hello-local",
        declared_tools=[
            {
                "tool_name": "hello.echo",
                "risk_level": "READ_ONLY",
                "confirmation_policy": "ALWAYS",
                "permissions": {"allowed_roles": ["USER"], "allowed_orgs": ["miracom"]},
            }
        ],
    )
    res = await client.post(
        BASE,
        json={
            "manifest": manifest,
            "install_path": str(_server_dir(install_root)),
            "source": "DESKTOP_LOCAL",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["entry"]["state"] == "ACTIVE"
    assert get_registry().get_policy("hello-local", "hello.echo").confirmation_policy == "ALWAYS"


@pytest.mark.asyncio
async def test_probe_reads_a_real_server(client, install_root) -> None:
    """가짜 handshake 없이 실제 MCP 서버(hello-mcp)에 연결해, SDK 가 주는
    설명과 annotations 가 계약 필드로 옮겨지는지 확인한다."""
    source = install_root / "_local" / "hello-mcp" / "1.0.0" / "source"
    source.mkdir(parents=True)
    shutil.copy(_HELLO / "server.py", source / "server.py")
    res = await client.post(
        f"{BASE}/probe", json={"transport": _stdio(), "install_path": str(source)}
    )
    assert res.status_code == 200, res.text
    tools = {t["tool_name"]: t for t in res.json()["tools"]}
    assert set(tools) == {"hello.echo", "hello.now"}
    assert tools["hello.now"]["read_only_hint"] is True
    assert tools["hello.now"]["description"]
