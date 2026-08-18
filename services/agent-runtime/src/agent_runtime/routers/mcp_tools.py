"""D-080 — /local/v1/mcp-tools*: turns an installed MCP Tool asset's
contract into one `agent_runtime.mcp_tools.validate_tool_input` recognizes.

See `agent_runtime.mcp_tool_registry` module docstring for the full safety
design (why registration can never widen what the Office Profile already
permits). This router is the thin HTTP surface over that module — same
split search-runtime's `main.py` keeps for its D-079 `/search/v1/local-indexes*`
endpoints versus `local_index_registry.py`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from observability import bind_trace_id
from pydantic import BaseModel

from agent_runtime.mcp_tool_registry import MCPToolRegistrationError, get_registry

router = APIRouter()


class RegisterMCPToolRequest(BaseModel):
    """`packages/schemas/api/mcp-tool-registration.schema.json`
    RegisterMcpToolRequest. Field names mirror that contract exactly — in
    particular there is deliberately no `endpoint`/URL field anywhere on
    this model (구현 원칙 7)."""

    tool_name: str
    server_alias: str
    input_schema: dict
    confirmation_policy: str
    risk_level: str
    label: str | None = None
    trace_id: str | None = None


def _error_envelope(
    status_code: int, code: str, message: str, trace_id: str, details: dict
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {"code": code, "message": message, "trace_id": trace_id, "details": details}
        },
    )


_STATUS_BY_CODE = {"VALIDATION_ERROR": 400, "PERMISSION_DENIED": 403}


@router.post("/mcp-tools")
async def register_mcp_tool(req: RegisterMCPToolRequest) -> JSONResponse:
    trace_id = req.trace_id or str(uuid.uuid4())
    bind_trace_id(trace_id)
    try:
        entry = get_registry().register(
            tool_name=req.tool_name,
            server_alias=req.server_alias,
            input_schema=req.input_schema,
            confirmation_policy=req.confirmation_policy,
            risk_level=req.risk_level,
            label=req.label,
        )
    except MCPToolRegistrationError as exc:
        # Every refusal is a named reason — Desktop shows it verbatim next
        # to the asset, so "설치됨" never quietly implies "호출 가능"
        # (same property D-079 established for Knowledge activation).
        return _error_envelope(
            _STATUS_BY_CODE.get(exc.code, 400), exc.code, exc.message, trace_id, exc.details
        )
    return JSONResponse({"entry": entry.to_dict(), "trace_id": trace_id})


@router.get("/mcp-tools")
async def list_mcp_tools() -> JSONResponse:
    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)
    registry = get_registry()
    return JSONResponse({
        "entries": [e.to_dict() for e in registry.list_entries()],
        "mcp_tool_registration_enabled": registry.enabled,
        "trace_id": trace_id,
    })


@router.delete("/mcp-tools/{tool_name}")
async def deregister_mcp_tool(tool_name: str) -> JSONResponse:
    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)
    removed = get_registry().unregister(tool_name)
    # 200 with removed=false rather than 404 — same reasoning as D-079's
    # DELETE /search/v1/local-indexes/{knowledge_id}: uninstall-time
    # deregistration must be safe to call unconditionally.
    return JSONResponse({"tool_name": tool_name, "removed": removed, "trace_id": trace_id})
