"""Optional inbound Trace ID middleware for FastAPI/Starlette apps.

Reads `X-Trace-Id` from the incoming request — any caller-supplied value is
trusted only as an opaque correlation string, never parsed or interpreted —
falls back to a fresh UUID4 when absent, binds it into this request's async
task context for the duration of the request (so every `logging` call made
while handling it picks the id up automatically via
`observability.logging_config.TraceContextFilter`), and echoes it back on
the response header so a caller that omitted it can still correlate against
this service's logs afterward.

This is *one* way a service's trace id gets bound, not the only one. Use it
for services whose trace id genuinely arrives (or should be echoed) as a
header on every request, e.g. `apps/portal-api` request handlers that have
no other trace id source. Where a trace id instead arrives as a field in the
request body — `services/agent-runtime`'s Run `trace_id`,
`services/search-runtime`'s `SearchRequest.trace_id`,
`services/distribution-service`'s `BundleJobRequest.trace_id` — bind it
directly at that point with `observability.context.bind_trace_id`/
`trace_context` instead; adding this middleware there too would create a
second, different trace id for the same request.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from observability.context import bind_trace_id, reset_trace_id

DEFAULT_TRACE_HEADER = "X-Trace-Id"


class TraceIdMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, header_name: str = DEFAULT_TRACE_HEADER) -> None:
        super().__init__(app)
        self._header_name = header_name

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        trace_id = request.headers.get(self._header_name) or str(uuid.uuid4())
        token = bind_trace_id(trace_id)
        try:
            response = await call_next(request)
        finally:
            reset_trace_id(token)
        response.headers[self._header_name] = trace_id
        return response
