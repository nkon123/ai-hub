"""Run management endpoints (POST/GET/cancel/events) — /local/v1/runs*."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent_runtime.adapters import (
    AssetRegistryResolver,
    HubSearchAdapter,
    KnowledgeAdapter,
    LLMAdapter,
    MCPAdapter,
)
from agent_runtime.adapters.hub_search import HttpHubSearchAdapter
from agent_runtime.adapters.mcp import HttpMCPAdapter
from agent_runtime.adapters.ollama import OllamaLLMAdapter
from agent_runtime.adapters.registry import HttpAssetRegistryResolver
from agent_runtime.adapters.search import HttpKnowledgeAdapter
from agent_runtime.config import settings
from agent_runtime.manifests import (
    RegistryResolutionError,
    StandardKnowledgeChatConfig,
    get_db_agent_config,
    get_standard_config,
    resolve_registry_agent_config,
)
from agent_runtime.run_store import TERMINAL_STATUSES, RunRecord, run_store
from agent_runtime.workflow import run_knowledge_chat

logger = logging.getLogger(__name__)

router = APIRouter()

_TERMINAL_EVENTS = {"run.completed", "run.failed", "run.cancelled"}

# Agent selection — see agent_runtime.manifests' module docstring for the
# full D-034 resolution order. These two names are the built-in aliases that
# NEVER touch the Registry (path 1); `registry_agent_version_id`/
# `registry_prompt_version_id` on `input` select path 2 instead. Additive
# and backward compatible: omitting everything reproduces the pre-existing
# standard-agent-only behavior exactly.
_DEFAULT_AGENT_PROFILE = "standard-agent"
_KNOWN_AGENT_PROFILES = {"standard-agent", "standard-db-agent"}


class StartRunRequest(BaseModel):
    service_id: str
    input: dict[str, Any]
    trace_id: str | None = None
    user_context: dict[str, Any] | None = None


class RunResponse(BaseModel):
    id: str
    status: str
    trace_id: str
    created_at: str
    output: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    completed_at: str | None = None
    # Present only while status == "WAITING_FOR_USER" — see
    # ConfirmRunRequest and workflow.py's PendingConfirmation.
    pending_confirmation: dict[str, Any] | None = None


class ConfirmRunRequest(BaseModel):
    decision: Literal["approve", "deny"]


def _to_run_response(record: RunRecord) -> RunResponse:
    pending_confirmation = None
    if record.confirmation is not None:
        pending_confirmation = {
            "tool_name": record.confirmation.tool_name,
            "summary": record.confirmation.summary,
            "deadline": record.confirmation.deadline.isoformat(),
        }
    return RunResponse(
        id=record.id,
        status=record.status,
        trace_id=record.trace_id,
        created_at=record.created_at.isoformat(),
        output=record.output,
        error=record.error,
        completed_at=record.completed_at.isoformat() if record.completed_at else None,
        pending_confirmation=pending_confirmation,
    )


def get_llm_adapter() -> LLMAdapter:
    config = get_standard_config()
    return OllamaLLMAdapter(model_aliases=config.office_profile.get("model_aliases", {}))


def get_knowledge_adapter() -> KnowledgeAdapter:
    return HttpKnowledgeAdapter(search_runtime_url=settings.search_runtime_url)


def get_mcp_adapter() -> MCPAdapter:
    return HttpMCPAdapter(office_mcp_url=settings.office_mcp_url)


def get_asset_registry_resolver() -> AssetRegistryResolver:
    return HttpAssetRegistryResolver(
        portal_api_url=settings.portal_api_url, token=settings.portal_api_token
    )


def get_hub_search_adapter() -> HubSearchAdapter:
    return HttpHubSearchAdapter(
        portal_api_url=settings.portal_api_url, token=settings.portal_api_token
    )


def _fail_run_synchronously(
    run_id: str,
    service_id: str,
    trace_id: str,
    knowledge_id: str,
    question: str,
    *,
    code: str,
    message: str,
) -> None:
    """Fails the run synchronously (no background task needed — nothing was
    started) with the same `run.started` -> `run.failed` shape workflow.py
    uses for its own input-validation failures, so SSE consumers see one
    consistent pattern regardless of which check rejected the run. Shared by
    every pre-flight input rejection this router does (unknown agent_profile,
    D-034 Registry resolution failures, mismatched registry id pairing)."""
    run_store.append_event(
        run_id,
        "run.started",
        {
            "run_id": run_id,
            "service_id": service_id,
            "trace_id": trace_id,
            "knowledge_id": knowledge_id,
            "question": question,
        },
    )
    error = {"code": code, "message": message, "trace_id": trace_id}
    run_store.set_status(run_id, "FAILED", error=error)
    run_store.append_event(run_id, "run.failed", error)


@router.post("/runs", status_code=202)
async def start_run(
    body: StartRunRequest,
    llm_adapter: LLMAdapter = Depends(get_llm_adapter),
    knowledge_adapter: KnowledgeAdapter = Depends(get_knowledge_adapter),
    mcp_adapter: MCPAdapter = Depends(get_mcp_adapter),
    registry_resolver: AssetRegistryResolver = Depends(get_asset_registry_resolver),
    hub_search_adapter: HubSearchAdapter = Depends(get_hub_search_adapter),
) -> RunResponse:
    trace_id = body.trace_id or str(uuid4())
    record = run_store.create(service_id=body.service_id, trace_id=trace_id)

    knowledge_id = body.input.get("knowledge_id", "")
    question = body.input.get("question", "")

    # D-034 resolution path 2 (see agent_runtime.manifests module docstring
    # for the full order): an explicit registry AssetVersion id pair on
    # `input`. Both-or-neither — a lone id is ambiguous (which one is the
    # caller trusting `agent_profile`'s default for?) so it is rejected
    # rather than silently guessed.
    registry_agent_version_id = body.input.get("registry_agent_version_id")
    registry_prompt_version_id = body.input.get("registry_prompt_version_id")
    if bool(registry_agent_version_id) != bool(registry_prompt_version_id):
        _fail_run_synchronously(
            record.id, body.service_id, trace_id, knowledge_id, question,
            code="REGISTRY_AGENT_PROMPT_PAIR_REQUIRED",
            message=(
                "registry_agent_version_id와 registry_prompt_version_id는 "
                "함께 지정해야 합니다."
            ),
        )
        return RunResponse(
            id=record.id, status=record.status, trace_id=record.trace_id,
            created_at=record.created_at.isoformat(),
        )

    config: StandardKnowledgeChatConfig
    if registry_agent_version_id and registry_prompt_version_id:
        try:
            config = await resolve_registry_agent_config(
                registry_agent_version_id, registry_prompt_version_id, registry_resolver
            )
        except RegistryResolutionError as e:
            _fail_run_synchronously(
                record.id, body.service_id, trace_id, knowledge_id, question,
                code=e.code, message=e.message,
            )
            return RunResponse(
                id=record.id, status=record.status, trace_id=record.trace_id,
                created_at=record.created_at.isoformat(),
            )
    else:
        # D-034 resolution path 1 — an explicit field on `input` (no
        # Registry lookup at all, ever, for these two names). Omitting it is
        # the pre-existing standard-agent-only behavior, unchanged.
        agent_profile = body.input.get("agent_profile", _DEFAULT_AGENT_PROFILE)
        if agent_profile not in _KNOWN_AGENT_PROFILES:
            _fail_run_synchronously(
                record.id, body.service_id, trace_id, knowledge_id, question,
                code="AGENT_PROFILE_UNKNOWN",
                message=f"알 수 없는 agent_profile입니다: {agent_profile}",
            )
            return RunResponse(
                id=record.id, status=record.status, trace_id=record.trace_id,
                created_at=record.created_at.isoformat(),
            )
        config = (
            get_db_agent_config()
            if agent_profile == "standard-db-agent"
            else get_standard_config()
        )

    # MCP tool selection — likewise an explicit, structured field on `input`
    # (never free-form model output; see workflow.py's module docstring for
    # why). Only meaningful when `agent_profile` allows MCP; workflow.py
    # enforces that (capabilities.mcp_allowed) rather than this router, so
    # the check lives in exactly one place.
    mcp_tool = body.input.get("mcp_tool")
    mcp_tool_request: dict[str, Any] | None = None
    if mcp_tool:
        mcp_tool_request = {
            "tool_name": mcp_tool,
            "input": body.input.get("mcp_tool_input", {}),
            "confirmed": bool(body.input.get("mcp_confirmed", False)),
        }

    # Desktop 대화 고도화 — additive/optional (local-runtime-api.yaml
    # StartRunRequest.input.history). Not validated/shaped here beyond "is it
    # a list at all" — workflow.py's `bound_history` normalizes and bounds
    # it, and treats a malformed list defensively (skips non-dict entries)
    # rather than rejecting the whole run.
    raw_history = body.input.get("history")
    history = raw_history if isinstance(raw_history, list) else None

    # Hub (central Knowledge registry, portal-api M02) lookup — additive/
    # optional, default off (D-062-adjacent: a caller opts in explicitly).
    # `knowledge_ids` (Stage 1 fan-out across the local search-runtime) is
    # likewise defensive/optional here, same "is it a list at all" parsing
    # style as `history` above — workflow.py's own gate (`has_knowledge_id`)
    # handles a malformed/missing value safely.
    raw_knowledge_ids = body.input.get("knowledge_ids")
    knowledge_ids = raw_knowledge_ids if isinstance(raw_knowledge_ids, list) else None
    allow_hub_lookup = bool(body.input.get("allow_hub_lookup", False))

    # Agentic Knowledge selection (KNOWLEDGE_ROUTE stage) — additive/
    # optional, same defensive "is it a list at all" parsing style as
    # `knowledge_ids`/`history` above. workflow.py's `route_knowledge_
    # candidates` normalizes/validates each entry defensively and never
    # raises on malformed input.
    raw_knowledge_candidates = body.input.get("knowledge_candidates")
    knowledge_candidates = (
        raw_knowledge_candidates if isinstance(raw_knowledge_candidates, list) else None
    )

    # D-083 agentic MCP Tool selection (TOOL_ROUTE stage) — additive/
    # optional, default off. workflow.py only ever acts on this when
    # `mcp_tool_request` above is None (an explicit caller-declared tool
    # always wins) and the resolved agent allows MCP at all.
    tool_route_enabled = bool(body.input.get("tool_route", False))

    asyncio.create_task(
        run_knowledge_chat(
            run_id=record.id,
            service_id=body.service_id,
            trace_id=trace_id,
            knowledge_id=knowledge_id,
            question=question,
            config=config,
            llm_adapter=llm_adapter,
            knowledge_adapter=knowledge_adapter,
            run_store=run_store,
            mcp_adapter=mcp_adapter,
            mcp_tool_request=mcp_tool_request,
            # Read fresh at call time (not a bound default) so a settings
            # override (env var or test monkeypatch) always takes effect —
            # exactly the pattern main.py's CORS fix documents avoiding the
            # opposite mistake.
            mcp_confirmation_timeout_seconds=settings.mcp_confirmation_timeout_seconds,
            # D-062, §3.8 step 1: the Run's own trusted context, never
            # `body.input` — see workflow.run_knowledge_chat's docstring.
            user_context=body.user_context,
            history=history,
            knowledge_ids=knowledge_ids,
            knowledge_candidates=knowledge_candidates,
            allow_hub_lookup=allow_hub_lookup,
            hub_search_adapter=hub_search_adapter,
            tool_route_enabled=tool_route_enabled,
        )
    )

    return RunResponse(
        id=record.id,
        status=record.status,
        trace_id=record.trace_id,
        created_at=record.created_at.isoformat(),
    )


@router.get("/runs/{run_id}")
async def get_run(run_id: str) -> RunResponse:
    record = run_store.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _to_run_response(record)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict[str, Any]:
    record = run_store.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="run not found")
    if record.status in TERMINAL_STATUSES:
        return {"id": record.id, "status": record.status}
    # WAITING_FOR_USER is not terminal — cancelling while a Tool confirmation
    # is pending must still work (D06 규칙), and `_await_confirmation`
    # already races this same `cancel_event` against the confirmation itself.
    record.cancel_event.set()
    return {"id": record.id, "status": record.status}


@router.post("/runs/{run_id}/confirm")
async def confirm_run(run_id: str, body: ConfirmRunRequest) -> RunResponse:
    record = run_store.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="run not found")
    if record.status != "WAITING_FOR_USER" or record.confirmation is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "RUN_NOT_WAITING_FOR_USER",
                "message": "이 Run은 현재 사용자 확인을 기다리고 있지 않습니다.",
            },
        )
    record.confirmation.decision = body.decision
    record.confirmation.event.set()
    # The awaiting workflow coroutine (workflow.py `_await_confirmation`)
    # transitions status/emits `mcp.confirmation_resolved` asynchronously
    # right after this — this response is just an ack that the decision was
    # accepted, same pattern as `cancel_run` returning before CANCELLED lands.
    return _to_run_response(record)


@router.get("/runs/{run_id}/events")
async def run_events_stream(run_id: str, request: Request) -> StreamingResponse:
    record = run_store.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="run not found")

    last_event_id = request.headers.get("last-event-id")

    async def event_generator() -> AsyncIterator[str]:
        replayed = run_store.replay_since(run_id, last_event_id)
        for item in replayed:
            yield _format_sse(item)
            if item["event"] in _TERMINAL_EVENTS:
                return

        queue = run_store.subscribe(run_id)
        try:
            while True:
                item = await queue.get()
                yield _format_sse(item)
                if item["event"] in _TERMINAL_EVENTS:
                    return
        finally:
            run_store.unsubscribe(run_id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _format_sse(item: dict[str, Any]) -> str:
    return f"id: {item['id']}\nevent: {item['event']}\ndata: {json.dumps(item['data'])}\n\n"
