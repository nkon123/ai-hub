"""Office MCP Server entrypoint (M10) — 05-mcp-security-governance.md §11.

READ_ONLY MCP tools only. No arbitrary SQL, no arbitrary code execution, no
arbitrary external URL, no package install — this process only ever talks to
`Connector` (a Mock in this PoC, D-014) and never shells out or imports
user-controlled code.
"""

from __future__ import annotations

import logging
import os
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from observability import configure_logging

from office_mcp_server.audit import InMemoryAuditSink, LoggingAuditSink, MultiAuditSink
from office_mcp_server.connector import MockOracleConnector
from office_mcp_server.errors import ErrorCode, McpError, error_response, mcp_error_response
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import ToolRegistry
from office_mcp_server.tools_setup import register_poc_tools

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn
# (uvicorn's own Config.configure_logging() never touches the root logger).
configure_logging("office-mcp-server")
_logger = logging.getLogger("office_mcp_server")

SERVER_VERSION = "0.1.0"
SCHEMA_VERSION = "1.0"

# Deployment identity — distinct from SERVER_VERSION above. SERVER_VERSION is
# the product/protocol version this MCP server advertises to clients; these
# two answer a different question: "which build of the code is this process
# actually running". Same contract as portal-api / distribution-service
# (2026-08-12), search-runtime (2026-08-13) and agent-runtime /
# indexing-runtime (2026-08-14). Plain `os.environ` because this service has
# no settings module and two constants do not justify introducing one.
#
# The incident: a search-runtime process from six days earlier was still
# listening, so a route added that week returned 404 while `/health` reported
# a hardcoded version — a fresh process and a stale one looked identical.
BUILD_VERSION = os.environ.get("OFFICE_MCP_BUILD_VERSION", "0.1.0")
COMMIT_SHA = os.environ.get("OFFICE_MCP_COMMIT_SHA", "unknown")

