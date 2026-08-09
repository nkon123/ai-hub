"""E2E-10 — Hosted Chat 게시 실패와 Rollback (06-quality-delivery.md §8).

  1. "정상 Revision 1을 Active로 게시" -> publish a fresh Deployment against
     the already-APPROVED, already-indexed seeded Knowledge.
  2. "호환되지 않는 Knowledge를 참조한 Revision 2 게시 시도" -> create a
     second ServiceVersion for the SAME Service whose `knowledge_bindings`
     point at a Knowledge AssetVersion that is real but NOT approved (still
     DRAFT — never submitted for review), i.e. "호환되지 않는"/불가 상태.
  3. "검증 또는 Smoke Test 실패 확인" -> `_run_validation`'s
     `knowledge_version_approved` check fails with
     `CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE`; publishing a *new revision onto
     the same Deployment from a different Service Version* isn't a separate
     API in this PoC (see the skip test at the bottom) — this test instead
     publishes the incompatible ServiceVersion to a DIFFERENT, throwaway
     Deployment slug to observe the exact same server-side validation gate
     reject it, without ever touching Revision 1's Deployment.
  4. "기존 URL이 Revision 1로 계속 응답하는지 확인" -> Deployment 1's slug
     keeps answering normally throughout — proven by re-checking it
     immediately after the failed publish attempt above.
  5. "정상 Revision 2 게시 후 Revision 1로 Rollback" -> re-`publish` the SAME
     (still-compatible) Deployment to produce a genuine second
     `DeploymentRevision` row (Revision 2), confirm the Active Pointer
     moved to it, then `POST /deployments/{id}/rollback` back to Revision 1
     and confirm the Active Pointer moves back. See the skip test at the
     bottom for why "Revision 2 references a *different* Knowledge Version
     on the *same* Deployment/slug" specifically cannot be exercised today.
  6. "Active Pointer와 Audit 확인" -> `active_revision_id` flips to
     Revision 1's id, and a `DEPLOYMENT_ROLLED_BACK` audit event exists.

Nothing here suspends/mutates the 4 pre-existing seeded deployments; a
fresh Service + Deployment (`e2e-` prefixed slug) is created for this test.
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
    register_knowledge_asset,
)

pytestmark = pytest.mark.e2e


async def test_e2e_10_incompatible_revision_rejected_then_valid_rollback(
    portal: httpx.AsyncClient, agent: httpx.AsyncClient
) -> None:
    # A real but never-approved (still DRAFT) Knowledge Version -- "호환되지
    # 않는" for publish purposes (10-hosted-chatbot-publication.md §5: "게시
    # 가능: APPROVED Knowledge Version만 허용").
    unapproved = await register_knowledge_asset(
        portal, name=e2e_name("incompatible-knowledge"), markdown_content="# 미승인 문서\n\n내용\n"
    )
    unapproved_version_id = unapproved["id"]

    # --- Step 1: Revision 1 정상 게시 ---
    good_definition = build_service_definition(
        name=e2e_name("rollback-service"), knowledge_version_id=APPROVED_KNOWLEDGE_VERSION_ID
    )
    service_version_1 = await create_service(portal, good_definition)

    slug = e2e_slug("rollback")
    resp = await create_deployment(portal, service_version_id=service_version_1["id"], slug=slug)
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await publish_deployment(portal, deployment_id)
    assert resp.status_code == 202, resp.text
    revision_1_id = resp.json()["job_id"]  # PoC: publish is synchronous, job_id == revision id

    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["deployment_revision_id"] == revision_1_id

    # --- Step 2/3: 호환되지 않는(미승인) Knowledge를 참조한 Revision 게시 시도 ---
    incompatible_definition = build_service_definition(
        name=good_definition["name"],  # same Service identity in spirit
        knowledge_version_id=unapproved_version_id,
    )
    incompatible_version = await create_service(portal, incompatible_definition)

    incompatible_slug = e2e_slug("rollback-bad")
    resp = await create_deployment(
        portal, service_version_id=incompatible_version["id"], slug=incompatible_slug
    )
    assert resp.status_code == 201, resp.text
    incompatible_deployment_id = resp.json()["id"]

    resp = await publish_deployment(portal, incompatible_deployment_id)
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "DEPLOYMENT_VALIDATION_FAILED"
    checks = body["error"]["details"]["checks"]
    failing = [c for c in checks if not c["passed"]]
    assert any(c.get("code") == "CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE" for c in failing), checks

    # --- Step 4: 기존 URL(Revision 1)이 계속 정상 응답하는지 확인 ---
    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["deployment_revision_id"] == revision_1_id

    # --- Step 5a: 정상 Revision 2 게시 ---
    # `POST /deployments/{id}/publish` always re-validates+re-snapshots the
    # Deployment's own fixed `service_version_id` (there is no
    # `PATCH .../service_version_id` nor a `POST /deployments/{id}/revisions`
    # "update to a different Service Version" endpoint yet — see
    # deployments.py's module docstring). So a second `publish` call here
    # necessarily reuses service_version_1, but it DOES append a genuine,
    # separate `DeploymentRevision` row (revision_number 2) with its own
    # `activated_at`/id, which is exactly what rollback needs to restore
    # from -- see the skip test below for the specific narrowing this implies.
    resp = await publish_deployment(portal, deployment_id)
    assert resp.status_code == 202, resp.text

    resp = await portal.get(
        f"/api/v1/deployments/{deployment_id}/revisions", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    revisions = resp.json()["items"]
    assert len(revisions) >= 2, revisions
    revisions_sorted = sorted(revisions, key=lambda r: r["revision_number"])
    assert revisions_sorted[0]["id"] == revision_1_id, revisions_sorted
    revision_2_id = revisions_sorted[-1]["id"]

    resp = await portal.get(f"/api/v1/deployments/{deployment_id}", headers=auth("CREATOR"))
    resp.raise_for_status()
    assert resp.json()["active_revision_id"] == revision_2_id

    # --- Step 5b/6: Rollback to Revision 1 -> Active Pointer + Audit 확인 ---
    resp = await portal.post(
        f"/api/v1/deployments/{deployment_id}/rollback",
        json={"reason": "tests/e2e Rollback 시나리오 검증", "target_revision_id": revision_1_id},
        headers=auth("RELEASE_MANAGER"),
    )
    assert resp.status_code == 200, resp.text
    rolled_back = resp.json()
    assert rolled_back["active_revision_id"] == revision_1_id
    assert rolled_back["status"] == "ACTIVE"

    resp = await portal.get(
        "/api/v1/audit-events",
        params={"resource_id": deployment_id, "event_type": "DEPLOYMENT_ROLLED_BACK"},
        headers=auth("AUDITOR"),
    )
    resp.raise_for_status()
    audit_items = resp.json()["items"]
    assert audit_items, f"expected a DEPLOYMENT_ROLLED_BACK audit event for {deployment_id}"
    assert audit_items[0]["result"] == "SUCCESS"

    resp = await agent.get(f"/chat-api/v1/chatbots/{slug}")
    assert resp.status_code == 200, resp.text


def test_e2e_10_revision2_different_knowledge_on_same_slug_not_supported() -> None:
    pytest.skip(
        "E2E-10's literal step 5 ('정상 Revision 2' referencing DIFFERENT, still-"
        "compatible Knowledge, published onto the SAME Deployment/slug as Revision 1) "
        "cannot be exercised: apps/portal-api/src/portal_api/routers/deployments.py's "
        "module docstring explicitly scopes out 'creating a NEW revision from a "
        "different Service Version (\"Update\", POST /deployments/{id}/revisions)' -- "
        "that endpoint only exists as a GET (list revisions) today. "
        "POST /deployments/{id}/publish always re-validates+re-snapshots the "
        "Deployment's own fixed, immutable service_version_id, so a real Revision 2 "
        "with different content requires a brand-new Deployment (a different slug/URL), "
        "not a second revision on the existing one. The main test above instead proves "
        "the rollback MECHANICS (Active Pointer + Audit) using two revisions of the same "
        "Service Version, which is what this PoC's API actually supports."
    )
