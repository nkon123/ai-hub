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
from pathlib import Path

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


def _mcp_server_manifest(**overrides) -> dict:
    """D-094 MCP 서버 자산. `samples/mcp-servers/hello-mcp` 와 같은 모양이다
    — Portal Wizard(`/assets/new/mcp_server`)가 제출하는 것도 이 모양이다."""
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "mcp_server",
        "name": "테스트 MCP 서버 (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_asset_registration.py fixture",
        "server_alias": "test-hello-mcp",
        "provenance": "INTERNAL",
        "protocol_version": "2025-06-18",
        "transport": {
            "kind": "STDIO",
            "interpreter": "python",
            "entrypoint": "server.py",
            "args": [],
            "vendored_dependencies": True,
        },
        "declared_tools": [
            {
                "tool_name": "hello.echo",
                "label": "보낸 문장을 그대로 돌려줍니다",
                "input_schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["message"],
                    "properties": {"message": {"type": "string"}},
                },
                "risk_level": "READ_ONLY",
                "permissions": {
                    "allowed_roles": ["CREATOR", "ADMIN"],
                    "allowed_orgs": ["miracom"],
                },
                "data_classification": "PUBLIC_INTERNAL",
                "confirmation_policy": "NEVER",
                "execution_guards": {
                    "timeout_seconds": 10,
                    "max_bytes": 4096,
                    "rate_limit_per_minute": 30,
                },
            }
        ],
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


async def test_register_mcp_server_asset_end_to_end(client, db) -> None:
    """등록 Wizard(M01)와 스키마(M06)가 `mcp_server` 를 먼저 알게 된 뒤에도
    `_MANIFEST_TYPE_TO_SCHEMA` 에 그 키가 없어 제출만 400 으로 막혔다 —
    Wizard 를 5단계까지 다 채운 뒤에야 드러나는 실패였다."""
    resp = await _post_asset(client, _mcp_server_manifest())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "DRAFT"
    assert body["manifest"]["type"] == "mcp_server"
    assert body["manifest"]["server_alias"] == "test-hello-mcp"

    stored = (
        await db.execute(select(AssetVersion).where(AssetVersion.id == body["id"]))
    ).scalar_one()
    assert stored.manifest["transport"]["kind"] == "STDIO"


# --- D-096: mcp_server 자산만 소스 코드를 함께 받는다 ----------------------
# 이 예외가 조용히 넓어지는 것이 이 기능의 유일한 실패 방식이다. 넓어지는
# 방향은 셋뿐이라(다른 자산 종류로, 다른 확장자로, 실행하지 않는 transport로)
# 셋 다 여기서 막아 둔다.

_SERVER_PY = b"# test server\nprint('hi')\n"


def _source_file(name: str = "server.py", content: bytes = _SERVER_PY) -> dict:
    return {"files": (name, content, "text/plain")}


async def test_mcp_server_asset_accepts_its_own_source_code(client, db) -> None:
    resp = await _post_asset(client, _mcp_server_manifest(), files=_source_file())
    assert resp.status_code == 201, resp.text

    stored = (
        await db.execute(
            select(AssetVersion).where(AssetVersion.id == resp.json()["id"])
        )
    ).scalar_one()
    saved = Path(stored.storage_path) / "server.py"
    assert saved.is_file(), f"소스가 저장되지 않았다: {stored.storage_path}"
    assert saved.read_bytes() == _SERVER_PY

    # 실행될 파일이 체크섬 대상에 들어 있어야 한다 — 이 예외의 전제다.
    checksums = (Path(stored.storage_path) / "checksums.sha256").read_text(encoding="utf-8")
    assert "server.py" in checksums


async def test_source_code_is_rejected_for_every_other_asset_type(client) -> None:
    """예외는 `mcp_server` 에만 붙는다 — Agent 에 코드를 붙일 수는 없다."""
    resp = await _post_asset(client, _agent_manifest(), files=_source_file())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ASSET_UPLOAD_EXTENSION_REJECTED"


@pytest.mark.parametrize("name", ["x.pyc", "run.bat", "run.sh", "run.ps1", "a.zip", "x.exe"])
async def test_only_readable_source_is_excepted(client, name: str) -> None:
    """되살린 것은 사람이 읽을 수 있는 소스뿐이다.

    컴파일본(.pyc)·셸 스크립트·압축·바이너리는 `mcp_server` 에서도 거부된다 —
    "허브가 검토했다"가 성립하려면 누군가 읽을 수 있어야 하고, 중첩 압축은
    검토가 보아야 할 것을 가리는 형태다.
    """
    resp = await _post_asset(client, _mcp_server_manifest(), files=_source_file(name, b"\x00"))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ASSET_UPLOAD_EXTENSION_REJECTED"


