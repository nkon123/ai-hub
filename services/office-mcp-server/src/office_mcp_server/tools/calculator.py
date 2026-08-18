"""Pure, read-only calculator sample used to verify Desktop MCP activation."""

from __future__ import annotations

import math

from pydantic import BaseModel, ConfigDict, StrictFloat, ValidationError

from office_mcp_server.connector import Connector
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.request_context import RequestContext


class AddInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    a: StrictFloat
    b: StrictFloat


def validate_input(raw_input: dict) -> AddInput:
    try:
        parsed = AddInput.model_validate(raw_input)
    except ValidationError as exc:
        raise McpError(
            ErrorCode.MCP_INPUT_INVALID,
            "a와 b에는 숫자만 입력할 수 있습니다.",
            details={"fields": sorted({str(error["loc"][0]) for error in exc.errors()})},
        ) from exc

    if not math.isfinite(parsed.a) or not math.isfinite(parsed.b):
        raise McpError(ErrorCode.MCP_INPUT_INVALID, "유한한 숫자만 입력할 수 있습니다.")
    result = parsed.a + parsed.b
    if not math.isfinite(result):
        raise McpError(ErrorCode.MCP_INPUT_INVALID, "계산 결과가 허용 범위를 벗어났습니다.")
    return parsed


async def add(_connector: Connector, raw_input: dict, _context: RequestContext) -> dict:
    parsed = validate_input(raw_input)
    return {"result": parsed.a + parsed.b}
