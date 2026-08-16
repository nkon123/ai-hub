"""Hosted Chat endpoints — /chat-api/v1/* (M05).

Implements packages/schemas/api/hosted-chat-api.yaml exactly:
  GET  /chat-api/v1/chatbots/{slug}                 -> ChatbotConfig
  POST /chat-api/v1/sessions                        -> ChatSession
  POST /chat-api/v1/sessions/{session_id}/messages  -> text/event-stream

Reuses the same `run_knowledge_chat` workflow and `RunStore` as the Local
Runtime's `/local/v1/runs*` (routers/runs.py) — Preview and Hosted Chat share
one Agent Runtime Core (spec §6.2 "Preview가 게시 Runtime Core를 사용한다").
The hosted SSE `event` enum is intentionally smaller than the local runtime's
internal event log (no `knowledge.search.started`, `preflight.completed`, or
`run.cancelled`), so this router translates/filters as it streams.

D-035: agent-runtime is unauthenticated in this PoC. Per spec §12 the
production default access policy is `INTERNAL_AUTHENTICATED` — the place a
caller-identity check and a 403 Forbidden branch would go is marked below
with `AUTH-TODO` comments.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agent_runtime.adapters import (
    AssetRegistryResolver,
    DeploymentResolver,
    KnowledgeAdapter,
    LLMAdapter,
)
from agent_runtime.adapters.deployment import HttpDeploymentResolver
from agent_runtime.chat_sessions import chat_session_store
from agent_runtime.config import settings
from agent_runtime.manifests import (
    RegistryResolutionError,
    get_standard_config,
    resolve_registry_agent_config,
)
from agent_runtime.routers.runs import (
    get_asset_registry_resolver,
    get_knowledge_adapter,
    get_llm_adapter,
)
from agent_runtime.run_store import run_store
from agent_runtime.workflow import run_knowledge_chat

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MESSAGE_LENGTH = 4096

# Internal event name -> hosted event name. Internal-only events (not in this
# map) are dropped from the hosted stream. `knowledge.route.selected` and
# `mcp.tool_route.selected`/`mcp.tool_route.rejected` (D-083) are
# deliberately excluded, same reasoning for both: `send_message` below calls
# `run_knowledge_chat` without `knowledge_candidates` or
# `tool_route_enabled`, so neither KNOWLEDGE_ROUTE nor TOOL_ROUTE ever runs
# for a Hosted chatbot and these events simply never fire here — there is
# nothing to translate, and this map staying unchanged is itself part of how
# "chat.py never enables routing" is verified (see the regression test).
_INTERNAL_TO_HOSTED_EVENT = {
    "run.started": "run.started",
    "knowledge.search.completed": "search.completed",
    "answer.delta": "answer.delta",
    "citation.added": "citation.added",
    "run.completed": "run.completed",
    "run.failed": "run.failed",
}
# Internal events that end the run but have no hosted equivalent to emit
# (defensive — `run.cancelled` cannot occur today since this router exposes
# no cancel endpoint, but the loop must still stop if it ever does).
_TERMINAL_INTERNAL_EVENTS_WITHOUT_HOSTED_EQUIVALENT = {"run.cancelled"}
_HOSTED_TERMINAL_EVENTS = {"run.completed", "run.failed"}

_SAFE_NOT_FOUND_MESSAGE = "요청하신 챗봇을 찾을 수 없거나 현재 사용할 수 없습니다."


class ChatbotConfig(BaseModel):
    slug: str
    name: str
    welcome_message: str | None = None
    suggested_questions: list[str] = Field(default_factory=list)
    citation_display: bool = True
    deployment_revision_id: str


class CreateSessionRequest(BaseModel):
    slug: str


class ChatSession(BaseModel):
    id: str
    status: str  # ACTIVE | EXPIRED | TERMINATED
    trace_id: str
    expires_at: datetime


class SendMessageRequest(BaseModel):
    message: str = Field(min_length=1)
    run_id: str | None = None  # client idempotency key — accepted, not yet deduplicated (PoC)


def get_deployment_resolver() -> DeploymentResolver:
    return HttpDeploymentResolver(portal_api_url=settings.portal_api_url)


def _error_envelope(status_code: int, code: str, message: str, trace_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "trace_id": trace_id}},
    )


def _deployment_not_active_error(status_code: int, trace_id: str) -> JSONResponse:
    return _error_envelope(status_code, "DEPLOYMENT_NOT_ACTIVE", _SAFE_NOT_FOUND_MESSAGE, trace_id)


def _format_sse(event_id: str, event: str, data: dict[str, Any]) -> str:
    return f"id: {event_id}\nevent: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/chatbots/{slug}", response_model=ChatbotConfig)
async def get_chatbot(
    slug: str,
    resolver: DeploymentResolver = Depends(get_deployment_resolver),
) -> ChatbotConfig | JSONResponse:
    trace_id = str(uuid4())
    # AUTH-TODO: once caller identity is available, check the deployment's
    # target_orgs/target_sites/target_roles here and return
    # _error_envelope(403, "CHAT_ACCESS_DENIED", ..., trace_id) on mismatch.
    deployment = await resolver.resolve(slug)
    if deployment is None:
        logger.info("chat.chatbot_config.not_found slug=%s trace_id=%s", slug, trace_id)
        return _deployment_not_active_error(status.HTTP_404_NOT_FOUND, trace_id)

    chatbot_config = deployment.get("chatbot_config") or {}
    return ChatbotConfig(
        slug=deployment["slug"],
        name=deployment["name"],
        welcome_message=chatbot_config.get("welcome_message"),
        suggested_questions=chatbot_config.get("suggested_questions") or [],
        citation_display=chatbot_config.get("citation_display", True),
        deployment_revision_id=deployment["active_revision_id"],
    )


@router.post("/sessions", status_code=status.HTTP_201_CREATED, response_model=ChatSession)
async def create_session(
    body: CreateSessionRequest,
    resolver: DeploymentResolver = Depends(get_deployment_resolver),
) -> ChatSession | JSONResponse:
    trace_id = str(uuid4())
    # AUTH-TODO: validate caller identity/ACL against the deployment's target
    # orgs/sites/roles before minting a session; deny with CHAT_ACCESS_DENIED.
    deployment = await resolver.resolve(body.slug)
    if deployment is None:
        logger.info("chat.session.create.not_found slug=%s trace_id=%s", body.slug, trace_id)
        # Same existence-agnostic error as GET /chatbots/{slug} (spec §9): a
        # session request must not reveal whether the slug ever existed.
        return _deployment_not_active_error(status.HTTP_403_FORBIDDEN, trace_id)

    record = chat_session_store.create(
        slug=body.slug,
        deployment_revision_id=deployment["active_revision_id"],
        knowledge_id=deployment.get("knowledge_id") or "",
        model_alias=deployment.get("model_alias") or "default-chat",
        trace_id=trace_id,
        # D-034: frozen at publish time by portal-api. Captured on the session
        # rather than re-resolved per message so that every message in one
        # conversation is answered by the same Agent — a Registry change
        # mid-conversation must not silently swap the answering Agent.
        registry_agent_version_id=deployment.get("registry_agent_version_id"),
        registry_prompt_version_id=deployment.get("registry_prompt_version_id"),
    )
    logger.info(
        "chat.session.created session_id=%s slug=%s trace_id=%s",
        record.id,
        record.slug,
        record.trace_id,
    )
    return ChatSession(
        id=record.id,
        status=record.status,
        trace_id=record.trace_id,
        expires_at=record.expires_at,
    )


@router.post("/sessions/{session_id}/messages", response_model=None)
async def send_message(
    session_id: str,
    body: SendMessageRequest,
    llm_adapter: LLMAdapter = Depends(get_llm_adapter),
    knowledge_adapter: KnowledgeAdapter = Depends(get_knowledge_adapter),
    registry_resolver: AssetRegistryResolver = Depends(get_asset_registry_resolver),
) -> StreamingResponse | JSONResponse:
    session = chat_session_store.get_active(session_id)
    if session is None:
        return _error_envelope(
            status.HTTP_403_FORBIDDEN,
            "CHAT_SESSION_EXPIRED",
            "세션이 만료되었거나 존재하지 않습니다. 새로고침 후 다시 시도해 주세요.",
            str(uuid4()),
        )

    if len(body.message) > MAX_MESSAGE_LENGTH:
        return _error_envelope(
            status.HTTP_400_BAD_REQUEST,
            "CHAT_INPUT_TOO_LARGE",
            f"메시지는 최대 {MAX_MESSAGE_LENGTH}자까지 입력할 수 있습니다.",
            session.trace_id,
        )

    if session.in_flight or not chat_session_store.check_rate_limit(session):
        return _error_envelope(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "CHAT_RATE_LIMITED",
            "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
            session.trace_id,
        )

    trace_id = str(uuid4())

    # D-034 resolution path 2 for Hosted Chat. Before this, Hosted was
    # hardwired to the standard Agent, so a Service published with a
    # Registry-registered Agent silently answered as a *different* Agent than
    # the one it was published with. Now the two cases are explicit, and the
    # standard path is untouched: a deployment without both ids (every
    # chatbot published before 2026-08-16) still gets `get_standard_config()`
    # and never reaches portal-api here.
    if session.registry_agent_version_id and session.registry_prompt_version_id:
        try:
            config = await resolve_registry_agent_config(
                session.registry_agent_version_id,
                session.registry_prompt_version_id,
                registry_resolver,
            )
        except RegistryResolutionError as exc:
            # Deliberately NOT falling back to the standard Agent: answering
            # with an Agent the publisher did not choose is worse than not
            # answering, because nothing in the reply would reveal the swap.
            logger.warning(
                "chat.registry_agent.unresolved session_id=%s slug=%s code=%s trace_id=%s",
                session.id,
                session.slug,
                exc.code,
                trace_id,
            )
            return _error_envelope(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "CHAT_AGENT_UNAVAILABLE",
                "이 챗봇이 사용하는 Agent 구성을 불러올 수 없어 답변할 수 없습니다. "
                "잠시 후 다시 시도해 주세요.",
                trace_id,
            )
    else:
        config = get_standard_config()

    run_record = run_store.create(service_id=session.slug, trace_id=trace_id)

    session.in_flight = True
    session.message_count += 1

    # Subscribe before starting the task so no early event can be missed.
    queue = run_store.subscribe(run_record.id)
    asyncio.create_task(
        run_knowledge_chat(
            run_id=run_record.id,
            service_id=session.slug,
            trace_id=trace_id,
            knowledge_id=session.knowledge_id,
            question=body.message,
            config=config,
            llm_adapter=llm_adapter,
            knowledge_adapter=knowledge_adapter,
            run_store=run_store,
        )
    )

    async def event_generator() -> AsyncIterator[str]:
        try:
            while True:
                item = await queue.get()
                internal_event = item["event"]
                hosted_event = _INTERNAL_TO_HOSTED_EVENT.get(internal_event)
                if hosted_event is None:
                    if internal_event in _TERMINAL_INTERNAL_EVENTS_WITHOUT_HOSTED_EQUIVALENT:
                        return
                    continue  # internal-only event (e.g. preflight.completed) — drop
                # Every hosted event carries the run's trace_id, even for
                # internal event payloads (e.g. citation.added, answer.delta)
                # that don't already include one.
                hosted_data = {**item["data"], "trace_id": trace_id}
                yield _format_sse(item["id"], hosted_event, hosted_data)
                if hosted_event in _HOSTED_TERMINAL_EVENTS:
                    return
        finally:
            run_store.unsubscribe(run_record.id, queue)
            session.in_flight = False

    return StreamingResponse(event_generator(), media_type="text/event-stream")