async def test_code_cannot_be_attached_to_a_server_that_never_runs_it(client) -> None:
    """HTTP 서버는 남의 PC 에서 이미 돌고 있다 — 코드를 받아 봐야 실행할 곳이
    없고 검토 대상만 늘어난다."""
    manifest = _mcp_server_manifest(
        transport={"kind": "HTTP", "endpoint": "http://localhost:8500/mcp"}
    )
    resp = await _post_asset(client, manifest, files=_source_file())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ASSET_SOURCE_NOT_EXECUTED_BY_THIS_TRANSPORT"


async def test_declared_entrypoint_must_be_among_the_uploaded_files(client) -> None:
    """실행될 파일이 검토·체크섬 대상 안에 있다는 것이 이 예외의 전제다."""
    manifest = _mcp_server_manifest(
        transport={
            "kind": "STDIO",
            "interpreter": "python",
            "entrypoint": "main.py",
            "args": [],
            "vendored_dependencies": True,
        }
    )
    resp = await _post_asset(client, manifest, files=_source_file("server.py"))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ASSET_SOURCE_ENTRYPOINT_MISSING"


async def test_rejected_source_upload_leaves_no_files_behind(client, db) -> None:
    """거부는 부분 업로드를 남기지 않는다 — 실행 코드라면 더더욱."""
    manifest = _mcp_server_manifest(
        transport={"kind": "HTTP", "endpoint": "http://localhost:8500/mcp"}
    )
    resp = await _post_asset(client, manifest, files=_source_file())
    assert resp.status_code == 400

    rows = (await db.execute(select(AssetVersion))).scalars().all()
    assert all(r.manifest.get("server_alias") != "test-hello-mcp" for r in rows)


async def test_upload_policy_endpoint_tells_the_screen_about_the_exception(client) -> None:
    """화면이 서버가 받아 줄 파일을 미리 거절하지 않으려면 예외도 함께 봐야
    한다 — 이 필드가 빠지면 위저드는 `.py` 를 선택 단계에서 막는다."""
    resp = await client.get("/api/v1/assets/upload-policy", headers=auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert ".py" in body["rejected_extensions"]
    assert ".py" in body["source_code_exception"]["mcp_server"]
    assert "agent" not in body["source_code_exception"]


async def test_invalid_mcp_server_manifest_rejected_with_field_errors(client) -> None:
    """종류를 받아준다고 검증까지 느슨해지지 않는다."""
    manifest = _mcp_server_manifest(transport={"kind": "STDIO"})  # entrypoint 누락

    resp = await _post_asset(client, manifest)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert resp.json()["error"]["details"]["errors"]


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


# --- POST /api/v1/manifests/mcp-tool/from-python-signature ----------------


async def test_python_signature_conversion_is_static_and_transparent(client) -> None:
    source = (
        "@dangerous_decorator()\n"
        "def get_tables(schema: str, limit: int = 20) -> list[str]:\n"
        '    """This docstring and body must not cross the response boundary."""\n'
        '    raise RuntimeError("must never execute")\n'
    )
    resp = await client.post(
        "/api/v1/manifests/mcp-tool/from-python-signature",
        json={"source": source},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["function_name"] == "get_tables"
    assert body["input_schema"]["properties"] == {
        "schema": {"type": "string"},
        "limit": {"type": "integer", "default": 20},
    }
    assert body["input_schema"]["required"] == ["schema"]
    assert body["discarded"] == {
        "body_statement_count": 2,
        "decorator_count": 1,
        "docstring_present": True,
        "return_annotation_present": True,
        "top_level_statement_count": 0,
        "source_persisted": False,
        "source_executed": False,
    }
    assert "must never execute" not in resp.text


async def test_python_signature_conversion_rejects_identity_and_ambiguous_functions(client) -> None:
    identity = await client.post(
        "/api/v1/manifests/mcp-tool/from-python-signature",
        json={"source": "def query(user: str):\n    pass\n"},
        headers=auth_header(),
    )
    assert identity.status_code == 400
    assert identity.json()["error"]["details"]["reason"] == "identity_parameter_forbidden"

    ambiguous = await client.post(
        "/api/v1/manifests/mcp-tool/from-python-signature",
        json={"source": "def one(x: str): pass\ndef two(y: int): pass\n"},
        headers=auth_header(),
    )
    assert ambiguous.status_code == 400
    assert ambiguous.json()["error"]["details"] == {
        "reason": "multiple_functions_found",
        "candidates": ["one", "two"],
    }


async def test_python_signature_conversion_requires_create_permission(client) -> None:
    resp = await client.post(
        "/api/v1/manifests/mcp-tool/from-python-signature",
        json={"source": "def query(schema: str): pass\n"},
        headers=auth_header("dev-auditor-token"),
    )
    assert resp.status_code == 403


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
