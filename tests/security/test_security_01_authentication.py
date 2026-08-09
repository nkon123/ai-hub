"""Security property 1 — Authentication is actually required.

`apps/portal-api/src/portal_api/auth.py`'s `get_current_user` is a
per-request FastAPI dependency, unit-testable in isolation -- but a unit
test importing that function directly cannot prove every router actually
wired the dependency in, or that nothing upstream (a proxy, a CORS
middleware, a caching layer) short-circuits it before the real HTTP
boundary. This module calls the LIVE, running portal-api over the network
with no test-only shortcuts, exactly the property the task brief asks for.

Scope note: per the task brief, agent-runtime (:8100) and office-mcp-server
(:8500) take no auth in this PoC (D-035 for agent-runtime, D-015 for MCP) --
this file only exercises portal-api (:8000), the one service in this stack
that actually authenticates.
"""

from __future__ import annotations

import httpx
import pytest

from tests.security.conftest import assert_no_secret_leak, unknown_token

pytestmark = pytest.mark.security


async def test_missing_authorization_header_rejected(portal: httpx.AsyncClient) -> None:
    resp = await portal.get("/api/v1/assets")
    assert resp.status_code == 401, resp.text
    assert_no_secret_leak(resp.text, context="missing Authorization header")


async def test_garbage_bearer_token_rejected(portal: httpx.AsyncClient) -> None:
    resp = await portal.get(
        "/api/v1/assets", headers={"Authorization": "Bearer not-a-real-token-at-all"}
    )
    assert resp.status_code == 401, resp.text
    assert_no_secret_leak(resp.text, context="garbage bearer token")


async def test_malformed_authorization_scheme_rejected(portal: httpx.AsyncClient) -> None:
    """A non-Bearer scheme (e.g. Basic) must not authenticate either --
    `get_current_user` only ever strips a literal `Bearer ` prefix, so a
    Basic-encoded credential is looked up verbatim and never matches."""
    resp = await portal.get(
        "/api/v1/assets", headers={"Authorization": "Basic ZGV2LXVzZXI6cGFzc3dvcmQ="}
    )
    assert resp.status_code == 401, resp.text


async def test_valid_looking_unknown_token_does_not_authenticate(portal: httpx.AsyncClient) -> None:
    """The core of property 1: a token that is *shaped* exactly like a real
    Test Identity token (`dev-<role>-token`) but was never issued must still
    be rejected -- proving the check is a real lookup against known
    identities, not a pattern/format check that anything `dev-*-token`
    shaped would pass."""
    fake_token = unknown_token("release")
    assert fake_token.startswith("dev-release-token")  # same shape as the real dev-release-token
    resp = await portal.get("/api/v1/assets", headers={"Authorization": f"Bearer {fake_token}"})
    assert resp.status_code == 401, resp.text
    assert_no_secret_leak(resp.text, context="valid-shaped unknown token")


async def test_empty_bearer_token_rejected(portal: httpx.AsyncClient) -> None:
    # A literal trailing space after "Bearer" is illegal at the HTTP header
    # level (httpx/h11 reject it client-side before the request is even
    # sent) -- "Bearer" with nothing following is the equivalent
    # empty-credential case that can actually reach the server.
    resp = await portal.get("/api/v1/assets", headers={"Authorization": "Bearer"})
    assert resp.status_code == 401, resp.text


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/assets",
        "/api/v1/services",
        "/api/v1/reviews",
        "/api/v1/audit-events",
        "/api/v1/distributions",
    ],
)
async def test_every_checked_endpoint_requires_authentication(
    portal: httpx.AsyncClient, path: str
) -> None:
    """Sweep: authentication must be enforced independently on every router
    this suite otherwise exercises for authorization (property 2) -- a
    single endpoint mistakenly left open would make every downstream
    "authorization" test below meaningless (there would be no identity to
    authorize in the first place)."""
    resp = await portal.get(path)
    assert resp.status_code == 401, f"{path} did not require authentication: {resp.text}"
