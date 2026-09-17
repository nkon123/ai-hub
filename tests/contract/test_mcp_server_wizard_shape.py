"""P05 위저드의 MCP 서버 폼이 만드는 매니페스트가 스키마를 통과하는가.

폼은 TypeScript 라 여기서 직접 실행할 수 없다. 대신 폼이 **만들어 내는 모양**을
그대로 적어 두고 검증한다 — 스키마가 바뀌었는데 폼이 따라오지 않으면 여기서
깨진다. 그러지 않으면 사용자가 5단계까지 채운 뒤 검증에서 거부당하고, 무엇을
고쳐야 하는지는 스키마 오류 메시지로만 알게 된다.

여기 적힌 모양은 `apps/portal-web/app/assets/new/[type]/page.tsx` 의
`buildManifestTemplate`(mcp_server 분기)와 `McpServerManifestFields` 가
만드는 것과 같아야 한다. **폼을 고치면 이 파일도 같이 고친다.**
"""

from __future__ import annotations

import pytest
from ai_asset_schemas.validator import SchemaType, ValidationError, validate

COMMON = {
    "schema_version": "1.0",
    "id": "8d4f1c02-6b73-4e58-91a0-3c5e7f2b9d41",
    "type": "mcp_server",
    "name": "사내 Office 커넥터",
    "version": "1.0.0",
    "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
    "classification": "INTERNAL",
}


def _http_form_output(**over) -> dict:
    """폼 기본값(HTTP) + 사용자가 두 칸을 채운 상태."""
    manifest = {
        **COMMON,
        "server_alias": "office-connector",
        "provenance": "INTERNAL",
        "protocol_version": "2025-06-18",
        "transport": {"kind": "HTTP", "endpoint": "http://127.0.0.1:8500/mcp"},
        "declared_tools": [
            {
                "tool_name": "db_metadata.get_tables",
                "risk_level": "READ_ONLY",
                "permissions": {"allowed_roles": ["CREATOR"], "allowed_orgs": ["miracom"]},
                "confirmation_policy": "NEVER",
            }
        ],
    }
    manifest.update(over)
    return manifest


def test_the_default_http_form_output_validates() -> None:
    """가장 흔한 경우 — 주소와 기능 이름만 채우고 등록."""
    validate(_http_form_output(), SchemaType.MCP_SERVER)


def test_the_stdio_form_output_validates() -> None:
    """방식을 STDIO 로 바꾸면 폼이 채우는 모양."""
    manifest = _http_form_output(
        transport={
            "kind": "STDIO",
            "interpreter": "node",
            "entrypoint": "server/dist/index.js",
            "vendored_dependencies": True,
        }
    )
    validate(manifest, SchemaType.MCP_SERVER)


def test_a_write_tool_the_form_produces_validates() -> None:
    """폼은 위험도를 WRITE 로 바꾸면 확인 정책을 ALWAYS 로 올린다. 그 결과가
    스키마를 통과해야 한다 — 통과하지 못하면 폼이 만들 수 없는 값을 만드는 것이다."""
    manifest = _http_form_output(
        declared_tools=[
            {
                "tool_name": "write_file",
                "risk_level": "WRITE",
                "permissions": {"allowed_roles": ["ADMIN"], "allowed_orgs": ["miracom"]},
                "confirmation_policy": "ALWAYS",
            }
        ]
    )
    validate(manifest, SchemaType.MCP_SERVER)


def test_a_write_tool_without_confirmation_is_still_refused() -> None:
    """폼이 확인 정책을 자동으로 올리는 이유 — 스키마가 이 조합을 거부한다.
    거부되지 않는다면 폼의 그 보정은 의미 없는 친절이 된다."""
    manifest = _http_form_output(
        declared_tools=[
            {
                "tool_name": "write_file",
                "risk_level": "WRITE",
                "permissions": {"allowed_roles": ["ADMIN"], "allowed_orgs": ["miracom"]},
                "confirmation_policy": "NEVER",
            }
        ]
    )
    with pytest.raises(ValidationError):
        validate(manifest, SchemaType.MCP_SERVER)


@pytest.mark.parametrize(
    "missing",
    ["server_alias", "provenance", "protocol_version", "transport", "declared_tools"],
)
def test_every_field_the_form_collects_is_actually_required(missing: str) -> None:
    """폼이 묻는 것과 스키마가 요구하는 것이 어긋나면, 묻지 않아도 되는 것을
    묻고 있거나 물어야 할 것을 빠뜨리고 있다는 뜻이다."""
    manifest = _http_form_output()
    manifest.pop(missing)
    with pytest.raises(ValidationError):
        validate(manifest, SchemaType.MCP_SERVER)


def test_empty_permissions_are_structurally_allowed_but_mean_deny_all() -> None:
    """폼이 "하나도 고르지 않으면 아무도 쓸 수 없습니다" 라고 경고하는 이유.

    스키마는 빈 목록을 막지 않는다(막을 수도 있지만 그러면 "일부러 아무도
    못 쓰게" 하는 선택지가 사라진다). 대신 런타임이 Default Deny 로 처리하고
    (`mcp_client.policy._authorization_denial`), 폼이 등록 전에 경고한다.
    이 테스트는 그 분업이 여전히 성립하는지 고정한다 — 스키마가 언젠가 빈
    목록을 거부하게 되면 폼의 경고는 "막힌 것을 경고"하는 중복이 된다.
    """
    manifest = _http_form_output(
        declared_tools=[
            {
                "tool_name": "x.y",
                "risk_level": "READ_ONLY",
                "permissions": {"allowed_roles": [], "allowed_orgs": []},
                "confirmation_policy": "NEVER",
            }
        ]
    )
    validate(manifest, SchemaType.MCP_SERVER)
