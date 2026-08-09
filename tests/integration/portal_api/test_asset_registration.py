"""D-034 closure: generic asset registration for AGENT/PROMPT (and MCP_TOOL)
through the already-generic `POST /api/v1/assets` — plus the new pre-submit
`POST /api/v1/manifests/validate` dry-run and the two new
`GET /api/v1/asset-versions/{version_id}[/template]` read endpoints that
agent-runtime's Registry resolution (M05) now depends on.

Ground truth before this change: `create_asset` accepted any `manifest.type`
without ever checking it against `packages/schemas` — this suite proves that
gap is closed (schema-invalid manifests are now rejected with field errors)
without breaking the existing Knowledge flow (`register_knowledge_asset`-
equivalent shape is exercised by `test_lifecycle.py`/e2e already; this file
only adds AGENT/PROMPT/MCP_TOOL coverage plus the shared validation path).
"""

from __future__ import annotations

import json
import uuid

import pytest
from portal_api.models import AssetVersion
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

pytestmark = pytest.mark.asyncio


def _agent_manifest(**overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "agent",
        "name": "테스트 에이전트 (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_asset_registration.py fixture",
        "workflow": {
            "entry_role": "answerer",
            "roles": [
                {
                    "id": "answerer",
                    "type": "answerer",
                    "requires_knowledge": True,
                    "requires_mcp": False,
                    "requires_prompt": True,
                }
            ],
        },
        "capabilities": {"knowledge_required": True, "mcp_allowed": False},
    }
    manifest.update(overrides)
    return manifest


def _prompt_manifest(template_file: str = "template.md", **overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "prompt",
        "name": "테스트 프롬프트 (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_asset_registration.py fixture",
        "template": {"system": "당신은 테스트 어시스턴트입니다.", "file": template_file},
        "variables": [{"name": "question", "type": "string", "required": True}],
    }
    manifest.update(overrides)
    return manifest


def _mcp_tool_manifest(**overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "mcp_tool",
        "name": "테스트 MCP Tool (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "server_alias": "test-server",
        "tool_name": "test_tool.get_rows",
        "risk_level": "READ_ONLY",
    }
    manifest.update(overrides)
    return manifest


async def _post_asset(
    client, manifest: dict, *, files: dict | None = None, token: str = "dev-user-token"
):
    return await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(manifest, ensure_ascii=False)},
        files=files or {},
        headers=auth_header(token),
    )


# --- Happy path: AGENT/PROMPT/MCP_TOOL registration end-to-end -------------


async def test_register_agent_asset_end_to_end(client, db) -> None:
    resp = await _post_asset(client, _agent_manifest())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "DRAFT"
    assert body["manifest"]["type"] == "agent"

    stored = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == body["id"]))
    ).scalar_one()
    assert stored.manifest["type"] == "agent"