# Desktop 채팅 화면은 이 서버의 상태를 **렌더러에서** 직접 health-check 한다
# (`electron/connections.ts`, `ChatScreen.tsx`). CORS 헤더가 없으면 브라우저가
# `/health/live` 응답조차 읽지 못해, 서버가 200 을 기록하는데도 화면에는
# "Failed to fetch" 로 뜬다 — 2026-08-14 실사용에서 실제로 발생했다.
#
# Origin 목록은 agent-runtime(`AgentRuntimeSettings.cors_origins`)·
# search-runtime(`settings.CORS_ORIGINS`)과 **동일하게 유지한다**. 세 서비스가
# 같은 두 프런트엔드(portal-web 3000, Desktop 렌더러 5173)에게 불리기 때문이며,
# 목록이 갈라지면 한 서비스만 조용히 차단되는 오늘 같은 상황이 반복된다 —
# `tests/unit/search_runtime/test_cors.py` 의 drift 테스트가 이를 고정한다.
#
# CORS 가 이 서버의 Tool 실행 API 를 지켜주는 장치가 **아니라는** 점은 분명히
# 해 둔다: cross-origin 단순 요청은 이 목록과 무관하게 서버에 도달한다. 실제
# 보호는 §8 권한 검사와 READ_ONLY 강제, 그리고 loopback 배포 형태다.
CORS_ORIGINS = tuple(
    part.strip()
    for part in os.environ.get(
        "OFFICE_MCP_CORS_ORIGINS",
        "http://localhost:3000,"
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5174,http://127.0.0.1:5174",
    ).split(",")
    if part.strip()
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Emitted once so an operator reading this process's log can tell which
    # revision is in memory — see BUILD_VERSION above.
    _logger.info(
        "service.started service=office-mcp-server build_version=%s commit_sha=%s",
        BUILD_VERSION,
        COMMIT_SHA,
    )
    yield


app = FastAPI(
    title="Office MCP Server",
    version=BUILD_VERSION,
    description="READ_ONLY MCP tools only. No arbitrary SQL or code execution.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CORS_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = ToolRegistry()
register_poc_tools(registry)
connector = MockOracleConnector()
# The MCP Tool audit trail (05-mcp-security-governance.md §10/§12) must be
# both queryable in-process (InMemoryAuditSink, kept for `/admin/audit/events`
# below and for tests) and visible from outside the process (LoggingAuditSink
# — a structured log line per AuditEvent, carrying the same trace_id/run_id
# as everything else this run touched). Neither alone was enough: in-memory
# only is a write-only trail no operator can inspect without an endpoint;
# log-only would drop admin introspection this PoC already had.
in_memory_audit_sink = InMemoryAuditSink()
audit_sink = MultiAuditSink([in_memory_audit_sink, LoggingAuditSink()])
pipeline = ToolCallPipeline(registry=registry, connector=connector, audit_sink=audit_sink)

ADMIN_ROLE = "ADMIN"


def _trace_id(x_trace_id: str | None) -> str:
    return x_trace_id or str(uuid.uuid4())


def _require_admin(x_actor_role: str | None) -> None:
    """PoC Mock Enterprise Identity Adapter (§7): admin endpoints trust an
    `X-Actor-Role` header set by the (mocked) trusted auth gateway. This is
    intentionally the same "never trust a client-asserted role for a real
    permission decision without a trusted layer in front of it" caveat as
    `RequestContext` — D-001/D-015 track the real adapter as PoC-only."""
    if x_actor_role != ADMIN_ROLE:
        raise McpError(ErrorCode.PERMISSION_DENIED, "관리자 권한이 필요한 API입니다.")


@app.get("/health")
async def health_legacy() -> JSONResponse:
    """Kept for backward compatibility with the pre-§11 stub; §11's
    `/health/live` and `/health/ready` are the canonical operational API."""
    # Same shape every other service's `/health` returns, so one operator
    # check works across the whole stack. `/health/live` deliberately stays
    # minimal (§11 liveness probe) and `/version` keeps SERVER_VERSION.
    return JSONResponse({"status": "ok", "version": BUILD_VERSION, "commit_sha": COMMIT_SHA})


@app.get("/health/live")
async def health_live() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/health/ready")
async def health_ready() -> JSONResponse:
    status = await connector.health()
    body = {"status": "ready" if status.healthy else "not_ready", "detail": status.detail}
    return JSONResponse(body, status_code=200 if status.healthy else 503)


@app.get("/version")
async def version() -> JSONResponse:
    return JSONResponse(
        {
            "server_version": SERVER_VERSION,
            "schema_version": SCHEMA_VERSION,
            "build_version": BUILD_VERSION,
            "commit_sha": COMMIT_SHA,
            "tools": [{"name": t.name, "version": t.version} for t in registry.list_all()],
        }
    )


@app.get("/mcp/v1/tools")
async def list_tools() -> JSONResponse:
    tools = registry.admin_list()
    return JSONResponse({"tools": tools, "count": len(tools)})


@app.post("/mcp/v1/tools/{tool_name}/call")
async def call_tool(
    tool_name: str,
    body: dict,
    x_trace_id: str | None = Header(default=None),
) -> JSONResponse:
    trace_id = _trace_id(x_trace_id)
    try:
        result = await pipeline.call(tool_name, body)
        return JSONResponse(result)
    except McpError as error:
        return mcp_error_response(error, trace_id)
    except Exception:  # noqa: BLE001 — last-resort boundary, never leak internals to the caller
        _logger.exception("Unhandled error while executing MCP tool %s", tool_name)
        return error_response(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Tool 실행 중 오류가 발생했습니다.",
            trace_id,
        )


@app.get("/admin/tools")
async def admin_list_tools(x_actor_role: str | None = Header(default=None)) -> JSONResponse:
    try:
        _require_admin(x_actor_role)
    except McpError as error:
        return mcp_error_response(error, str(uuid.uuid4()))
    return JSONResponse({"tools": registry.admin_list()})


@app.post("/admin/tools/{tool_name}/disable")
async def admin_disable_tool(
    tool_name: str, x_actor_role: str | None = Header(default=None)
) -> JSONResponse:
    trace_id = str(uuid.uuid4())
    try:
        _require_admin(x_actor_role)
    except McpError as error:
        return mcp_error_response(error, trace_id)
    if not registry.disable(tool_name):
        return error_response(
            404, ErrorCode.MCP_TOOL_NOT_FOUND, "존재하지 않는 Tool입니다.", trace_id
        )
    return JSONResponse({"tool_name": tool_name, "status": "DISABLED"})


@app.post("/admin/tools/{tool_name}/enable")
async def admin_enable_tool(
    tool_name: str, x_actor_role: str | None = Header(default=None)
) -> JSONResponse:
    trace_id = str(uuid.uuid4())
    try:
        _require_admin(x_actor_role)
    except McpError as error:
        return mcp_error_response(error, trace_id)
    if not registry.enable(tool_name):
        return error_response(
            404, ErrorCode.MCP_TOOL_NOT_FOUND, "존재하지 않는 Tool입니다.", trace_id
        )
    return JSONResponse({"tool_name": tool_name, "status": "ACTIVE"})


@app.get("/admin/audit/events")
async def admin_list_audit_events(
    x_actor_role: str | None = Header(default=None),
    trace_id: str | None = None,
    limit: int = 100,
) -> JSONResponse:
    """Read path for the MCP Tool audit trail — additive beyond
    05-mcp-security-governance.md §11's documented `/admin/tools*` table,
    gated identically (admin-only, same PoC Mock Identity caveat as
    `_require_admin`). `LoggingAuditSink` (wired into `audit_sink` above) is
    the log-line side of the same trail and is what actually satisfies
    README §15 step 12 ("MCP 로그가 동일 Trace ID로 연결된다") from outside
    this process; this endpoint is a convenience for inspecting it without
    grepping a log file while the process is still running. In-memory only
    (§12.9 append-only/durable storage is out of scope for this PoC sink,
    same caveat `InMemoryAuditSink`'s own docstring already states)."""
    request_trace_id = str(uuid.uuid4())
    try:
        _require_admin(x_actor_role)
    except McpError as error:
        return mcp_error_response(error, request_trace_id)
    events = in_memory_audit_sink.events
    if trace_id is not None:
        events = [e for e in events if e.trace_id == trace_id]
    events = events[-limit:] if limit > 0 else []
    dumped = [e.model_dump(mode="json") for e in events]
    return JSONResponse({"events": dumped, "count": len(dumped)})
