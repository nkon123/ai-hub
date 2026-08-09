"""`table_count.query` — 05-mcp-security-governance.md §5.3, the
security-critical tool.

Rules enforced here, all by allowlist membership (never by
blocklisting/escaping a string):

- Schema/Table/Field/Operator must each be a member of a closed allowlist.
- Identifiers (schema/table/field) are never bindable parameters — they are
  *resolved* from the allowlist (the allowlist string itself is what gets
  used downstream, not the caller's copy of it) before being handed to the
  connector.
- Only `value` is treated as data — a prepared-parameter equivalent. In this
  Mock, "prepared parameter" means a plain Python equality/inequality check
  against an in-memory row; no string concatenation or `eval`/`exec` ever
  touches `value`, so injection payloads in `value` (`' OR '1'='1`, `;
  DROP TABLE ...`, `--`, etc.) are inert by construction — they are compared
  as opaque data, never interpreted as syntax.
- Filter count and result are bounded (§5.3 "Filter 개수와 Query Timeout
  제한", "결과는 Count만 반환").
"""

from __future__ import annotations

from pydantic import BaseModel, Field, ValidationError

from office_mcp_server.connector import (
    ALLOWED_FILTER_FIELDS,
    ALLOWED_OPERATORS,
    ALLOWED_SCHEMAS,
    ALLOWED_TABLES,
    MAX_FILTERS,
    Connector,
    QueryId,
)
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.request_context import RequestContext

FilterValue = str | int | float | bool


class FilterInput(BaseModel):
    model_config = {"extra": "forbid"}

    field: str = Field(min_length=1, max_length=64)
    operator: str = Field(min_length=1, max_length=16)
    value: FilterValue


class TableCountInput(BaseModel):
    model_config = {"extra": "forbid"}

    schema_name: str = Field(alias="schema", min_length=1, max_length=64)
    table: str = Field(min_length=1, max_length=128)
    filters: list[FilterInput] = Field(default_factory=list, max_length=MAX_FILTERS)


def _invalid(message: str, details: dict | None = None) -> McpError:
    return McpError(ErrorCode.MCP_INPUT_INVALID, message, details=details)


def _parse(raw: dict) -> TableCountInput:
    try:
        return TableCountInput.model_validate(raw)
    except ValidationError as exc:
        raise _invalid(
            "입력 값이 올바르지 않습니다.",
            details={"fields": sorted({str(e["loc"][0]) for e in exc.errors() if e["loc"]})},
        ) from exc


def requires_confirmation(raw_input: dict) -> bool:
    """§8.4 ON_PARAMETER: an unfiltered (whole-table) count is treated as a
    broader disclosure than a filtered one, so it requires prior user
    confirmation. Filtered counts do not."""
    filters = raw_input.get("filters") if isinstance(raw_input, dict) else None
    return not filters


def validate_input(raw_input: dict) -> tuple[TableCountInput, list[dict]]:
    """Structural + allowlist validation, split out from `query()` so the
    pipeline can run it *before* the §8.4 confirmation gate — a malformed or
    disallowed table/field must fail as `MCP_INPUT_INVALID`, not get masked
    behind a "please confirm" response for a call that would fail anyway."""
    parsed = _parse(raw_input)

    if parsed.schema_name not in ALLOWED_SCHEMAS:
        raise _invalid("허용되지 않은 Schema입니다.")
    if parsed.table not in ALLOWED_TABLES.get(parsed.schema_name, frozenset()):
        raise _invalid("허용되지 않은 Table입니다.")

    allowed_fields = ALLOWED_FILTER_FIELDS.get(parsed.table, frozenset())
    resolved_filters: list[dict] = []
    for f in parsed.filters:
        if f.field not in allowed_fields:
            raise _invalid("허용되지 않은 Filter Field입니다.")
        if f.operator not in ALLOWED_OPERATORS:
            raise _invalid("허용되지 않은 Filter Operator입니다.")
        # Resolve the identifier from the allowlist itself (not the
        # caller's copy) and keep `value` as opaque data — this is the
        # "identifier vs prepared parameter" split from §5.3.
        resolved_field = next(x for x in allowed_fields if x == f.field)
        resolved_filters.append({"field": resolved_field, "operator": f.operator, "value": f.value})

    return parsed, resolved_filters


async def query(connector: Connector, raw_input: dict, context: RequestContext) -> dict:
    parsed, resolved_filters = validate_input(raw_input)

    count = await connector.execute_named_query(
        QueryId.COUNT_WITH_FILTERS,
        {"schema": parsed.schema_name, "table": parsed.table, "filters": resolved_filters},
        context,
    )
    return {"count": count}