async def test_register_prompt_asset_with_template_file(client, db) -> None:
    manifest = _prompt_manifest(template_file="template.md")
    resp = await _post_asset(
        client,
        manifest,
        files={"files": ("template.md", b"# Template\n\n{{question}}\n", "text/markdown")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["manifest"]["type"] == "prompt"

    template_resp = await client.get(
        f"/api/v1/asset-versions/{body['id']}/template", headers=auth_header()
    )
    assert template_resp.status_code == 200, template_resp.text
    assert "{{question}}" in template_resp.json()["content"]


async def test_register_mcp_tool_asset_end_to_end(client, db) -> None:
    resp = await _post_asset(client, _mcp_tool_manifest())
    assert resp.status_code == 201, resp.text
    assert resp.json()["manifest"]["type"] == "mcp_tool"


# --- Schema-invalid manifests rejected with field errors -------------------


async def test_invalid_agent_manifest_rejected_with_field_errors(client) -> None:
    # Missing required `workflow`/`capabilities` entirely.
    manifest = _agent_manifest()
    del manifest["workflow"]
    del manifest["capabilities"]

    resp = await _post_asset(client, manifest)
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    errors = body["error"]["details"]["errors"]
    assert errors, "expected at least one field-level error"
    assert any("workflow" in e or "capabilities" in e for e in errors)


async def test_invalid_prompt_manifest_rejected_with_field_errors(client) -> None:
    manifest = _prompt_manifest()
    manifest["variables"] = "not-an-array"  # wrong type

    resp = await _post_asset(client, manifest)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert resp.json()["error"]["details"]["errors"]


async def test_invalid_mcp_tool_manifest_rejected_with_field_errors(client) -> None:
    manifest = _mcp_tool_manifest(risk_level="WRITE")  # only READ_ONLY permitted

    resp = await _post_asset(client, manifest)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert resp.json()["error"]["details"]["errors"]


async def test_unsupported_manifest_type_rejected(client) -> None:
    resp = await _post_asset(client, {"type": "not-a-real-type"})
    assert resp.status_code == 400, resp.text


async def test_invalid_manifest_never_creates_a_row(client, db) -> None:
    """A rejected registration must leave no partial Asset/AssetVersion —
    proves the schema check runs before any DB write, not after."""
    from portal_api.models import Asset
    from sqlalchemy import func

    before = (await db.execute(select(func.count()).select_from(Asset))).scalar_one()
    manifest = _agent_manifest()
    del manifest["workflow"]
    resp = await _post_asset(client, manifest)
    assert resp.status_code == 400
    after = (await db.execute(select(func.count()).select_from(Asset))).scalar_one()
    assert after == before


# --- RBAC: only CREATOR/ADMIN may register, others denied + audited -------


async def test_non_creator_role_denied_and_audited(client) -> None:
    resp = await _post_asset(client, _agent_manifest(), token="dev-auditor-token")
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit = await client.get(
        "/api/v1/audit-events",
        params={"event_type": "PERMISSION_DENIED:ASSET_CREATE"},
        headers=auth_header("dev-auditor-token"),
    )
    assert audit.status_code == 200, audit.text
    events = audit.json()["items"]
    assert any(e["result"] == "DENIED" for e in events)


async def test_admin_role_can_register_agent(client) -> None:
    resp = await _post_asset(client, _agent_manifest(), token="dev-admin-token")
    assert resp.status_code == 201, resp.text


# --- POST /api/v1/manifests/validate (dry-run, no persistence) ------------


async def test_validate_endpoint_accepts_valid_agent_manifest(client, db) -> None:
    from portal_api.models import Asset
    from sqlalchemy import func

    before = (await db.execute(select(func.count()).select_from(Asset))).scalar_one()
    resp = await client.post(
        "/api/v1/manifests/validate",
        json={"type": "agent", "manifest": _agent_manifest()},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"valid": True, "errors": []}
    after = (await db.execute(select(func.count()).select_from(Asset))).scalar_one()
    assert after == before, "validate endpoint must never persist anything"


async def test_validate_endpoint_reports_field_errors(client) -> None:
    manifest = _prompt_manifest()
    del manifest["template"]

    resp = await client.post(
        "/api/v1/manifests/validate",
        json={"type": "prompt", "manifest": manifest},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"]


async def test_validate_endpoint_requires_asset_create_permission(client) -> None:
    resp = await client.post(
        "/api/v1/manifests/validate",
        json={"type": "agent", "manifest": _agent_manifest()},
        headers=auth_header("dev-auditor-token"),
    )
    assert resp.status_code == 403, resp.text


async def test_validate_endpoint_unsupported_type(client) -> None:
    resp = await client.post(
        "/api/v1/manifests/validate",
        json={"type": "unknown-type", "manifest": {}},
        headers=auth_header(),
    )
    assert resp.status_code == 400, resp.text


# --- GET /api/v1/asset-versions/{version_id}[/template] --------------------


async def test_get_asset_version_detail(client) -> None:
    created = await _post_asset(client, _agent_manifest())
    version_id = created.json()["id"]

    resp = await client.get(f"/api/v1/asset-versions/{version_id}", headers=auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == version_id
    assert body["manifest"]["type"] == "agent"
    assert body["status"] == "DRAFT"


async def test_get_asset_version_detail_not_found(client) -> None:
    resp = await client.get(f"/api/v1/asset-versions/{uuid.uuid4()}", headers=auth_header())
    assert resp.status_code == 404


async def test_get_prompt_template_rejects_non_prompt_type(client) -> None:
    created = await _post_asset(client, _agent_manifest())
    version_id = created.json()["id"]

    resp = await client.get(f"/api/v1/asset-versions/{version_id}/template", headers=auth_header())
    assert resp.status_code == 404


async def test_get_prompt_template_missing_file_on_disk(client) -> None:
    # Registered without ever uploading `template.md` -> file genuinely absent.
    created = await _post_asset(client, _prompt_manifest(template_file="template.md"))
    version_id = created.json()["id"]

    resp = await client.get(f"/api/v1/asset-versions/{version_id}/template", headers=auth_header())
    assert resp.status_code == 404


async def test_asset_versions_lifecycle_route_not_shadowed(client, db) -> None:
    """Regression guard for the routing collision this feature introduced:
    `GET /api/v1/asset-versions/{version_id}` (assets.py) is a single-segment
    catch-all that, if registered before reviews.py's literal
    `GET /api/v1/asset-versions/lifecycle`, would swallow it and always
    resolve version_id="lifecycle" -> 404 instead. `main.py` now includes
    reviews_router before assets_router specifically to keep this working —
    this test fails loudly if that ordering ever regresses."""
    resp = await client.get(
        "/api/v1/asset-versions/lifecycle", headers=auth_header("dev-release-token")
    )
    assert resp.status_code == 200, resp.text
