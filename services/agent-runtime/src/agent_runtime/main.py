"""Agent Runtime entrypoint.

Runs in two modes:
- local: loopback-only at 127.0.0.1:8100 (Desktop)
- hosted: internal network at 0.0.0.0:8100 (Hosted Chat)
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from observability import configure_logging

from agent_runtime import manifests
from agent_runtime.config import settings
from agent_runtime.routers import chat, runs

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn
# (uvicorn's own Config.configure_logging() never touches the root logger).
# Must run before any `logging.getLogger(__name__)` call site below (e.g.
# agent_runtime.workflow's module-level logger) actually emits anything.
configure_logging("agent-runtime")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Load and validate both the standard (Knowledge-only) and MCP-capable
    # Agent/Prompt/Office Profile configs eagerly so a bad config fails
    # startup immediately instead of on the first request.
    manifests.get_standard_config()
    manifests.get_db_agent_config()
    yield


app = FastAPI(
    title="Agent Runtime",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # Was hardcoded here, which silently ignored the existing
    # AgentRuntimeSettings.cors_origins field (and its AGENT_RUNTIME_CORS_ORIGINS
    # env override). Read the setting so the two cannot drift apart.
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.1.0"})


@app.get("/local/v1/health")
async def detailed_health() -> JSONResponse:
    return JSONResponse({
        "status": "ok",
        "components": {
            "ollama": {"status": "unknown", "model_loaded": False},
            "chroma": {"status": "unknown"},
            "mcp": {"status": "unknown"},
        },
    })


app.include_router(runs.router, prefix="/local/v1")
app.include_router(chat.router, prefix="/chat-api/v1")

# `/local/v1/services*` is out of scope for this phase — M02 Registry (Agent/
# Prompt/Service lookup) is not implemented yet (D-034). service_id is
# accepted as an opaque string in StartRunRequest with no registry lookup.
# from agent_runtime.routers import services
# app.include_router(services.router, prefix="/local/v1")
