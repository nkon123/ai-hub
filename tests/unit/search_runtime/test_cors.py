"""CORS on search-runtime — the Desktop chat screen health-checks this service
from the renderer (D-079), so a browser must be able to read the response.

The regression these tests exist for is not "CORS is misconfigured" in the
abstract. It is the specific failure this repo already lived through once in
agent-runtime: a literal hardcoded in `main.py` silently shadowed the
`cors_origins` setting, the server kept logging 200s, and the browser threw
every response away. `test_middleware_reads_the_setting` is the drift guard
for exactly that.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from search_runtime import settings
from search_runtime.main import app

client = TestClient(app)

ALLOWED_ORIGIN = "http://localhost:5174"
FOREIGN_ORIGIN = "https://evil.example.com"


def test_middleware_reads_the_setting() -> None:
    """`main.py` must not carry its own copy of the origin list."""
    cors = [m for m in app.user_middleware if "CORSMiddleware" in str(m.cls)]
    assert len(cors) == 1
    configured = cors[0].kwargs["allow_origins"]
    assert configured == list(settings.CORS_ORIGINS)


def test_health_is_readable_from_an_allowed_origin() -> None:
    """The Desktop renderer's connection check — the reason this exists."""
    res = client.get("/health", headers={"Origin": ALLOWED_ORIGIN})
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_foreign_origin_gets_no_allow_origin_header() -> None:
    """A page the operator did not allow cannot read this service's responses.

    Note what this does NOT claim: the request itself still reaches the server
    (that is how CORS works — it gates response *readability*, not delivery).
    See `settings.CORS_ORIGINS`'s docstring for what actually protects the
    administrative endpoints."""
    res = client.get("/health", headers={"Origin": FOREIGN_ORIGIN})
    assert res.status_code == 200
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


def test_preflight_for_a_json_post_is_refused_for_a_foreign_origin() -> None:
    """The D-079 registration endpoint takes a JSON POST, which is never a
    "simple" request — so a foreign page's preflight must fail, and the actual
    POST is then never sent by the browser."""
    res = client.options(
        "/search/v1/local-indexes",
        headers={
            "Origin": FOREIGN_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


def test_preflight_for_a_json_post_is_allowed_for_a_known_origin() -> None:
    res = client.options(
        "/search/v1/local-indexes",
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert res.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_default_origins_match_agent_runtimes() -> None:
    """Both services are called by the same two front ends (portal-web 3000,
    Desktop Vite 5174). If these lists drift, one service works in the browser
    and the other mysteriously does not."""
    from agent_runtime.config import AgentRuntimeSettings

    assert set(settings.CORS_ORIGINS) == set(AgentRuntimeSettings().cors_origins)
