"""D-034 follow-up (2026-08-17): Offline Bundle plans must reflect the
Registry Agent/Prompt a Service Version was actually published with, not a
hardcoded "Standard Knowledge Chat Agent" literal.

`test_service_version_happy_path_uses_published_snapshot` (test_
distributions.py) is the regression guard for the *unchanged* path (no
registry_agent/registry_prompt in the snapshot — every already-published
demo chatbot). This file covers the *new* path: a Service Version published
against a Registry Agent+Prompt pair.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from portal_api.main import app
from portal_api.models import Asset, AssetVersion, DeploymentRevision
from portal_api.routers.distributions import get_distribution_caller, get_session_factory
from sqlalchemy import select

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_indexed_knowledge,
)


@pytest.fixture(autouse=True)
def override_session_factory(session_factory):
    """See test_distributions.py's identical fixture docstring —
    `_run_bundle_job` opens its own session after the request's has closed."""
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    yield
    app.dependency_overrides.pop(get_session_factory, None)


@pytest.fixture
def override_distribution_caller():
    """Fakes distribution-service's response so these tests never depend on
    a real process listening on :8400 — same shape as test_distributions.py."""
    calls: list[dict] = []
    fake_result = {
        "status": "SUCCEEDED",
        "stage": "SUCCEEDED",
        "bundle_object_id": "11111111-1111-1111-1111-111111111111",
        "bundle_path": "/tmp/fake-bundle.zip",
        "bundle_size_bytes": 12345,
        "checksum": "deadbeef",
        "manifest_summary": {"bundle_id": "b1", "included": [], "install_order": ["knowledge"]},
    }

    async def _fake_caller(payload: dict) -> dict:
        calls.append(payload)
        return fake_result

    app.dependency_overrides[get_distribution_caller] = lambda: _fake_caller
    yield calls
    app.dependency_overrides.pop(get_distribution_caller, None)


async def _register_asset(
    db,
    *,
    asset_type: str,
    manifest_id: str,
    version: str = "1.0.0",
    status: str = "APPROVED",
    manifest_hash: str | None = "deadbeef" * 8,
) -> AssetVersion:
    asset = Asset(
        id=str(uuid.uuid4()),
        type=asset_type,
        name=f"실제 {asset_type} 자산",
        owner_org="miracom",
        owner_creator_id="dev-user@miracom.com",
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()
    asset_version = AssetVersion(
        id=str(uuid.uuid4()),
        asset_id=asset.id,
        version=version,
        status=status,
        manifest={"id": manifest_id, "type": asset_type, "version": version, "name": asset.name},
        manifest_hash=manifest_hash,
    )
    db.add(asset_version)
    await db.commit()
    return asset_version


async def _publish(client: httpx.AsyncClient, db, definition: dict, slug: str) -> str:
    created = await client.post(
        "/api/v1/services",
        json={"name": "Registry Agent 테스트 서비스", "service_definition": definition},
        headers=auth_header(),
    )
    assert created.status_code == 201, created.text
    version_id = created.json()["id"]

    deployment = await client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": version_id,
            "slug": slug,
            "environment": "internal",
            "access_policy": "INTERNAL_AUTHENTICATED",
        },
        headers=auth_header(),
    )
    assert deployment.status_code == 201, deployment.text
    deployment_id = deployment.json()["id"]

    published = await client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header("dev-release-token")
    )
    assert published.status_code == 202, published.text
    return version_id


