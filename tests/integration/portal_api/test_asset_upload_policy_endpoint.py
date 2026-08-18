"""Integration tests for `GET /api/v1/assets/upload-policy`
(`routers/assets.py::get_asset_upload_policy`) — added so P05/P12 can show
upload limits *before* the user picks files, instead of only discovering
them from a rejected `POST /api/v1/assets` (see that endpoint's own suite,
`test_asset_upload_limits.py`).

This suite pins the three properties the brief called out as load-bearing:

1. The new endpoint returns exactly the same values `create_asset`
   enforces (same `_read_asset_upload_policy()` call, not a second parse of
   the policy file that could drift).
2. Routing order is not broken by this addition — `/assets/upload-policy`
   must resolve to this handler, not to `GET /assets/{asset_id}` with
   `asset_id="upload-policy"` (the exact class of bug `main.py`'s
   reviews_router/assets_router ordering comment already documents once).
3. RBAC: a token without `ASSET_CREATE` (AUDITOR) is denied with a DENIED
   audit row, mirroring every other `require_permission`-gated endpoint.
4. A missing/malformed policy file falls back to the same built-in defaults
   `create_asset` itself falls back to (fail closed, never "no limits").
"""

from __future__ import annotations

import json

import httpx
import pytest
from portal_api.config import settings

from tests.integration.portal_api.conftest import auth_header

pytestmark = pytest.mark.asyncio


def _write_policy(tmp_path, **overrides) -> object:
    policy = {
        "version": "1.0.0",
        "max_single_file_bytes": 12345,
        "max_total_request_bytes": 54321,
        "max_file_count": 7,
        "rejected_extensions": [".exe", ".zip"],
    }
    policy.update(overrides)
    path = tmp_path / "asset-upload-policy.json"
    path.write_text(json.dumps(policy), encoding="utf-8")
    return path


async def test_returns_same_values_asset_creation_enforces(
    client: httpx.AsyncClient, tmp_path, monkeypatch
) -> None:
    path = _write_policy(tmp_path)
    monkeypatch.setattr(settings, "asset_upload_policy_path", path)

    resp = await client.get("/api/v1/assets/upload-policy", headers=auth_header("dev-user-token"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["max_single_file_bytes"] == 12345
    assert body["max_total_request_bytes"] == 54321
    assert body["max_file_count"] == 7
    assert sorted(body["rejected_extensions"]) == [".exe", ".zip"]


async def test_routing_not_shadowed_by_asset_id_catch_all(client: httpx.AsyncClient) -> None:
    """`GET /assets/upload-policy` must hit this handler, not
    `get_asset(asset_id="upload-policy")` — which would 404 with
    `RESOURCE_NOT_FOUND` instead of 200 with the policy payload."""
    resp = await client.get("/api/v1/assets/upload-policy", headers=auth_header("dev-user-token"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The catch-all's shape (AssetOut) has no `max_file_count` field — a
    # regression to shadowing would still 200 in some misconfigurations but
    # would return an asset-shaped body instead.
    assert "max_file_count" in body
    assert "id" not in body


async def test_token_without_asset_create_is_denied(client: httpx.AsyncClient) -> None:
    resp = await client.get(
        "/api/v1/assets/upload-policy", headers=auth_header("dev-auditor-token")
    )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["error"]["code"] == "PERMISSION_DENIED"
    assert body["error"]["trace_id"]

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"event_type": "PERMISSION_DENIED:ASSET_CREATE"},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200, audit_resp.text
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["resource_type"] == "ASSET" for e in events
    )


async def test_missing_policy_file_falls_back_to_safe_defaults(
    client: httpx.AsyncClient, tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(
        settings, "asset_upload_policy_path", tmp_path / "does-not-exist.json"
    )
    resp = await client.get("/api/v1/assets/upload-policy", headers=auth_header("dev-user-token"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Mirrors routers/assets.py's _DEFAULT_ASSET_UPLOAD_* constants.
    assert body["max_single_file_bytes"] == 50 * 1024 * 1024
    assert body["max_total_request_bytes"] == 150 * 1024 * 1024
    assert body["max_file_count"] == 20
    assert ".exe" in body["rejected_extensions"]
