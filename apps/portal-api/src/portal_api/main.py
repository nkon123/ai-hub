"""Portal API entrypoint."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from observability import configure_logging
from observability.middleware import TraceIdMiddleware

from portal_api.config import settings
from portal_api.database import init_db
from portal_api.routers.admin import router as admin_router
from portal_api.routers.assets import router as assets_router
from portal_api.routers.deployments import router as deployments_router
from portal_api.routers.distributions import router as distributions_router
from portal_api.routers.evaluations import router as evaluations_router
from portal_api.routers.knowledge_search import router as knowledge_search_router
from portal_api.routers.reviews import router as reviews_router
from portal_api.routers.services import router as services_router

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn.
configure_logging("portal-api")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # See `database.init_db()` docstring: schema is owned by Alembic
    # (`make migrate`), not created here.
    await init_db()
    logger.info(
        "service.started service=portal-api build_version=%s commit_sha=%s",
        settings.build_version,
        settings.commit_sha,
    )
    yield


app = FastAPI(
    title="Enterprise AI Asset Hub — Portal API",
    version=settings.build_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # 하드코딩하지 않고 설정을 읽는다 — 사유는 Settings.cors_origins 주석 참고.
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Binds one trace id per inbound request (X-Trace-Id header, or a fresh
# UUID4 when absent) into this request's async task context — every
# router's `_trace_id()` helper reads it back via `observability
# .get_trace_id()` instead of minting a second, different id, and every
# `logging` call made while handling the request carries it automatically.
app.add_middleware(TraceIdMiddleware)

# reviews_router before assets_router: both declare routes under
# `/api/v1/asset-versions/...`, and Starlette matches path+method in
# registration order across ALL routers, not just within one file.
# `assets_router`'s new `GET /asset-versions/{version_id}` (D-034) is a
# single-segment catch-all that would otherwise shadow reviews_router's
# literal `GET /asset-versions/lifecycle` (P16) if assets_router registered
# first — proven by test_lifecycle.py failing with a 404 "lifecycle" was
# never reached. Every other cross-router path differs either in HTTP
# method or in segment count, so this reordering changes no other route's
# effective handler (Starlette only advances past a path match when the
# method also fails to match — see `Router.app`/`Match.PARTIAL` handling).
app.include_router(reviews_router)
app.include_router(assets_router)
app.include_router(services_router)
app.include_router(deployments_router)
app.include_router(distributions_router)
app.include_router(evaluations_router)
app.include_router(admin_router)
# `/api/v1/knowledge-search` is a brand-new literal path segment (no
# `{param}` catch-all), so unlike the reviews_router/assets_router ordering
# above (D-034), registration order here cannot shadow or be shadowed by
# any existing route.
app.include_router(knowledge_search_router)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "version": settings.build_version,
            "commit_sha": settings.commit_sha,
        }
    )