async def test_registry_agent_bundle_carries_the_actual_asset(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    """Both Agent and Prompt resolved at publish time -> the plan item must
    name the real asset, carry its manifest/manifest_hash, and must NOT be
    STANDARD_LOCAL_COPY."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    agent_version = await _register_asset(db, asset_type="agent", manifest_id=agent_manifest_id)
    prompt_version = await _register_asset(
        db, asset_type="prompt", manifest_id=prompt_manifest_id
    )

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]
    service_version_id = await _publish(client, db, definition, "registry-bundle-bot")

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 202, resp.text

    sent_payload = override_distribution_caller[0]
    agent_item = next(i for i in sent_payload["items"] if i["role"] == "agent")
    prompt_item = next(i for i in sent_payload["items"] if i["role"] == "prompt")

    assert agent_item["status"] != "STANDARD_LOCAL_COPY"
    assert agent_item["status"] == "APPROVED"
    assert agent_item["asset_version_id"] == agent_version.id
    assert agent_item["asset_name"] == "실제 agent 자산"
    assert agent_item["manifest"] is not None
    assert agent_item["manifest_hash"] == "deadbeef" * 8

    assert prompt_item["status"] != "STANDARD_LOCAL_COPY"
    assert prompt_item["status"] == "APPROVED"
    assert prompt_item["asset_version_id"] == prompt_version.id
    assert prompt_item["asset_name"] == "실제 prompt 자산"
    assert prompt_item["manifest"] is not None
    assert prompt_item["manifest_hash"] == "deadbeef" * 8


async def test_half_a_pair_bundles_both_as_standard(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    """Only the Agent resolves as a Registry asset at publish time (Prompt
    id has no match) -> by-slug already reports neither as registered
    (see test_registry_agent_publish.py::test_half_a_pair_is_reported_as_
    neither). The bundle must not create a mixed plan where one side is a
    real asset and the other is the standard fallback."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    await _register_asset(db, asset_type="agent", manifest_id=agent_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": str(uuid.uuid4()), "prompt_version": "1.0.0"}
    ]
    service_version_id = await _publish(client, db, definition, "half-pair-bundle-bot")

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 202, resp.text

    sent_payload = override_distribution_caller[0]
    agent_item = next(i for i in sent_payload["items"] if i["role"] == "agent")
    prompt_item = next(i for i in sent_payload["items"] if i["role"] == "prompt")

    assert agent_item["status"] == "STANDARD_LOCAL_COPY"
    assert prompt_item["status"] == "STANDARD_LOCAL_COPY"
    assert agent_item["asset_name"] == "Standard Knowledge Chat Agent"
    assert prompt_item["asset_name"] == "Standard Knowledge Answer Prompt"


async def test_deleted_registry_asset_version_fails_closed_not_silently(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    """The published snapshot names an AssetVersion id that no longer
    exists in the Registry by the time the bundle is requested (e.g. hard
    deleted out-of-band). The plan must mark it NOT_FOUND (which
    distribution-service's resolver turns into DEPENDENCY_MISSING) rather
    than silently substituting the standard copy — substituting would
    reintroduce exactly the "bundle doesn't match what the screen said"
    defect this change fixes."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    agent_version = await _register_asset(db, asset_type="agent", manifest_id=agent_manifest_id)
    await _register_asset(db, asset_type="prompt", manifest_id=prompt_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]
    service_version_id = await _publish(client, db, definition, "deleted-agent-bundle-bot")

    # Simulate the AssetVersion row disappearing after publish without
    # touching the frozen snapshot itself (§11.2 immutability) — delete only
    # the row `_registry_item` will look up.
    stored_agent = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == agent_version.id))
    ).scalar_one()
    await db.delete(stored_agent)
    await db.commit()

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 202, resp.text

    sent_payload = override_distribution_caller[0]
    agent_item = next(i for i in sent_payload["items"] if i["role"] == "agent")
    assert agent_item["status"] == "NOT_FOUND"
    assert agent_item["status"] != "STANDARD_LOCAL_COPY"


async def test_registry_items_participate_in_download_history_manifest_shape(
    client: httpx.AsyncClient, db, override_distribution_caller
) -> None:
    """Sanity check that the snapshot lookup doesn't depend on iteration
    order of `resolved_dependency_snapshot` — reread the persisted
    DeploymentRevision directly to confirm the ids the plan used really do
    come from the frozen snapshot, not a live re-query of "current
    APPROVED"."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    agent_version = await _register_asset(db, asset_type="agent", manifest_id=agent_manifest_id)
    prompt_version = await _register_asset(
        db, asset_type="prompt", manifest_id=prompt_manifest_id
    )

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]
    service_version_id = await _publish(client, db, definition, "snapshot-shape-bot")

    revision = (
        await db.execute(
            select(DeploymentRevision).where(
                DeploymentRevision.service_version_id == service_version_id
            )
        )
    ).scalar_one()
    assert revision.resolved_dependency_snapshot["registry_agent"]["asset_version_id"] == (
        agent_version.id
    )
    assert revision.resolved_dependency_snapshot["registry_prompt"]["asset_version_id"] == (
        prompt_version.id
    )

    resp = await client.post(
        "/api/v1/distributions",
        json={
            "root_type": "SERVICE_VERSION",
            "root_id": service_version_id,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 202, resp.text
    sent_payload = override_distribution_caller[0]
    agent_item = next(i for i in sent_payload["items"] if i["role"] == "agent")
    assert agent_item["asset_version_id"] == agent_version.id
