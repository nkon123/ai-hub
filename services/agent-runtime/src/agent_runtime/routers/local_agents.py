"""D-034 해석 경로 4 — /local/v1/local-agents*: registers a Desktop-installed
Agent Package (agent + paired prompt) so a Local Runtime `/local/v1/runs`
call can reference it by `input.local_agent_id`.

See `agent_runtime.local_agent_registry` module docstring for the full
design (path assembly, trust boundary, why this is one step stricter than
D-079). This router is the thin HTTP surface over that module — same split
`routers/mcp_tools.py` keeps over `mcp_tool_registry.py` (D-080) and
search-runtime's `main.py` keeps over `local_index_registry.py` (D-079).

Deliberately mounted under `/local/v1` only (see `main.py`) — never under
`/chat-api/v1`. `routers/chat.py` does not import this module.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from observability import bind_trace_id
from pydantic import BaseModel

from agent_runtime.local_agent_registry import LocalAgentRegistrationError, get_registry

router = APIRouter()


class RegisterLocalAgentRequest(BaseModel):
    """`packages/schemas/api/local-agent-registration.schema.json`
    RegisterLocalAgentRequest. Field names mirror that contract exactly —
    in particular there is deliberately no path/filename field anywhere on
    this model (root CLAUDE.md 코드 규칙: 사용자가 제공한 파일명으로 파일
    경로를 만들지 않는다)."""

    agent_asset_id: str
    agent_version: str
    prompt_asset_id: str
    prompt_version: str
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


@router.post("/local-agents")
async def register_local_agent(req: RegisterLocalAgentRequest) -> JSONResponse:
    trace_id = req.trace_id or str(uuid.uuid4())
    bind_trace_id(trace_id)
    try:
        entry = get_registry().register(
            agent_asset_id=req.agent_asset_id,
            agent_version=req.agent_version,
            prompt_asset_id=req.prompt_asset_id,
            prompt_version=req.prompt_version,
            label=req.label,
        )
    except LocalAgentRegistrationError as exc:
        # Every refusal is a named reason — Desktop shows it verbatim next
        # to the asset, so "설치됨" never quietly implies "실행 가능" (same
        # property D-079/D-080 established for Knowledge/MCP Tool
        # activation).
        return _error_envelope(
            _STATUS_BY_CODE.get(exc.code, 400), exc.code, exc.message, trace_id, exc.details
        )
    return JSONResponse({"entry": entry.to_dict(), "trace_id": trace_id})


@router.get("/local-agents")
async def list_local_agents() -> JSONResponse:
    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)
    registry = get_registry()
    return JSONResponse({
        "entries": [e.to_dict() for e in registry.list_entries()],
        "local_agents_enabled": registry.enabled,
        "trace_id": trace_id,
    })


@router.delete("/local-agents/{agent_asset_id}")
async def deregister_local_agent(agent_asset_id: str) -> JSONResponse:
    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)
    removed = get_registry().unregister(agent_asset_id)
    # 200 with removed=false rather than 404 — same reasoning as D-079/D-080:
    # deregistration on asset uninstall must be safe to call unconditionally.
    return JSONResponse({
        "agent_asset_id": agent_asset_id,
        "removed": removed,
        "trace_id": trace_id,
    })
