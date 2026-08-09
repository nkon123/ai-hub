"""Integration tests for P13 다운로드 이력 —
`GET /api/v1/distributions/download-history` (`routers/distributions.py::
list_download_history`).

Covers: own-history-only scoping for a plain requester, AUDITOR/ADMIN seeing
everything, a cross-user `actor_id`/`organization_id` request being denied
(and audited, like every other denial in this router), the empty state,
mode/outcome filters, and — the field the spec calls out explicitly — that a
row predating Client IP capture renders that field as unavailable (`None`,
rendered "미기재" by the UI) rather than a fabricated value.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from portal_api.auth import _TEST_TOKENS, UserContext
from portal_api.main import app
from portal_api.models import AuditEvent, DistributionRequest
from portal_api.routers.distributions import get_distribution_caller, get_session_factory

from tests.integration.portal_api.conftest import auth_header, make_indexed_knowledge

HISTORY_URL = "/api/v1/distributions/download-history"


@pytest.fixture(autouse=True)
def override_session_factory(session_factory):
    """Same rationale as `test_distributions.py`'s fixture of the same name
    — `_run_bundle_job` opens its own DB session after the request's
    `Depends(get_db)` session has already closed, so it must be pointed at
    this test's isolated in-memory engine too."""
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    yield
    app.dependency_overrides.pop(get_session_factory, None)


@pytest.fixture
def fake_bundle_result(tmp_path):
    bundle_file = tmp_path / "bundle.zip"
    bundle_file.write_bytes(b"PK\x03\x04fake-zip-content")
    return {
        "status": "SUCCEEDED",
        "stage": "SUCCEEDED",
        "bundle_object_id": "11111111-1111-1111-1111-111111111111",
        "bundle_path": str(bundle_file),
        "bundle_size_bytes": bundle_file.stat().st_size,
        "checksum": "deadbeef",
        "manifest_summary": {"bundle_id": "b1", "included": [], "install_order": []},
    }


@pytest.fixture
def override_distribution_caller(fake_bundle_result):
    async def _fake_caller(payload: dict) -> dict:
        return fake_bundle_result

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_distribution_caller, None)


async def _create_and_download(
    client: httpx.AsyncClient, db, *, token: str, download_as: str | None = None
) -> tuple[str, httpx.Response]:
    """Creates an OFFLINE_BUNDLE distribution (root = a fresh indexed
    Knowledge version) as `token`, then downloads it as `download_as`
    (defaults to the same `token`). Returns (distribution_id, download
    response) so callers can assert on either the SUCCESS or the
    cross-user-DENIED path."""
    knowledge = await make_indexed_knowledge(db)
    create_resp = await client.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": knowledge.id, "mode": "OFFLINE_BUNDLE"},
        headers=auth_header(token),
    )
    assert create_resp.status_code == 202, create_resp.text
    distribution_id = create_resp.json()["id"]

    download_resp = await client.get(
        f"/api/v1/distributions/{distribution_id}/download",
        headers=auth_header(download_as or token),
    )
    return distribution_id, download_resp


# --- Own-history scoping ---


