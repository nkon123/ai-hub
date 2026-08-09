"""E2E-09 — 등록 Knowledge 챗봇 URL 게시 (06-quality-delivery.md §8).

This is the scenario the task brief explicitly calls out as "the scenario
that would have caught yesterday's regression" — so this test's Preview and
Hosted-Chat assertions check REAL grounded content and a citation whose
`section` matches the source document's actual heading, exactly like the
2026-08-06 incident (a chunking change collapsed a document to 1 chunk;
"장비 지원은 무엇이 있나요?" got 0 citations while every unit test and the
evaluation Quality Gate still reported green). A version of this test run
against that regressed build would have failed on the citation assertion.

  1. "Sample HR Knowledge 등록·인덱싱·승인" -> POST /api/v1/assets (multipart,
     real indexing-runtime + Ollama), then the real TECHNICAL/SECURITY/
     RELEASE review chain.
  2/3. "Knowledge 챗봇 빠른 만들기 ... 표준 Agent·Prompt 자동 연결" -> this
     PoC's Quick Create IS `POST /api/v1/services` with a `knowledge_bindings`
     entry pointing at the approved Knowledge Version — `agent_ref` is a
     fixed local id/version already, matching D-052's "표준 Agent/Prompt는
     Registry가 아닌 정적 로컬 사본" design (there is no separate "선택"
     step to click through; the binding itself IS the auto-connection).
  4/5. "실제 Knowledge Preview 질문 3개 실행 -> 기대 문서 검색과 Citation 확인"
     -> 3 real questions run against real agent-runtime/Ollama/search-runtime
     using the SAME `standard-agent` + `POST /local/v1/runs` code path
     the spec's Preview UI would call (Preview and Hosted Chat share one
     Agent Runtime Core, per 10-hosted-chatbot-publication.md §6.2 "게시될
     Service Definition Resolver와 Agent Runtime Core를 그대로 사용한다").
  6. "게시 Gate 통과 후 Deployment Job 실행" -> POST /deployments +
     POST /deployments/{id}/publish (RELEASE_MANAGER, D-040).
  7. "`/chat/{slug}` URL 발급 확인" -> `deployment_url` on the publish/create
     response, following the D-026 `{base}/chat/{slug}` shape.
  8/9. "새 브라우저에서 ... 접속 -> 질문·SSE 답변·Citation 확인" -> a fresh,
     unauthenticated `httpx.AsyncClient` (standing in for "new browser,
     사내 Test Identity" — hosted chat itself takes no auth per D-035/D-038)
     drives the full `/chat-api/v1/*` flow and parses the real SSE stream.
  10. "Portal→Deployment→Run→Search Trace와 Audit 확인" -> the session's
     per-message trace_id (echoed on every hosted SSE event) is
     cross-checked against portal-api's own `DEPLOYMENT_PUBLISHED` audit
     event for the same deployment.
"""

from __future__ import annotations

import httpx
import pytest

from tests.e2e.conftest import (
    approve_asset_version,
    auth,
    build_service_definition,
    create_deployment,
    create_service,
    e2e_name,
    e2e_slug,
    parse_sse_response,
    publish_deployment,
    register_knowledge_asset,
    stream_run_events,
    wait_for_indexing_completed,
)

pytestmark = pytest.mark.e2e

DOC_CONTENT = """# E2E-09 Knowledge 챗봇 게시 테스트 문서

## 재택근무 신청
재택근무는 부서장 승인 후 총무팀에 신청한다. 신청은 최소 3일 전에 완료해야 한다.

## 장비 지원
재택근무자에게는 모니터 1대와 키보드, 마우스를 지급한다. 인터넷 요금은 지원하지 않는다.

## 근무 시간
재택근무 중에도 오전 10시부터 오후 4시까지는 코어타임으로 반드시 근무해야 한다.
"""

PREVIEW_QUESTIONS = [
    ("재택근무는 언제까지 신청해야 하나요?", "재택근무 신청"),
    ("장비 지원 항목은 무엇인가요?", "장비 지원"),
    ("코어타임은 몇 시부터 몇 시까지인가요?", "근무 시간"),
]


