"""Unit tests for `observability.middleware.TraceIdMiddleware` — the inbound
half of Trace ID propagation for services (e.g. `apps/portal-api`) whose
trace id arrives as a header rather than a body field.
"""

from __future__ import annotations

from observability.context import get_trace_id
from observability.middleware import DEFAULT_TRACE_HEADER, TraceIdMiddleware
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


async def _whoami(request):  # noqa: ANN001, ANN202 - test helper, Starlette's own untyped shape
    return JSONResponse({"trace_id": get_trace_id()})


def _make_app() -> Starlette:
    app = Starlette(routes=[Route("/whoami", _whoami)])
    app.add_middleware(TraceIdMiddleware)
    return app


def test_generates_trace_id_when_header_absent() -> None:
    client = TestClient(_make_app())
    resp = client.get("/whoami")

    assert resp.status_code == 200
    body_trace_id = resp.json()["trace_id"]
    assert body_trace_id  # a UUID4 string was generated
    # Echoed back on the response header too.
    assert resp.headers[DEFAULT_TRACE_HEADER] == body_trace_id


def test_reuses_caller_supplied_trace_id() -> None:
    client = TestClient(_make_app())
    resp = client.get("/whoami", headers={DEFAULT_TRACE_HEADER: "trace-caller-123"})

    assert resp.json()["trace_id"] == "trace-caller-123"
    assert resp.headers[DEFAULT_TRACE_HEADER] == "trace-caller-123"


def test_does_not_leak_trace_id_outside_the_request() -> None:
    assert get_trace_id() is None
    client = TestClient(_make_app())
    client.get("/whoami", headers={DEFAULT_TRACE_HEADER: "trace-should-not-leak"})
    assert get_trace_id() is None