async def test_download_history_scopes_to_own_actions_for_regular_user(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    user_dist_id, user_dl_resp = await _create_and_download(client, db, token="dev-user-token")
    assert user_dl_resp.status_code == 200

    admin_dist_id, admin_dl_resp = await _create_and_download(client, db, token="dev-admin-token")
    assert admin_dl_resp.status_code == 200

    resp = await client.get(HISTORY_URL, headers=auth_header("dev-user-token"))
    assert resp.status_code == 200
    body = resp.json()

    distribution_ids = {item["distribution_id"] for item in body["items"]}
    assert user_dist_id in distribution_ids
    assert admin_dist_id not in distribution_ids
    assert all(item["user"] == "dev-user@miracom.com" for item in body["items"])
    # One BUNDLE_REQUEST row + one DOWNLOAD row for the user's own action.
    kinds = {item["kind"] for item in body["items"]}
    assert kinds == {"BUNDLE_REQUEST", "DOWNLOAD"}


async def test_download_history_auditor_and_admin_see_everything(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    user_dist_id, _ = await _create_and_download(client, db, token="dev-user-token")
    admin_dist_id, _ = await _create_and_download(client, db, token="dev-admin-token")

    for token in ("dev-auditor-token", "dev-admin-token"):
        resp = await client.get(HISTORY_URL, headers=auth_header(token))
        assert resp.status_code == 200
        distribution_ids = {item["distribution_id"] for item in resp.json()["items"]}
        assert user_dist_id in distribution_ids
        assert admin_dist_id in distribution_ids


# --- Cross-user request denied + audited ---


async def test_download_history_cross_user_actor_id_is_denied_and_audited(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    await _create_and_download(client, db, token="dev-user-token")

    resp = await client.get(
        HISTORY_URL,
        params={"actor_id": "admin@miracom.com"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_resp = await client.get(
        "/api/v1/audit-events",
        params={"event_type": "PERMISSION_DENIED:DOWNLOAD_HISTORY_SCOPE"},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit_resp.status_code == 200
    events = audit_resp.json()["items"]
    assert any(
        e["result"] == "DENIED" and e["actor_id"] == "dev-user@miracom.com" for e in events
    )


async def test_download_history_cross_user_organization_id_is_denied(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get(
        HISTORY_URL,
        params={"organization_id": "some-other-org"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_download_history_denied_for_role_without_download_read(
    client: httpx.AsyncClient,
) -> None:
    # TECH_REVIEWER lacks DOWNLOAD_READ (security_policy.roles.ROLE_PERMISSIONS).
    resp = await client.get(HISTORY_URL, headers=auth_header("dev-reviewer-token"))
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"


# --- Own denied download attempt still shows up in the actor's own history ---


@pytest.fixture
def second_creator_token():
    """DOWNLOAD_READ is granted to CREATOR/USER/AUDITOR/ADMIN only
    (`security_policy.roles.ROLE_PERMISSIONS`) — the only dev token that
    lands on the *ownership-scope* 403 (`PERMISSION_DENIED:
    DISTRIBUTION_DOWNLOAD_SCOPE`) rather than the generic "role altogether
    lacks DOWNLOAD_READ" 403 is another CREATOR, and the fixed Test Identity
    Adapter (D-001 PoC) only defines one. Temporarily register a second
    CREATOR identity for this test only, reverted in the fixture teardown —
    this exercises the real ownership check the router runs on
    `download_distribution`, not a token-selection artifact."""
    token = "dev-user2-token-test-only"
    _TEST_TOKENS[token] = UserContext(
        user_id="dev-user-2@miracom.com",
        org="miracom",
        site="headquarters",
        role="CREATOR",
        display_name="개발자2(테스트 전용)",
    )
    yield token
    del _TEST_TOKENS[token]


async def test_own_denied_download_attempt_appears_with_denied_outcome(
    client: httpx.AsyncClient, db, override_distribution_caller, second_creator_token
) -> None:
    """A cross-user download attempt is denied (existing
    DISTRIBUTION_DOWNLOAD_SCOPE behaviour) — but it is still *the acting
    user's own action*, so it must show up in *their* history as a denied
    download, Client IP included (captured inside `download_distribution`,
    same as the success path)."""
    dist_id, dl_resp = await _create_and_download(
        client, db, token="dev-user-token", download_as=second_creator_token
    )
    assert dl_resp.status_code == 403
    assert dl_resp.json()["error"]["code"] == "PERMISSION_DENIED"

    resp = await client.get(HISTORY_URL, headers=auth_header(second_creator_token))
    assert resp.status_code == 200
    items = resp.json()["items"]
    denied = [i for i in items if i["distribution_id"] == dist_id and i["kind"] == "DOWNLOAD"]
    assert len(denied) == 1
    assert denied[0]["outcome"] == "DENIED"
    assert denied[0]["user"] == "dev-user-2@miracom.com"
    assert denied[0]["reason"]
    # httpx.ASGITransport's default synthetic client is 127.0.0.1 — this
    # confirms the capture path actually ran on a denial, not just success.
    assert denied[0]["client_ip"] == "127.0.0.1"


# --- Empty state ---


async def test_download_history_empty_state(client: httpx.AsyncClient) -> None:
    resp = await client.get(HISTORY_URL, headers=auth_header("dev-user-token"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"] == []
    assert body["total"] == 0


# --- Filters ---


async def test_download_history_filters_by_mode_and_outcome(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    dist_id, dl_resp = await _create_and_download(client, db, token="dev-user-token")
    assert dl_resp.status_code == 200

    ok_resp = await client.get(
        HISTORY_URL,
        params={"mode": "OFFLINE_BUNDLE", "outcome": "SUCCESS"},
        headers=auth_header("dev-user-token"),
    )
    assert ok_resp.status_code == 200
    assert dist_id in {i["distribution_id"] for i in ok_resp.json()["items"]}

    mismatched_resp = await client.get(
        HISTORY_URL,
        params={"outcome": "FAILURE"},
        headers=auth_header("dev-user-token"),
    )
    assert mismatched_resp.status_code == 200
    assert dist_id not in {i["distribution_id"] for i in mismatched_resp.json()["items"]}


async def test_download_history_filters_by_date_range(
    client: httpx.AsyncClient, db
) -> None:
    old_row = DistributionRequest(
        root_type="ASSET_VERSION",
        root_id="00000000-0000-0000-0000-000000000000",
        mode="OFFLINE_BUNDLE",
        requested_by="dev-user@miracom.com",
        status="SUCCEEDED",
        stage="SUCCEEDED",
        created_at=datetime(2020, 1, 1, tzinfo=UTC),
        updated_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    db.add(old_row)
    await db.commit()

    resp = await client.get(
        HISTORY_URL,
        params={"from": "2025-01-01T00:00:00Z"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 200
    assert old_row.id not in {i["distribution_id"] for i in resp.json()["items"]}

    resp_all = await client.get(
        HISTORY_URL,
        params={"to": "2025-01-01T00:00:00Z"},
        headers=auth_header("dev-user-token"),
    )
    assert resp_all.status_code == 200
    assert old_row.id in {i["distribution_id"] for i in resp_all.json()["items"]}


# --- Never fabricate: legacy rows without Client IP render as unavailable ---


async def test_legacy_download_event_without_client_ip_renders_as_unavailable(
    client: httpx.AsyncClient, db
) -> None:
    """Simulates an audit row written before Client IP capture existed:
    `metadata` has no `client_ip` key at all. The response must show `None`
    (→ UI "미기재"), never an empty string or a fabricated address."""
    dist = DistributionRequest(
        root_type="ASSET_VERSION",
        root_id="00000000-0000-0000-0000-000000000000",
        mode="OFFLINE_BUNDLE",
        requested_by="dev-user@miracom.com",
        status="SUCCEEDED",
        stage="SUCCEEDED",
        bundle_path="/tmp/does-not-matter.zip",
    )
    db.add(dist)
    await db.flush()

    legacy_event = AuditEvent(
        event_type="BUNDLE_DOWNLOADED",
        actor_type="USER",
        actor_id="dev-user@miracom.com",
        organization_id="miracom",
        site_id="headquarters",
        resource_type="DISTRIBUTION",
        resource_id=dist.id,
        result="SUCCESS",
        trace_id="legacy-trace",
        metadata_={"bundle_size_bytes": 999},  # no "client_ip" key — pre-dates this feature
    )
    db.add(legacy_event)
    await db.commit()

    resp = await client.get(HISTORY_URL, headers=auth_header("dev-user-token"))
    assert resp.status_code == 200
    items = [i for i in resp.json()["items"] if i["distribution_id"] == dist.id]
    download_rows = [i for i in items if i["kind"] == "DOWNLOAD"]
    assert len(download_rows) == 1
    assert download_rows[0]["client_ip"] is None
