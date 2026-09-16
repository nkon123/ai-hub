"""D-094 MCP Server 등록 계약 — 계약이 **갖지 않아야** 하는 것들.

이 파일의 대부분은 필드가 있는지가 아니라 **없는지**를 검사한다. D-094가
막으려는 것들은 하나같이 "그런 필드가 있으면 언젠가 채워진다" 형태의
위험이라, 존재 자체를 금지하는 것이 유일하게 무너지지 않는 방법이기
때문이다. 값 검사로 막으면 검사를 우회하는 값이 나오지만, 필드가 없으면
우회할 대상이 없다.

계약 문서(schema 의 description)와 실제 구조가 갈라지는 것도 함께 막는다 —
이 저장소에서 손으로 복사한 계약이 드리프트한 전례가 있다(MCP_TOOL_SPECS).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parent.parent.parent
_SCHEMA_PATH = _ROOT / "packages" / "schemas" / "api" / "mcp-server-registration.schema.json"
_OPENAPI_PATH = _ROOT / "packages" / "schemas" / "api" / "local-runtime-api.yaml"


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def openapi() -> dict:
    return yaml.safe_load(_OPENAPI_PATH.read_text(encoding="utf-8"))


def _defs(schema: dict, name: str) -> dict:
    return schema["definitions"][name]


# --- 등록 요청은 실행 대상을 지정할 수 없다 ---------------------------------


@pytest.mark.parametrize(
    "forbidden",
    [
        "endpoint",
        "server_url",
        "url",
        "command",
        "args",
        "argv",
        "shell",
        "interpreter_path",
        "python_path",
        "node_path",
        "env",
        "environment",
        "cwd",
    ],
)
def test_register_request_cannot_name_what_to_run(schema: dict, forbidden: str) -> None:
    """D-080이 세운 성질을 서버 단위 계약에서도 유지한다: 네트워크 목적지도,
    실행할 명령도 등록 페이로드에서 오지 않는다. HTTP endpoint 와 stdio
    entrypoint 는 **승인된 매니페스트**에서만, 인터프리터 절대경로는 **배포
    설정**에서만 온다(PATH 탐색 금지 — D-084)."""
    props = _defs(schema, "RegisterMcpServerRequest")["properties"]
    assert forbidden not in props


def test_register_request_is_closed(schema: dict) -> None:
    """additionalProperties: false 가 없으면 위 테스트 전체가 무의미하다 —
    금지한 이름을 안 쓰고 다른 이름으로 같은 것을 보내면 그만이다."""
    assert _defs(schema, "RegisterMcpServerRequest")["additionalProperties"] is False


def test_source_is_a_closed_enum(schema: dict) -> None:
    """모르는 출처를 '분류되지 않음'으로 받아들이지 않는다."""
    source = _defs(schema, "RegisterMcpServerRequest")["properties"]["source"]
    assert source["enum"] == ["DESKTOP_OFFLINE_BUNDLE"]


# --- 쓰기 Tool 은 모델이 고를 수 없다 ---------------------------------------


def test_llm_routable_is_a_decision_output_not_an_input(schema: dict) -> None:
    """`llm_routable` 은 PEP 가 내는 **결정 결과**에는 있고, 매니페스트나 등록
    요청에는 없어야 한다. 입력에 있으면 'WRITE 인데 자동 선택 가능'을 누군가
    설정할 수 있게 되고, D-083 의 fail-closed 전제가 거기서 끝난다."""
    decision = _defs(schema, "MCPToolDispatchDecision")
    assert "llm_routable" in decision["properties"]
    assert "llm_routable" in decision["required"]

    assert "llm_routable" not in _defs(schema, "RegisterMcpServerRequest")["properties"]

    manifest_schema = json.loads(
        (_ROOT / "packages" / "schemas" / "manifests" / "mcp-server-manifest.schema.json").read_text(
            encoding="utf-8"
        )
    )
    tool_props = manifest_schema["properties"]["declared_tools"]["items"]["properties"]
    assert "llm_routable" not in tool_props


def test_dispatch_decision_records_ai_derived_arguments(schema: dict) -> None:
    """D-083: 모델이 만든 인자라는 사실은 결정을 바꾸지 않지만 확인 문구를
    바꾼다 — 사용자가 승인하는 값이 누가 쓴 것인지 알아야 한다."""
    props = _defs(schema, "MCPToolDispatchDecision")["properties"]
    assert props["ai_derived_arguments"]["default"] is False


# --- 거부 사유는 이름이 있고, 서로 뭉개지지 않는다 --------------------------


def test_denial_reasons_are_named_and_distinct(schema: dict) -> None:
    """§7 Default Deny 를 이름 있는 값으로 남긴다. 감사에는 어느 차원에서
    막혔는지 정확히 남기되, 사용자 메시지는 그것을 밝히지 않는다(§7/§12.1:
    거부가 정책을 누설하면 안 된다) — 후자는 구현이 지킬 일이고, 여기서는
    구분 자체가 계약에 존재하는지를 고정한다."""
    reasons = _defs(schema, "MCPToolDispatchDecision")["properties"]["denial_reason"]["enum"]
    for expected in (
        "role_not_permitted",
        "org_not_permitted",
        "site_not_permitted",
        "classification_above_clearance",
        "tool_suspended",
        "rate_limited",
    ):
        assert expected in reasons
    assert None in reasons, "허용된 경우를 표현할 수 있어야 한다"


def test_failed_and_unreachable_stay_separate(schema: dict) -> None:
    """D-079 에서 배운 것: 재시도로 풀리는 상태와 안 풀리는 상태를 한 값으로
    뭉개면, 사용자에게 반드시 실패하는 행동을 안내하게 된다."""
    states = _defs(schema, "MCPServerState")["enum"]
    assert {"ACTIVE", "FAILED", "UNREACHABLE"} == set(states)


def test_list_response_separates_disabled_from_empty(schema: dict) -> None:
    """'아직 등록된 게 없다'와 '이 배포에서는 아예 불가능하다'는 다른
    사실이다. 후자를 알려면 등록을 시도해 오류를 읽어야 한다면, UI 는 반드시
    실패할 행동을 사용자에게 시키게 된다."""
    required = _defs(schema, "ListMcpServersResponse")["required"]
    assert "mcp_server_registration_enabled" in required
    assert "stdio_supported" in required


# --- 승인된 Tool 집합을 넘어설 수 없다 --------------------------------------


def test_registered_tools_are_an_intersection_not_a_union(schema: dict) -> None:
    """서버가 제공하지만 아무도 검토하지 않은 Tool 이 호출 가능해지면 안 된다.
    계약 문구가 교집합임을 명시하는지 고정한다 — 구현이 union 으로 바뀌면
    이 문구부터 고쳐야 하고, 그때 리뷰어가 본다. 표현을 통째로 박으면 사소한
    재서술에도 깨지므로 두 단어의 존재만 본다(의도는 고정, 문장은 자유)."""
    desc = _defs(schema, "MCPServerRegistrationEntry")["properties"]["tool_names"]["description"]
    lowered = desc.lower()
    assert "intersection" in lowered
    assert "union" in lowered


def test_snapshot_mismatch_is_refused_not_warned(schema: dict) -> None:
    """D-094 미결 항목 (b) 를 fail-closed 로 확정한 지점. 프로토콜상 서버가
    Tool 목록을 바꾸는 것은 합법이지만, 승인은 특정 Tool 집합에 대한 것이므로
    조용히 새 집합을 받아들이면 검토가 무의미해진다."""
    desc = _defs(schema, "RegisterMcpServerResponse")["description"]
    assert "tools_snapshot_mismatch" in desc
    assert "409" in desc


# --- OpenAPI 와 갈라지지 않는다 ---------------------------------------------


def test_openapi_exposes_the_three_endpoints(openapi: dict) -> None:
    paths = openapi["paths"]
    assert "post" in paths["/local/v1/mcp-servers"]
    assert "get" in paths["/local/v1/mcp-servers"]
    assert "delete" in paths["/local/v1/mcp-servers/{server_alias}"]


def test_openapi_register_request_matches_the_schema_file(openapi: dict, schema: dict) -> None:
    """두 곳에 같은 계약을 적어 둔 이상 갈라질 수 있다 — 이 저장소는 손으로
    복사한 계약이 드리프트한 전례가 있다(MCP_TOOL_SPECS)."""
    openapi_props = set(openapi["components"]["schemas"]["RegisterMcpServerRequest"]["properties"])
    schema_props = set(_defs(schema, "RegisterMcpServerRequest")["properties"])
    assert openapi_props == schema_props


def test_python_reason_enum_matches_the_contract(schema: dict) -> None:
    """`MCPRegistrationReason` 은 계약 문서의 reason 목록을 손으로 옮긴 것이다 —
    이 저장소는 그런 손복사가 실제로 드리프트한 전례가 있다
    (`mcp_tools.MCP_TOOL_SPECS`). 양방향으로 고정한다: 코드에만 있는 사유는
    계약에 없는 것을 사용자에게 내보내는 것이고, 계약에만 있는 사유는 아무도
    구현하지 않은 약속이다."""
    import sys

    sys.path.insert(0, str(_ROOT / "services" / "agent-runtime" / "src"))
    from agent_runtime.mcp_client import MCPRegistrationReason

    in_code = {r.value for r in MCPRegistrationReason}
    in_contract = set(_defs(schema, "MCPRegistrationRefusalReason")["enum"])

    assert in_code - in_contract == set(), "계약에 없는 사유를 코드가 만든다"
    assert in_contract - in_code == set(), "구현되지 않은 사유가 계약에 있다"


def test_every_refusal_reason_is_explained_in_prose(schema: dict) -> None:
    """열거는 값만 고정한다. 각 사유가 **무슨 뜻이고 사용자가 뭘 해야 하는지**는
    응답 설명에 있어야 한다 — 이름만 있고 설명이 없으면 구현자가 제각각
    해석한다."""
    desc = _defs(schema, "RegisterMcpServerResponse")["description"]
    undocumented = [
        reason
        for reason in _defs(schema, "MCPRegistrationRefusalReason")["enum"]
        if f"`{reason}`" not in desc
    ]
    assert undocumented == []


def test_openapi_documents_the_hosted_stdio_refusal(openapi: dict) -> None:
    """hosted 모드에서 stdio 를 거부하는 것은 이 설계의 핵심 경계다 — 응답
    문서에서 사라지면 구현자가 선택 사항으로 읽는다."""
    responses = openapi["paths"]["/local/v1/mcp-servers"]["post"]["responses"]
    assert "stdio_not_allowed_in_hosted_mode" in responses["403"]["description"]
