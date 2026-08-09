"""Output Filter — 05-mcp-security-governance.md §9.

Applied to every successful tool result, in order:

1. 금지 Column 제거 — strip any column in `FORBIDDEN_COLUMNS` from a
   `db_metadata.get_columns` result. This duplicates the filtering
   `MockOracleConnector._get_columns` already does — deliberately: §2's
   pipeline puts Output Filter as its own layer *after* the Connector, so a
   future connector that forgets to filter is still caught here.
2. 개인정보 Pattern Masking — regex-mask email/phone-shaped substrings
   anywhere a free-text field (e.g. a DB comment) might carry one, since
   PoC's mock data models a comment containing a contact email
   (`REQUESTER_EMAIL`'s column comment) to prove this path is exercised.
3. 최대 크기 적용 — re-applies the same row/byte/field-length caps as
   `execution.apply_result_limits`, in case masking or column-stripping
   changed sizes (in practice masking only ever shrinks — replacement
   tokens are shorter than the patterns they replace).
4. Classification Label 추가 — every response carries the tool's
   `classification`.
5. 출력 Schema 재검증 — the *business* shape (before the classification/
   truncation wrapper fields are added) must validate against the tool's
   own `output_schema`. A failure here means a Tool Handler bug, not user
   input — it is reported as `INTERNAL_ERROR` without echoing the raw
   jsonschema error text (which could otherwise quote live data values).

"Masking 전 원본 결과를 일반 로그에 기록하지 않는다" (§9) is enforced by
convention: nothing in this module or `audit.py` logs `output`/`raw_output`
before (or after) this function returns.
"""

from __future__ import annotations

import re

from jsonschema import Draft202012Validator

from office_mcp_server.connector import FORBIDDEN_COLUMNS
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.execution import apply_result_limits
from office_mcp_server.tool_registry import RegisteredTool

_EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_KR_PHONE_PATTERN = re.compile(r"01[016789]-?\d{3,4}-?\d{4}")


def _mask_pii(value: str) -> str:
    value = _EMAIL_PATTERN.sub("[MASKED_EMAIL]", value)
    value = _KR_PHONE_PATTERN.sub("[MASKED_PHONE]", value)
    return value


def _mask_pii_deep(value: object) -> object:
    if isinstance(value, str):
        return _mask_pii(value)
    if isinstance(value, list):
        return [_mask_pii_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: _mask_pii_deep(v) for k, v in value.items()}
    return value


def _strip_forbidden_columns(table: str | None, output: dict) -> dict:
    if table is None or "columns" not in output:
        return output
    forbidden = FORBIDDEN_COLUMNS.get(table, frozenset())
    if not forbidden:
        return output
    output = dict(output)
    output["columns"] = [c for c in output["columns"] if c.get("name") not in forbidden]
    return output


def _revalidate_output_schema(tool: RegisteredTool, business_output: dict) -> None:
    if not tool.output_schema:
        return
    validator = Draft202012Validator(tool.output_schema)
    errors = list(validator.iter_errors(business_output))
    if errors:
        raise McpError(
            ErrorCode.INTERNAL_ERROR,
            "Tool 결과가 예상된 형식과 일치하지 않아 반환할 수 없습니다.",
        )


def apply_output_filter(
    tool: RegisteredTool, raw_output: dict, *, table: str | None = None
) -> tuple[dict, bool]:
    """Returns (final_output, truncated). `table` is passed only by
    db_metadata.get_columns so forbidden-column stripping knows which
    table's allowlist to use."""
    output = _strip_forbidden_columns(table, raw_output)

    limited_output, truncated = apply_result_limits(tool, output)
    # `db_metadata.get_tables` carries its own `truncated` field in the
    # business output shape (§5.1) — reconcile it with the row/byte/field
    # limiter's finding rather than leaving two disagreeing booleans.
    if isinstance(limited_output.get("truncated"), bool):
        limited_output["truncated"] = limited_output["truncated"] or truncated

    masked_output = _mask_pii_deep(limited_output)
    assert isinstance(masked_output, dict)

    _revalidate_output_schema(tool, masked_output)

    final_output = {**masked_output, "classification": tool.classification}
    return final_output, truncated
