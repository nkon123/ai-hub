"""D-094 MCP Server Manifest — 계약이 표현조차 할 수 없어야 하는 상태들.

`test_valid_fixtures.py`/`test_invalid_fixtures.py`가 이미 fixture 자체는
검사한다. 여기서 따로 고정하는 것은 **왜 그 fixture가 거부되는가** 다 —
fixture 하나는 필드 하나만 바뀌어도 다른 이유로 계속 실패할 수 있어서,
"거부되고 있다"는 사실만으로는 노리던 속성이 살아 있다는 증거가 되지 않는다
(tests/CLAUDE.md: "통과한 assertion이 정말로 노리는 취약점을 때리는지 되짚어라").

각 테스트는 **문제의 필드만 정상으로 되돌리면 통과한다**는 것을 함께 확인해,
거부가 그 필드 때문임을 양방향으로 못박는다.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from ai_asset_schemas import SchemaType, ValidationError, validate

_FIXTURES = Path(__file__).resolve().parent.parent.parent / "fixtures"


def _load(kind: str, name: str) -> dict:
    return json.loads(
        (_FIXTURES / kind / name / "mcp-server-manifest.json").read_text(encoding="utf-8")
    )


def _rejects(manifest: dict) -> ValidationError:
    with pytest.raises(ValidationError) as exc:
        validate(manifest, SchemaType.MCP_SERVER)
    return exc.value


@pytest.fixture
def stdio_server() -> dict:
    """입구점만 정상이면 통과하는 stdio 서버 — 아래 테스트들의 출발점."""
    manifest = _load("invalid", "mcp-server-stdio-escapes-bundle")
    manifest["transport"]["entrypoint"] = "server/main.py"
    validate(manifest, SchemaType.MCP_SERVER)  # 출발점이 실제로 유효한지 먼저 확인
    return manifest


# --- 쓰기 Tool은 사람에게 묻지 않고 실행될 수 없다 --------------------------


def test_write_tool_cannot_declare_never_confirmation() -> None:
    """D-094가 원칙 8을 완화해 WRITE를 허용했지만, 확인 없는 부수효과 호출은
    그 완화가 지키기로 한 선이다."""
    manifest = _load("invalid", "mcp-server-write-tool-without-confirmation")
    assert "'NEVER' is not one of" in "\n".join(_rejects(manifest).errors)

    for allowed in ("ON_PARAMETER", "ALWAYS"):
        fixed = copy.deepcopy(manifest)
        fixed["declared_tools"][0]["confirmation_policy"] = allowed
        validate(fixed, SchemaType.MCP_SERVER)


def test_read_only_tool_may_declare_never_confirmation(stdio_server: dict) -> None:
    """반대쪽도 함께 고정한다 — 조건이 risk_level에 실제로 걸려 있는지 확인.
    이게 없으면 위 테스트는 "NEVER가 아예 금지됨"이어도 통과한다."""
    stdio_server["declared_tools"][0]["risk_level"] = "READ_ONLY"
    stdio_server["declared_tools"][0]["confirmation_policy"] = "NEVER"
    validate(stdio_server, SchemaType.MCP_SERVER)


def test_llm_routability_is_not_declarable() -> None:
    """`llm_routable`류 필드는 의도적으로 없다 — 라우팅 가능 여부는 PEP가
    risk_level에서 유도한다. 필드가 생기면 'WRITE인데 모델이 고를 수 있음'을
    매니페스트가 표현할 수 있게 되고, D-083의 fail-closed 전제가 깨진다."""
    schema = json.loads(
        (
            _FIXTURES.parent / "packages" / "schemas" / "manifests" / "mcp-server-manifest.schema.json"
        ).read_text(encoding="utf-8")
    )
    tool_props = schema["properties"]["declared_tools"]["items"]["properties"]
    assert "llm_routable" not in tool_props
    assert "auto_invoke" not in tool_props


# --- stdio 입구점은 Bundle 밖으로 나갈 수 없다 -------------------------------


@pytest.mark.parametrize(
    "entrypoint",
    [
        "/etc/passwd",  # 절대 경로
        "../../../../etc/passwd",  # 선행 상위 탐색
        "sub/../ok.py",  # 중간 상위 탐색
        "a/../../b",  # 경계를 실제로 벗어나는 형태
        "C:\\win\\x.py",  # 드라이브 문자 + 역슬래시
        "server\\main.py",  # 역슬래시만
        "..",  # 상위 그 자체
    ],
)
def test_stdio_entrypoint_must_stay_inside_the_bundle(
    stdio_server: dict, entrypoint: str
) -> None:
    stdio_server["transport"]["entrypoint"] = entrypoint
    _rejects(stdio_server)


def test_stdio_entrypoint_accepts_a_plain_relative_path(stdio_server: dict) -> None:
    for ok in ("server/main.py", "dist/index.js", "main.py"):
        stdio_server["transport"]["entrypoint"] = ok
        validate(stdio_server, SchemaType.MCP_SERVER)


# --- 런타임 패키지 설치는 표현 자체가 불가능하다 ----------------------------


@pytest.mark.parametrize("smuggled", ["command", "shell", "install", "package", "registry_url"])
def test_transport_cannot_carry_a_package_manager_invocation(
    stdio_server: dict, smuggled: str
) -> None:
    """`npx`/`uvx`/`pip install`은 금지 목록으로 막는 게 아니라, 명령줄을
    담을 필드가 아예 없어서 표현이 불가능하다(additionalProperties: false).
    금지 목록이었다면 `npx.cmd`나 래퍼 스크립트로 우회된다."""
    stdio_server["transport"][smuggled] = "npx -y @scope/server"
    _rejects(stdio_server)


def test_stdio_must_vendor_its_dependencies(stdio_server: dict) -> None:
    stdio_server["transport"]["vendored_dependencies"] = False
    assert "True was expected" in "\n".join(_rejects(stdio_server).errors)


def test_http_transport_does_not_require_vendoring() -> None:
    """HTTP는 실행하는 코드가 없으므로 vendoring 조건이 걸리지 않아야 한다 —
    조건이 transport.kind에 제대로 걸려 있는지 확인."""
    manifest = _load("valid", "mcp-server-office-connector")
    assert manifest["transport"]["kind"] == "HTTP"
    assert "vendored_dependencies" not in manifest["transport"]
    validate(manifest, SchemaType.MCP_SERVER)


# --- 인가는 서버가 아니라 사람이 부여한다 ------------------------------------


def test_every_declared_tool_must_carry_permissions() -> None:
    """MCP 프로토콜에는 인가 모델이 없다. 그래서 `tools/list`가 준 이름만으로는
    Tool을 등록할 수 없고, 검토자가 Role/Org를 반드시 지정해야 한다."""
    manifest = _load("valid", "mcp-server-thirdparty-filesystem")
    del manifest["declared_tools"][0]["permissions"]
    assert "permissions" in "\n".join(_rejects(manifest).errors)


def test_declared_tools_cannot_be_empty() -> None:
    """Tool이 하나도 없는 서버를 승인하는 것은 빈 승인이다 — 나중에 서버가
    Tool을 추가하면 아무도 검토하지 않은 것이 실행 가능해진다."""
    manifest = _load("valid", "mcp-server-office-connector")
    manifest["declared_tools"] = []
    _rejects(manifest)


def test_tool_name_stays_identifier_shaped() -> None:
    """이 값은 감사 키와 경로 조각으로 흘러간다 — 기존 mcp_tool 매니페스트가
    지키던 제약(D-049)을 서버 단위 계약에서도 그대로 유지한다."""
    manifest = _load("valid", "mcp-server-office-connector")
    for bad in ("../../etc/passwd", "a/b", "1leading_digit", ".leading_dot", "has space"):
        broken = copy.deepcopy(manifest)
        broken["declared_tools"][0]["tool_name"] = bad
        _rejects(broken)
