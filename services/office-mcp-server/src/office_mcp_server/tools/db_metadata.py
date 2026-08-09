"""`db_metadata.get_tables` / `db_metadata.get_columns` — 05-mcp-security-governance.md §5.1/§5.2.

Both handlers validate `schema`/`table` against the connector's allowlists
*before* ever calling `execute_named_query` — identifiers are resolved from a
closed set, never passed through as free-form strings (§5.3's identifier
rule applies here too, even though §5.1/§5.2 don't spell it out as
explicitly as §5.3 does).
"""

from __future__ import annotations

from pydantic import BaseModel, Field, ValidationError

from office_mcp_server.connector import ALLOWED_SCHEMAS, ALLOWED_TABLES, Connector, QueryId
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.request_context import RequestContext


class GetTablesInput(BaseModel):
    model_config = {"extra": "forbid"}

    schema_name: str = Field(alias="schema", min_length=1, max_length=64)
    name_contains: str | None = Field(default=None, max_length=64)
    limit: int = Field(default=50, ge=1, le=100)


class GetColumnsInput(BaseModel):
    model_config = {"extra": "forbid"}

    schema_name: str = Field(alias="schema", min_length=1, max_length=64)
    table: str = Field(min_length=1, max_length=128)


def _invalid(message: str, details: dict | None = None) -> McpError:
    return McpError(ErrorCode.MCP_INPUT_INVALID, message, details=details)


def _parse(model: type[BaseModel], raw: dict) -> BaseModel:
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        raise _invalid(
            "입력 값이 올바르지 않습니다.",
            details={"fields": sorted({str(e["loc"][0]) for e in exc.errors() if e["loc"]})},
        ) from exc


def _check_schema_allowlist(schema_name: str) -> None:
    if schema_name not in ALLOWED_SCHEMAS:
        raise _invalid("허용되지 않은 Schema입니다.")


def _check_table_allowlist(schema_name: str, table: str) -> None:
    _check_schema_allowlist(schema_name)
    if table not in ALLOWED_TABLES.get(schema_name, frozenset()):
        raise _invalid("허용되지 않은 Table입니다.")


def validate_tables_input(raw_input: dict) -> GetTablesInput:
    parsed = _parse(GetTablesInput, raw_input)
    assert isinstance(parsed, GetTablesInput)
    _check_schema_allowlist(parsed.schema_name)
    return parsed


def validate_columns_input(raw_input: dict) -> GetColumnsInput:
    parsed = _parse(GetColumnsInput, raw_input)
    assert isinstance(parsed, GetColumnsInput)
    _check_table_allowlist(parsed.schema_name, parsed.table)
    return parsed


async def get_tables(
    connector: Connector, raw_input: dict, context: RequestContext
) -> dict:
    parsed = validate_tables_input(raw_input)

    rows = await connector.execute_named_query(
        QueryId.GET_TABLES,
        {
            "schema": parsed.schema_name,
            "name_contains": parsed.name_contains,
            "limit": parsed.limit,
        },
        context,
    )
    return {"items": rows, "truncated": False}


async def get_columns(
    connector: Connector, raw_input: dict, context: RequestContext
) -> dict:
    parsed = validate_columns_input(raw_input)

    columns = await connector.execute_named_query(
        QueryId.GET_COLUMNS,
        {"schema": parsed.schema_name, "table": parsed.table},
        context,
    )
    return {"columns": columns}
