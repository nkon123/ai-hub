"""Registers the reviewed PoC tools — 05-mcp-security-governance.md §5 — with
their full §4 metadata. `allowed_roles` draws from the platform's single
central Role enum (`security_policy.roles.Role`, M11) rather than inventing
new role strings here (CLAUDE.md "Enum과 오류코드는 중앙 정의를 사용한다").
"""

from __future__ import annotations

from security_policy.roles import Role

from office_mcp_server.connector import MAX_FILTERS
from office_mcp_server.tool_registry import RegisteredTool, ToolRegistry, UserConfirmationPolicy

SERVER_ALIAS = "oracle-connector"
_ALLOWED_ROLES = (
    Role.USER.value,
    Role.CREATOR.value,
    Role.TECH_REVIEWER.value,
    Role.ADMIN.value,
)
_ALLOWED_ORGS = ("miracom",)


def register_poc_tools(registry: ToolRegistry) -> None:
    registry.register(
        RegisteredTool(
            name="calculator.add",
            version="1.0.0",
            server_alias=SERVER_ALIAS,
            description="두 숫자를 더해 결과를 반환합니다 (읽기 전용 샘플).",
            input_schema={
                "type": "object",
                "required": ["a", "b"],
                "additionalProperties": False,
                "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            },
            output_schema={
                "type": "object",
                "required": ["result"],
                "additionalProperties": False,
                "properties": {"result": {"type": "number"}},
            },
            allowed_roles=_ALLOWED_ROLES,
            allowed_orgs=_ALLOWED_ORGS,
            timeout_seconds=5,
            max_rows=1,
            max_bytes=1024,
            max_field_length=50,
            rate_limit_per_minute=30,
            user_confirmation_policy=UserConfirmationPolicy.NEVER,
            classification="PUBLIC_INTERNAL",
            owner="platform-team@miracom.com",
        )
    )

    registry.register(
        RegisteredTool(
            name="db_metadata.get_tables",
            version="1.0.0",
            server_alias=SERVER_ALIAS,
            description="허용된 Schema의 Table 목록을 조회합니다 (읽기 전용).",
            input_schema={
                "type": "object",
                "required": ["schema"],
                "additionalProperties": False,
                "properties": {
                    "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                    "name_contains": {"type": "string", "maxLength": 64},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                },
            },
            output_schema={
                "type": "object",
                "required": ["items", "truncated"],
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "schema": {"type": "string"},
                                "table": {"type": "string"},
                                "comment": {"type": "string"},
                            },
                        },
                    },
                    "truncated": {"type": "boolean"},
                },
            },
            allowed_roles=_ALLOWED_ROLES,
            allowed_orgs=_ALLOWED_ORGS,
            timeout_seconds=10,
            max_rows=100,
            max_bytes=65536,
            max_field_length=500,
            rate_limit_per_minute=30,
            user_confirmation_policy=UserConfirmationPolicy.NEVER,
            classification="INTERNAL",
            owner="platform-team@miracom.com",
        )
    )

    registry.register(
        RegisteredTool(
            name="db_metadata.get_columns",
            version="1.0.0",
            server_alias=SERVER_ALIAS,
            description="허용된 Table의 Column 메타데이터 조회 (읽기 전용, Default Value 미반환).",
            input_schema={
                "type": "object",
                "required": ["schema", "table"],
                "additionalProperties": False,
                "properties": {
                    "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                    "table": {"type": "string", "minLength": 1, "maxLength": 128},
                },
            },
            output_schema={
                "type": "object",
                "required": ["columns"],
                "properties": {
                    "columns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "data_type": {"type": "string"},
                                "nullable": {"type": "boolean"},
                                "is_primary_key": {"type": "boolean"},
                                "comment": {"type": "string"},
                            },
                        },
                    }
                },
            },
            allowed_roles=_ALLOWED_ROLES,
            allowed_orgs=_ALLOWED_ORGS,
            timeout_seconds=10,
            max_rows=100,
            max_bytes=65536,
            max_field_length=500,
            rate_limit_per_minute=30,
            user_confirmation_policy=UserConfirmationPolicy.NEVER,
            classification="INTERNAL",
            owner="platform-team@miracom.com",
        )
    )

    registry.register(
        RegisteredTool(
            name="table_count.query",
            version="1.0.0",
            server_alias=SERVER_ALIAS,
            description="허용된 Table/Field/Operator로 건수만 조회 (읽기 전용, 임의 SQL 미입력).",
            input_schema={
                "type": "object",
                "required": ["schema", "table"],
                "additionalProperties": False,
                "properties": {
                    "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                    "table": {"type": "string", "minLength": 1, "maxLength": 128},
                    "filters": {
                        "type": "array",
                        "maxItems": MAX_FILTERS,
                        "items": {
                            "type": "object",
                            "required": ["field", "operator", "value"],
                            "additionalProperties": False,
                            "properties": {
                                "field": {"type": "string", "maxLength": 64},
                                "operator": {"type": "string", "enum": ["eq", "neq"]},
                                "value": {"type": ["string", "number", "boolean"]},
                            },
                        },
                    },
                },
            },
            output_schema={
                "type": "object",
                "required": ["count"],
                "properties": {"count": {"type": "integer", "minimum": 0}},
            },
            allowed_roles=_ALLOWED_ROLES,
            allowed_orgs=_ALLOWED_ORGS,
            timeout_seconds=10,
            max_rows=1,
            max_bytes=1024,
            max_field_length=50,
            rate_limit_per_minute=30,
            user_confirmation_policy=UserConfirmationPolicy.ON_PARAMETER,
            classification="INTERNAL",
            owner="platform-team@miracom.com",
        )
    )
