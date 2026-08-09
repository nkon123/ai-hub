"""E2E-01 — Knowledge Service 정상 흐름 (06-quality-delivery.md §8).

This is the scenario the task brief specifically calls out as the one that
would have caught the 2026-08-06 chunking regression (a document collapsing
from 4 chunks to 1, silently breaking a real question) — so step 8/9 below
assert on real grounded answer content and a citation whose `section`
matches the uploaded document's actual heading, not merely that a 200 came
back.

Covered live, end-to-end, against real services:
  1. HR Knowledge Package 등록          -> POST /api/v1/assets (multipart)
     real indexing-runtime run: Ollama embedding + Chroma + BM25
  3/4. Service Composer 구성 + 검증     -> POST /api/v1/services,
     POST /api/v1/service-versions/{id}/validate (D-039: this schema +
     dependency + indexed + approved check on real DB rows IS this PoC's
     "Mock Test" gate — there is no separate Mock Test Job endpoint)
  5. 검토·승인                          -> real TECHNICAL/SECURITY/RELEASE
     review chain on the Knowledge AssetVersion
  6. Offline Bundle 생성                -> POST /api/v1/distributions,
     ASSET_VERSION root, against real distribution-service
  8/9. 질의 실행 + Citation 확인        -> POST /local/v1/runs against real
     agent-runtime -> real Ollama -> real search-runtime; asserts grounded
     answer text AND a citation whose `section` matches the uploaded doc
 10. Portal<->Runtime Trace 연결        -> a single caller-supplied trace id
     (`X-Trace-Id` header on portal-api, `trace_id` body field on
     agent-runtime) appears in both portal-api's audit trail and the run

Explicitly out of scope today (skipped with a named reason, not silently
dropped — see the two skip tests at the bottom):
  2. "Policy Agent와 Prompt 등록" — no Agent/Prompt Registry exists
     (open-decisions.md D-034); agent-runtime resolves agent/prompt from
     static local config copies, not Portal-registered assets.
  7. "Desktop Import/Preflight" — Electron cannot launch on this machine
     (macOS Gatekeeper quarantined the unsigned runtime this session).
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.e2e.conftest import (
    approve_asset_version,
    auth,
    build_service_definition,
    create_service,
    e2e_name,
    register_knowledge_asset,
    wait_for_distribution,
    wait_for_indexing_completed,
    wait_for_run_terminal,
)

pytestmark = pytest.mark.e2e

# Three distinct H2 sections -> parent_child chunking now splits at heading
# boundaries first (2026-08-07 regression fix), so this reliably produces
# one parent/child chunk per section regardless of total document size —
# see services/indexing-runtime/src/indexing_runtime/chunkers/parent_child.py.
DOC_CONTENT = """# E2E-01 사내 지원 정책 (테스트 픽스처)

## 재택근무 신청
재택근무는 부서장 승인을 받은 후 총무팀에 신청한다.

## 장비 지원
재택근무자에게는 모니터 1대와 키보드를 지급한다. 인터넷 요금은 지원하지 않는다.

## 근무 시간
재택근무 중에도 오전 10시부터 오후 4시까지는 코어타임으로 반드시 근무해야 한다.
"""


async def test_e2e_01_knowledge_service_happy_path(
    portal: httpx.AsyncClient, agent: httpx.AsyncClient
) -> None:
    trace_id = str(uuid.uuid4())
    trace_header = {"X-Trace-Id": trace_id}

    # --- Step 1: HR Knowledge Package 등록 (real upload -> real indexing) ---
    version = await register_knowledge_asset(
        portal,
        name=e2e_name("hr-policy"),
        markdown_content=DOC_CONTENT,
        extra_headers=trace_header,
    )
    assert version["status"] == "DRAFT"
    asset_id = version["asset_id"]
    version_id = version["id"]

    job = await wait_for_indexing_completed(portal, asset_id)
    assert job["status"] == "COMPLETED", f"indexing failed: {job}"
    assert job["chunk_count"] and job["chunk_count"] >= 3, job

    # --- Step 5: 검토·승인 (TECHNICAL -> SECURITY -> RELEASE) ---
    await approve_asset_version(portal, version_id)

    resp = await portal.get(f"/api/v1/assets/{asset_id}", headers=auth("CREATOR"))
    resp.raise_for_status()
    approved = next(v for v in resp.json()["versions"] if v["id"] == version_id)
    assert approved["status"] == "APPROVED", approved

    # --- Step 3/4: Service Composer 구성 + 게시-Gate 검증 (D-039 Mock Test) ---
    definition = build_service_definition(
        name=e2e_name("hr-service"), knowledge_version_id=version_id
    )
    service_version = await create_service(portal, definition)
    resp = await portal.post(
        f"/api/v1/service-versions/{service_version['id']}/validate", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    validation = resp.json()
    assert validation["passed"], validation["checks"]

    # --- Step 6: Offline Bundle 생성 (real distribution-service) ---
    resp = await portal.post(
        "/api/v1/distributions",
        json={"root_type": "ASSET_VERSION", "root_id": version_id, "mode": "OFFLINE_BUNDLE"},
        headers={**auth("CREATOR"), **trace_header},
    )
    assert resp.status_code == 202, resp.text
    distribution_id = resp.json()["id"]
    distribution = await wait_for_distribution(portal, distribution_id)
    assert distribution["status"] == "SUCCEEDED", distribution

    # --- Step 8/9: 질의 실행 + 기대 문서 Citation 확인 (real Ollama + search) ---
    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "e2e-01-hr-service",
            "trace_id": trace_id,
            "input": {"knowledge_id": version_id, "question": "장비 지원은 무엇이 있나요?"},
        },
    )
    assert resp.status_code == 202, resp.text
    created = resp.json()
    assert created["trace_id"] == trace_id
    run_id = created["id"]

    run = await wait_for_run_terminal(agent, run_id)
    assert run["status"] == "SUCCEEDED", run
    output = run["output"]
    assert output["answer"].strip(), "expected non-empty grounded answer"
    citations = output["citations"]
    assert citations, "expected at least one citation"
    assert any(c.get("section") == "장비 지원" for c in citations), citations

    # --- Step 10: Portal<->Runtime Trace 연결 (shared trace_id) ---
    resp = await portal.get(
        "/api/v1/audit-events", params={"resource_id": version_id}, headers=auth("AUDITOR")
    )
    resp.raise_for_status()
    audit_items = resp.json()["items"]
    assert any(e["trace_id"] == trace_id for e in audit_items), (
        "expected at least one portal-api audit event carrying the same trace_id "
        f"the run used: {audit_items}"
    )


def test_e2e_01_step2_agent_prompt_registry_not_implemented() -> None:
    pytest.skip(
        "E2E-01 step 2 (Policy Agent/Prompt 등록) is not implemented: there is no "
        "Agent/Prompt Registry (open-decisions.md D-034) — agent-runtime resolves "
        "agent/prompt from static local config copies "
        "(services/agent-runtime/config/standard-agent, standard-prompt), never from "
        "Portal-registered AGENT/PROMPT assets."
    )


def test_e2e_01_step7_desktop_import_not_available() -> None:
    pytest.skip(
        "E2E-01 step 7 (Desktop Import/Preflight) cannot run on this machine: Electron "
        "was quarantined by macOS Gatekeeper (unsigned runtime) this session — see "
        "open-decisions.md D-048 for the unrelated Windows code-signing gap this "
        "mirrors. Bundle Checksum verification logic itself IS covered without "
        "Electron in test_e2e_03_package_tamper.py."
    )
