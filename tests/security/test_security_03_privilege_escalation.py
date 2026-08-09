"""Security property 3 — privilege escalation via request body is
impossible.

Three call paths this suite can actually put an attacker-controlled value
in front of, each proven separately:

  A. portal-api `POST /api/v1/assets`: a CREATOR spoofs `manifest.owner.*`
     identity fields in the JSON body it fully controls. Proven: the
     server's own audit trail still records the *token's* identity as
     actor, never the spoofed one -- because `get_current_user` derives
     identity solely from the Bearer token (`auth.py`), and every
     `require_permission`/`record_audit` call downstream uses that resolved
     `UserContext`, never anything read back out of the request body.

  B. agent-runtime `POST /local/v1/runs` -> office-mcp-server (the
     *sanctioned* MCP call path): a caller stuffs `roles`/`user_id`/`org`
     fields into `input`/`mcp_tool_input` (both wide-open `object` types
     per D-052, so nothing schema-level stops the caller from trying).
     Proven: `_build_mcp_audit_context` in `workflow.py` builds
     `audit_context.user` *only* from Runtime-trusted config (the Agent
     manifest, the Office Profile) -- verified by cross-checking
     office-mcp-server's own audit trail for the same trace_id, which is
     the one ground truth neither side of the HTTP call can independently
     fake.

  C. office-mcp-server's `RequestContext` schema itself: even a caller who
     controls the whole `audit_context.user` object cannot smuggle an
     out-of-band grant (e.g. an `is_admin` flag) into it, because
     `RequestContextUser`/`RequestContext` are `extra="forbid"` Pydantic
     models (`request_context.py`) -- any undeclared field fails validation
     before authorization ever runs, rather than being silently ignored (a
     silently-ignored extra field would be a much weaker guarantee than an
     outright rejection).

A fourth path is a genuine, named gap rather than something this suite can
prove safe -- see the `pytest.skip` at the bottom.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

from tests.security.conftest import auth, e2e_name, mcp_audit_context, wait_for_run_terminal

pytestmark = pytest.mark.security


async def test_portal_api_spoofed_owner_identity_does_not_affect_audit_actor(
    portal: httpx.AsyncClient,
) -> None:
    """CREATOR (`dev-user@miracom.com`) submits a manifest claiming
    ownership by a different, higher-privilege-sounding identity. The Asset
    row is allowed to *store* that descriptive `owner.creator_id` field (it
    is business metadata, not an identity claim the server trusts) -- but
    the audit trail, which is what accountability actually depends on, must
    record who *authenticated* the request, not who the request body claims
    to be."""
    asset_id = str(uuid.uuid4())
    manifest = {
        "schema_version": "1.0",
        "id": asset_id,
        "type": "knowledge",
        "name": e2e_name("priv-esc-owner-spoof"),
        "version": "1.0.0",
        "owner": {
            "org": "miracom",
            "creator_id": "admin@miracom.com",  # spoofed -- real caller is dev-user@miracom.com
            "role": "ADMIN",  # not even a schema field -- probing for a side channel
        },
        "classification": "INTERNAL",
        "description": "privilege escalation probe (tests/security, safe to delete)",
        "source": {
            "type": "portal_upload",
            "documents": [
                {"path": "documents/x.md", "mime_type": "text/markdown", "sha256": "0" * 64}
            ],
        },
        "indexing_profile_ref": {"name": "default-korean-parent-child", "version": "1.0.0"},
    }
    resp = await portal.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(manifest, ensure_ascii=False)},
        files={"files": ("x.md", b"# x\n\ncontent\n", "text/markdown")},
        headers=auth("CREATOR"),
    )
    assert resp.status_code == 201, resp.text
    version_id = resp.json()["id"]

    audit_resp = await portal.get(
        "/api/v1/audit-events", params={"resource_id": version_id}, headers=auth("AUDITOR")
    )
    audit_resp.raise_for_status()
    events = [e for e in audit_resp.json()["items"] if e["event_type"] == "ASSET_VERSION_CREATED"]
    assert events, "expected an ASSET_VERSION_CREATED audit row"
    assert events[0]["actor_id"] == "dev-user@miracom.com", (
        f"audit actor must be the authenticated CREATOR token identity, not the "
        f"spoofed manifest.owner.creator_id: {events[0]}"
    )
    assert events[0]["actor_id"] != "admin@miracom.com"

    # No manual cleanup needed here: this asset was created via the raw
    # endpoint (not the shared `register_knowledge_asset` helper), so the
    # per-test id tracker never sees it -- but its name still carries the
    # `e2e-` prefix (`e2e_name()` above), so the session-end
    # `sweep_e2e_prefixed_artifacts()` safety net (imported into this
    # suite's autouse fixtures via conftest.py) removes it like everything
    # else this suite creates. It never leaves DRAFT and its one file has
    # deterministic dummy content, not a real document, so indexing has
    # nothing meaningful to do with it either way.


async def test_mcp_audit_context_user_rejects_undeclared_fields(mcp: httpx.AsyncClient) -> None:
    """Property C: `RequestContext`/`RequestContextUser` are `extra="forbid"`
    -- an attempt to smuggle an out-of-band grant onto the trusted user
    object must fail structural validation, not be silently dropped."""
    trace_id = str(uuid.uuid4())
    context = mcp_audit_context(
        requested_tool="db_metadata.get_tables", roles=["USER"], trace_id=trace_id
    )
    context["user"]["is_admin"] = True  # undeclared field, probing for a side channel
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": False,
            "audit_context": context,
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR", resp.text


async def test_mcp_audit_context_top_level_rejects_undeclared_fields(
    mcp: httpx.AsyncClient,
) -> None:
    """Same guarantee at the top-level `RequestContext`, e.g. a smuggled
    `permissions` list sitting next to `user` rather than inside it."""
    trace_id = str(uuid.uuid4())
    context = mcp_audit_context(
        requested_tool="db_metadata.get_tables", roles=["USER"], trace_id=trace_id
    )
    context["permissions"] = ["ALL"]  # undeclared top-level field
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": False,
            "audit_context": context,
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR", resp.text


async def test_agent_runtime_body_cannot_override_mcp_identity(
    agent: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    """Property B: a caller of the sanctioned `/local/v1/runs` entrypoint
    attacks `StartRunRequest.user_context` -- a top-level, schema-declared
    `dict[str, Any] | None` field (`routers/runs.py`) that exists in the
    contract but (confirmed by reading `workflow.py`) is never actually read
    by anything in the run pipeline. An attacker cannot know that from the
    outside -- it is exactly the kind of unused-but-present field that looks
    like a legitimate way to assert identity. (`input.mcp_tool_input` is
    deliberately NOT used as a second attack surface here: agent-runtime
    validates it against a local copy of the tool's own `additionalProperties:
    false` JSON Schema -- `mcp_tools.validate_tool_input` -- before ever
    building the MCP request, so smuggled fields there fail as
    MCP_INPUT_INVALID at the agent-runtime boundary itself, never reaching
    office-mcp-server at all; that is a *stronger* guarantee than this test
    needs to prove, and is exercised directly in
    `test_security_05_injection_rejected.py`.)

    The MCP audit trail, read back independently from office-mcp-server,
    must show the fixed Runtime-trusted identity (`poc-local-runtime-user` /
    org `miracom` / role `USER`) regardless -- never the attacker-supplied
    `user_context` values."""
    trace_id = str(uuid.uuid4())
    resp = await agent.post(
        "/local/v1/runs",
        json={
            "service_id": "sec-03-mcp-identity-service",
            "trace_id": trace_id,
            "user_context": {
                "id": "attacker@evil.example",
                "roles": ["ADMIN"],
                "organization_id": "evil-corp",
            },
            "input": {
                "question": "인터페이스 로그 테이블 목록을 알려주세요.",
                "agent_profile": "standard-db-agent",
                "knowledge_id": "",
                "mcp_tool": "db_metadata.get_tables",
                "mcp_tool_input": {"schema": "APP"},
                "mcp_confirmed": False,
            },
        },
    )
    assert resp.status_code == 202, resp.text

    run = await wait_for_run_terminal(agent, resp.json()["id"])
    assert run["status"] == "SUCCEEDED", run

    audit_resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    audit_resp.raise_for_status()
    events = audit_resp.json()["events"]
    assert events, "expected the MCP call to be audited under this trace_id"
    event = events[0]
    assert event["user_id"] == "poc-local-runtime-user", event
    assert event["organization_id"] == "miracom", event
    assert event["user_id"] != "attacker@evil.example"
    assert event["organization_id"] != "evil-corp"


def test_direct_mcp_call_self_asserted_role_not_verified_against_real_identity() -> None:
    pytest.skip(
        "Known, named gap (D-015 'MCP 인증: Mock User Context', "
        "open-decisions.md): this property holds for the SANCTIONED call path "
        "(agent-runtime -> office-mcp-server, proven above -- the Runtime "
        "builds audit_context.user only from trusted config, never from a "
        "caller-controlled field), but office-mcp-server itself takes no "
        "authentication (D-035-equivalent for M10) and has no identity/session "
        "verification layer in front of it. A caller hitting "
        "POST /mcp/v1/tools/{tool}/call DIRECTLY (bypassing agent-runtime "
        "entirely, exactly like this suite's own `mcp` fixture does for every "
        "other test in this file) can self-assert any `audit_context.user.roles` "
        "value and have office-mcp-server's `check_permission` (permissions.py) "
        "honor it at face value -- e.g. asserting roles=['USER'] reaches "
        "db_metadata.get_columns (allowed_roles includes USER) regardless of "
        "the caller's real-world role, since there is no trusted layer to check "
        "that assertion against. This is structural, not cryptographic, by "
        "design in this PoC (see request_context.py's module docstring: "
        "'this boundary is structural, not cryptographic'). Closing this gap "
        "requires the real enterprise identity/session adapter D-015 defers, "
        "not a test-suite workaround."
    )