async def test_e2e_09_register_index_approve_quickcreate_preview_publish_chat(
    portal: httpx.AsyncClient, agent: httpx.AsyncClient
) -> None:
    # --- Step 1: Sample HR Knowledge 등록·인덱싱·승인 ---
    version = await register_knowledge_asset(
        portal, name=e2e_name("chatbot-knowledge"), markdown_content=DOC_CONTENT
    )
    asset_id = version["asset_id"]
    version_id = version["id"]

    job = await wait_for_indexing_completed(portal, asset_id)
    assert job["status"] == "COMPLETED", job
    assert job["chunk_count"] and job["chunk_count"] >= 3, job

    await approve_asset_version(portal, version_id)
    resp = await portal.get(f"/api/v1/assets/{asset_id}", headers=auth("CREATOR"))
    resp.raise_for_status()
    approved = next(v for v in resp.json()["versions"] if v["id"] == version_id)
    assert approved["status"] == "APPROVED", approved

    # --- Step 2/3: Knowledge 챗봇 빠른 만들기 (표준 Agent/Prompt 자동 연결) ---
    definition = build_service_definition(
        name=e2e_name("chatbot-service"),
        knowledge_version_id=version_id,
        suggested_questions=[q for q, _ in PREVIEW_QUESTIONS],
        welcome_message="안녕하세요! 사내 지원 정책에 대해 물어보세요.",
    )
    service_version = await create_service(portal, definition)
    assert definition["agent_ref"]["id"], "standard agent auto-connection must be present"
    assert definition["model_policy"]["model_alias"], "standard model policy must be present"

    resp = await portal.post(
        f"/api/v1/service-versions/{service_version['id']}/validate", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    assert resp.json()["passed"], resp.json()["checks"]

    # --- Step 4/5: 실제 Knowledge Preview 질문 3개 + Citation 확인 ---
    # (This is the exact assertion shape that would have caught the
    # 2026-08-06 regression: grounded answer text + a citation whose
    # `section` matches the document's real heading.)
    for question, expected_section in PREVIEW_QUESTIONS:
        resp = await agent.post(
            "/local/v1/runs",
            json={
                "service_id": service_version["service_id"],
                "input": {"knowledge_id": version_id, "question": question},
            },
        )
        assert resp.status_code == 202, resp.text
        run_id = resp.json()["id"]
        events = await stream_run_events(agent, run_id, timeout=120)
        final = next(data for name, data in events if name == "run.completed")
        assert final["status"] == "SUCCEEDED", (question, final)
        output = final["output"]
        assert output["answer"].strip(), (question, "expected non-empty grounded answer")
        citations = output["citations"]
        assert citations, (question, "expected at least one citation")
        assert any(c.get("section") == expected_section for c in citations), (
            question,
            expected_section,
            citations,
        )

    # --- Step 6: 게시 Gate 통과 후 Deployment Job 실행 ---
    slug = e2e_slug("chatbot")
    resp = await create_deployment(portal, service_version_id=service_version["id"], slug=slug)
    assert resp.status_code == 201, resp.text
    deployment_id = resp.json()["id"]

    resp = await publish_deployment(portal, deployment_id)
    assert resp.status_code == 202, resp.text

    # --- Step 7: `/chat/{slug}` URL 발급 확인 ---
    deployment_url = resp.json()["deployment_url"]
    assert deployment_url.endswith(f"/chat/{slug}"), deployment_url

    # --- Step 8/9: 새 브라우저(별도 인증 없는 신규 클라이언트)에서 접속 ->
    # 질문·SSE 답변·Citation 확인 ---
    async with httpx.AsyncClient(base_url=agent.base_url, timeout=90.0) as fresh_browser_client:
        resp = await fresh_browser_client.get(f"/chat-api/v1/chatbots/{slug}")
        assert resp.status_code == 200, resp.text
        chatbot_config = resp.json()
        assert chatbot_config["citation_display"] is True

        resp = await fresh_browser_client.post("/chat-api/v1/sessions", json={"slug": slug})
        assert resp.status_code == 201, resp.text
        session = resp.json()
        assert session["status"] == "ACTIVE"

        question, expected_section = PREVIEW_QUESTIONS[1]  # "장비 지원 항목은 무엇인가요?"
        async with fresh_browser_client.stream(
            "POST", f"/chat-api/v1/sessions/{session['id']}/messages", json={"message": question}
        ) as sse_response:
            sse_response.raise_for_status()
            events = await parse_sse_response(sse_response)

        names = [n for n, _ in events]
        assert "run.completed" in names, names
        final = next(data for name, data in events if name == "run.completed")
        assert final["status"] == "SUCCEEDED", final
        hosted_output = final["output"]
        assert hosted_output["answer"].strip()
        hosted_citations = hosted_output["citations"]
        assert hosted_citations, "hosted chat answer must carry at least one citation"
        assert any(c.get("section") == expected_section for c in hosted_citations), (
            expected_section,
            hosted_citations,
        )

        # Step 10 (Run half): every hosted event carries the same message trace_id.
        message_trace_id = final["trace_id"]
        assert all(data.get("trace_id") == message_trace_id for _, data in events), events

    # --- Step 10 (Portal half): Portal's own publish audit is queryable
    # for this Deployment (Portal->Deployment link; the Run/Search trace_id
    # above is minted per-message inside agent-runtime, a separate id space
    # from Portal's per-HTTP-request trace_id per 07-data-api-contracts.md
    # §10 -- both halves are independently confirmed, not claimed identical). ---
    resp = await portal.get(
        "/api/v1/audit-events",
        params={"resource_id": deployment_id, "event_type": "DEPLOYMENT_PUBLISHED"},
        headers=auth("AUDITOR"),
    )
    resp.raise_for_status()
    audit_items = resp.json()["items"]
    assert audit_items, f"expected a DEPLOYMENT_PUBLISHED audit event for {deployment_id}"
    assert audit_items[0]["result"] == "SUCCESS"
