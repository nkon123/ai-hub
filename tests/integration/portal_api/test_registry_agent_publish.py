"""D-034 — publish resolves a Registry Agent/Prompt into the revision snapshot.

`agent_ref`/`prompt_bindings` in a Service Definition carry *manifest* ids.
agent-runtime's `resolve_registry_agent_config` needs Portal **AssetVersion**
ids, so something has to bridge the two id spaces. Doing it at publish time
(here) rather than at chat time is what lets a published chatbot keep
answering with the exact Agent it was published with, and it is the same
discipline the knowledge list in that snapshot already follows.

The load-bearing test in this file is not the happy path — it is
`test_standard_agent_publish_is_unchanged`. Four chatbots are already
published against the two standard Agents, whose manifests exist only in
`services/agent-runtime/config/` and are not Portal assets at all. If this
resolution ever became mandatory, or a miss became an error, every one of
them would break on the next publish.
"""

from __future__ import annotations

import uuid

import httpx
from portal_api.models import Asset, AssetVersion
from sqlalchemy import select

from tests.integration.portal_api.conftest import (
    auth_header,
    build_service_definition,
    make_indexed_knowledge,
)

STANDARD_AGENT_MANIFEST_ID = "550e8400-e29b-41d4-a716-446655440010"


async def _register_asset(
    db, *, asset_type: str, manifest_id: str, version: str = "1.0.0", status: str = "APPROVED"
) -> AssetVersion:
    """Create an Asset + AssetVersion whose manifest declares `manifest_id`."""
    asset = Asset(
        id=str(uuid.uuid4()),
        type=asset_type,
        name=f"테스트 {asset_type}",
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
    )
    db.add(asset_version)
    await db.commit()
    return asset_version


async def _publish(
    client: httpx.AsyncClient, db, definition: dict, slug: str
) -> tuple[str, dict]:
    """Create → deploy → publish, returning (deployment_id, by-slug body)."""
    created = await client.post(
        "/api/v1/services",
        json={"name": "테스트 서비스", "service_definition": definition},
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

    by_slug = await client.get(f"/api/v1/deployments/by-slug/{slug}")
    assert by_slug.status_code == 200, by_slug.text
    return deployment_id, by_slug.json()


async def test_standard_agent_publish_is_unchanged(client: httpx.AsyncClient, db) -> None:
    """A Service Definition pointing at a standard Agent has no matching
    Portal asset — publish must succeed and report no Registry ids."""
    knowledge = await make_indexed_knowledge(db)
    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": STANDARD_AGENT_MANIFEST_ID, "version": "1.0.0"}

    _, body = await _publish(client, db, definition, "std-agent-bot")

    assert body["registry_agent_version_id"] is None
    assert body["registry_prompt_version_id"] is None
    # Everything the Hosted runtime already relied on still resolves.
    assert body["knowledge_id"] == knowledge.id
    assert body["model_alias"] == "default-chat"


async def test_registry_agent_and_prompt_are_resolved_into_the_snapshot(
    client: httpx.AsyncClient, db
) -> None:
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    agent_version = await _register_asset(
        db, asset_type="agent", manifest_id=agent_manifest_id
    )
    prompt_version = await _register_asset(
        db, asset_type="prompt", manifest_id=prompt_manifest_id
    )

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]

    _, body = await _publish(client, db, definition, "registry-agent-bot")

    assert body["registry_agent_version_id"] == agent_version.id
    assert body["registry_prompt_version_id"] == prompt_version.id


async def test_unapproved_agent_is_treated_as_not_registered(
    client: httpx.AsyncClient, db
) -> None:
    """A DRAFT Agent must not be shipped to the Hosted runtime. Falling back
    to "not a Registry asset" keeps publish working while making sure an
    unapproved Agent never answers a user."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    await _register_asset(
        db, asset_type="agent", manifest_id=agent_manifest_id, status="DRAFT"
    )
    await _register_asset(db, asset_type="prompt", manifest_id=prompt_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]

    _, body = await _publish(client, db, definition, "draft-agent-bot")

    assert body["registry_agent_version_id"] is None
    assert body["registry_prompt_version_id"] is None


async def test_half_a_pair_is_reported_as_neither(client: httpx.AsyncClient, db) -> None:
    """agent-runtime resolves an Agent+Prompt *pair*. A snapshot that matched
    only the Agent would make every message fail at chat time; reporting
    neither keeps the deployment on the standard Agent instead."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    await _register_asset(db, asset_type="agent", manifest_id=agent_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": str(uuid.uuid4()), "prompt_version": "1.0.0"}
    ]

    _, body = await _publish(client, db, definition, "half-pair-bot")

    assert body["registry_agent_version_id"] is None
    assert body["registry_prompt_version_id"] is None


async def test_version_mismatch_does_not_resolve(client: httpx.AsyncClient, db) -> None:
    """Matching the manifest id but not the version would ship a different
    Agent version than the Service Definition pinned."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    await _register_asset(
        db, asset_type="agent", manifest_id=agent_manifest_id, version="2.0.0"
    )
    await _register_asset(db, asset_type="prompt", manifest_id=prompt_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]

    _, body = await _publish(client, db, definition, "version-mismatch-bot")

    assert body["registry_agent_version_id"] is None


async def test_resolution_is_frozen_in_the_snapshot(client: httpx.AsyncClient, db) -> None:
    """§11.2: the snapshot is immutable. Retiring the Agent asset after
    publish must not change what the live deployment reports — the running
    chatbot keeps the Agent it was published with."""
    knowledge = await make_indexed_knowledge(db)
    agent_manifest_id = str(uuid.uuid4())
    prompt_manifest_id = str(uuid.uuid4())
    agent_version = await _register_asset(
        db, asset_type="agent", manifest_id=agent_manifest_id
    )
    await _register_asset(db, asset_type="prompt", manifest_id=prompt_manifest_id)

    definition = build_service_definition(knowledge)
    definition["agent_ref"] = {"id": agent_manifest_id, "version": "1.0.0"}
    definition["prompt_bindings"] = [
        {"role_id": "answerer", "prompt_id": prompt_manifest_id, "prompt_version": "1.0.0"}
    ]
    _, before = await _publish(client, db, definition, "frozen-agent-bot")
    assert before["registry_agent_version_id"] == agent_version.id

    stored = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == agent_version.id))
    ).scalar_one()
    stored.status = "RETIRED"
    await db.commit()

    after = await client.get("/api/v1/deployments/by-slug/frozen-agent-bot")
    assert after.status_code == 200
    assert after.json()["registry_agent_version_id"] == agent_version.id
