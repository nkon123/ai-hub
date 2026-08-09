"""E2E-08 — Revocation (06-quality-delivery.md §8).

Builds and publishes its OWN fresh Deployment (never suspends/resumes any
of the 4 pre-existing seeded deployments — `remote-work-guide`, `langchain`,
`remote-work-approved`, `unapproved-test` — per the task's data-hygiene
rule) against the already-APPROVED, already-indexed seeded Knowledge.

  1. "Service Version 승인·설치" -> create Service + Deployment + publish
     (Version approval already exists on the seeded Knowledge; "설치" is a
     Desktop-side concept, not applicable to this Hosted-chat-shaped
     scenario — see 10-hosted-chatbot-publication.md for why URL 게시 and
     Desktop 설치 are two different Deployment Targets).
  2. "Portal에서 Suspended" -> POST /deployments/{id}/suspend (RELEASE_MANAGER).
  3. "신규 Bundle 생성 차단" -> not applicable to Hosted Chat Deployments
     (Bundle generation targets ASSET_VERSION/SERVICE_VERSION roots, not a
     Deployment id — see 07-data-api-contracts.md §3.8); the task brief's
     concrete acceptance bar for this scenario is instead the chat-facing
     revocation check in step 4 below.
  4. "Online Policy Hook ... 적용 후 실행 차단" -> the task brief's own
     acceptance bar: `GET /chat-api/v1/chatbots/{slug}` on agent-runtime
     becomes 404 the instant the Deployment is suspended, then 200 again
     after resume — verified live against the real chat-facing endpoint,
     not just the Portal-side status flag.
"""

from __future__ import annotations

import httpx
import pytest

from tests.e2e.conftest import (
    APPROVED_KNOWLEDGE_VERSION_ID,
    auth,
    build_service_definition,
    create_deployment,
    create_service,
    e2e_name,
    e2e_slug,
    publish_deployment,
)

pytestmark = pytest.mark.e2e


async def test_e2e_08_suspend_blocks_chat_access_then_resume_restores_it(
    portal: httpx.AsyncClient, agent: httpx.AsyncClient
) -> None:
    definition = build_service_definition(
        name=e2e_name("revocation-service"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version = await create_service(portal, definition)

    slug = e2e_slug("revocation")
    resp = await create_deployment(portal, service_version_id=service_version["id"], slug=slug)
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await publish_deployment(portal, deployment_id)
    assert resp.status_code == 202, resp.text

    # Step 1 (own Deployment only): the freshly published slug resolves and
    # answers on the real, unauthenticated agent-runtime chat-facing endpoint.
    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text

    # Step 2: Suspend via Portal (RELEASE_MANAGER, confirmation + reason required).
    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/suspend",
        json={"reason": "tests/e2e Revocation 시나리오 검증"},
        headers=auth("RELEASE_MANAGER"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "SUSPENDED"

    # Step 4: revocation must be visible from the CHAT-FACING side immediately.
    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"

    # A new chat session must also be refused while suspended.
    resp = await agent.post("/chat-api/v1/sessions", json={"slug": slug})
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "DEPLOYMENT_NOT_ACTIVE"

    # Resume -> access restored.
    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/resume", headers=auth("RELEASE_MANAGER")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ACTIVE"

    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text


def test_e2e_08_step3_new_bundle_generation_block_not_applicable() -> None:
    pytest.skip(
        "E2E-08 step 3 (신규 Bundle 생성 차단) does not map onto this Hosted-chat "
        "Deployment shape: POST /api/v1/distributions builds bundles from an "
        "ASSET_VERSION or SERVICE_VERSION root (07-data-api-contracts.md §3.8), not "
        "from a ServiceDeployment id -- suspending a Deployment has no distinct "
        "'block new bundle' state to observe separately from the Knowledge/Service "
        "Version's own APPROVED/SUSPENDED status, which is covered by "
        "test_e2e_05_permission_denied.py and the review-lifecycle assertions in "
        "test_e2e_01_knowledge_service.py."
    )
