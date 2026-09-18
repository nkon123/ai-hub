"""Integration tests for `POST /api/v1/assets/{asset_id}/mcp-server-versions`
(`routers/assets.py::create_mcp_server_version`, D-101).

왜 생겼나(2026-09-18 실사용): hello-mcp 의 `allowed_roles` 에 USER 를 더한 새 버전을
만들어야 했는데, 범용 새 버전(`POST .../versions`)은 Manifest·파일을 복사하고
`version`/`changelog`만 바꿔서 **코드도 매니페스트도 바꿀 수 없었다**.

이 suite 가 고정하는 것:
- 새 파일 업로드와 이전 파일 재사용이 서로로 둔갑하지 않는다(빈 업로드 ≠ 재사용).
- 매니페스트를 바꿀 수 있지만 `id`/`type`/`server_alias`는 바꿀 수 없다.
- 신규 등록과 **같은 코드 검사**가 새 버전의 최종 파일 목록에 적용된다.
- 직전 버전(저장소·Manifest)은 건드리지 않는다.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
import pytest
from portal_api.models import AssetVersion
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tests.integration.portal_api.conftest import auth_header, make_draft_asset_version

pytestmark = pytest.mark.asyncio

SERVER_PY = b"print('hello')\n"


def _mcp_server_manifest(asset_id: str, **overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": asset_id,
        "type": "mcp_server",
        "name": "새 버전 테스트 MCP 서버 (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_mcp_server_version.py fixture",
        "server_alias": f"test-mcp-{asset_id[:8]}",
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
                "tool_name": "hello.now",
                "label": "현재 시각",
                "input_schema": {"type": "object", "additionalProperties": False, "properties": {}},
                "risk_level": "READ_ONLY",
                "permissions": {"allowed_roles": ["CREATOR", "ADMIN"], "allowed_orgs": ["miracom"]},
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


async def _register(client: httpx.AsyncClient, asset_id: str) -> dict:
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_mcp_server_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("server.py", SERVER_PY, "text/x-python")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _stored(db: AsyncSession, version_id: str) -> AssetVersion:
    db.expire_all()
    return (await db.execute(select(AssetVersion).where(AssetVersion.id == version_id))).scalar_one()


def _url(asset_id: str) -> str:
    return f"/api/v1/assets/{asset_id}/mcp-server-versions"


def _with_user_role(manifest: dict) -> dict:
    manifest = json.loads(json.dumps(manifest))
    manifest["declared_tools"][0]["permissions"]["allowed_roles"] = ["USER", "CREATOR", "ADMIN"]
    return manifest


async def test_reuse_previous_with_new_manifest_changes_permissions_and_keeps_code(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    """실사용 그대로: 코드는 그대로, 권한만 넓힌 1.0.1."""
    asset_id = str(uuid.uuid4())
    source = await _register(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={
            "version": "1.0.1",
            "files_source": "REUSE_PREVIOUS",
            "manifest": json.dumps(_with_user_role(_mcp_server_manifest(asset_id))),
            "changelog": "USER 역할 허용",
        },
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "DRAFT"
    assert body["version"] == "1.0.1"
    assert body["manifest"]["version"] == "1.0.1"
    assert body["manifest"]["declared_tools"][0]["permissions"]["allowed_roles"] == [
        "USER",
        "CREATOR",
        "ADMIN",
    ]
    old = await _stored(db, source["id"])
    old_dir, old_manifest = Path(old.storage_path), dict(old.manifest)
    new_dir = Path((await _stored(db, body["id"])).storage_path)
    assert (new_dir / "server.py").read_bytes() == SERVER_PY
    assert new_dir != old_dir

    # 직전 버전은 그대로다 — 승인 버전 제자리 수정 금지.
    assert old_manifest["declared_tools"][0]["permissions"]["allowed_roles"] == ["CREATOR", "ADMIN"]
    assert old_manifest["version"] == "1.0.0"
    assert (old_dir / "server.py").read_bytes() == SERVER_PY


async def test_upload_replaces_code(client: httpx.AsyncClient, db: AsyncSession) -> None:
    asset_id = str(uuid.uuid4())
    source = await _register(client, asset_id)
    new_code = b"print('hello v2')\n"

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.1.0", "files_source": "UPLOAD"},
        files={"files": ("server.py", new_code, "text/x-python")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text
    new_dir = Path((await _stored(db, resp.json()["id"])).storage_path)
    assert (new_dir / "server.py").read_bytes() == new_code
    assert (new_dir / "checksums.sha256").exists()
    # 직전 버전의 코드는 그대로다.
    old_dir = Path((await _stored(db, source["id"])).storage_path)
    assert (old_dir / "server.py").read_bytes() == SERVER_PY


async def test_upload_mode_rejects_empty_file_list(client: httpx.AsyncClient) -> None:
    """빈 업로드가 조용히 이전 코드 복사로 둔갑하지 않는다."""
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "UPLOAD"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_reuse_mode_rejects_attached_files(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS"},
        files={"files": ("server.py", SERVER_PY, "text/x-python")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400


@pytest.mark.parametrize("field,value", [("server_alias", "another-server"), ("type", "mcp_tool")])
async def test_identity_fields_cannot_change(client: httpx.AsyncClient, field: str, value: str) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)
    manifest = _mcp_server_manifest(asset_id, **{field: value})

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS", "manifest": json.dumps(manifest)},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400
    assert field in resp.json()["error"]["details"]["immutable_fields_changed"]


async def test_changed_entrypoint_must_exist_in_final_files(client: httpx.AsyncClient) -> None:
    """신규 등록과 같은 코드 검사가 **재사용한 파일 목록**에도 걸린다 — 시작 파일만
    바꾸고 코드를 안 올리면 실행할 파일이 없는 버전이 만들어진다."""
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)
    manifest = _mcp_server_manifest(asset_id)
    manifest["transport"]["entrypoint"] = "main.py"

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS", "manifest": json.dumps(manifest)},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ASSET_SOURCE_ENTRYPOINT_MISSING"


async def test_code_on_http_server_is_rejected(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)
    manifest = _mcp_server_manifest(
        asset_id, transport={"kind": "HTTP", "endpoint": "http://localhost:8500/mcp"}
    )

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS", "manifest": json.dumps(manifest)},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ASSET_SOURCE_NOT_EXECUTED_BY_THIS_TRANSPORT"


async def test_invalid_manifest_is_rejected_by_schema(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)
    manifest = _mcp_server_manifest(asset_id)
    manifest["declared_tools"][0]["risk_level"] = "ANYTHING"

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS", "manifest": json.dumps(manifest)},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_version_must_exceed_existing(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.0", "files_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400


async def test_non_owner_is_denied(client: httpx.AsyncClient) -> None:
    asset_id = str(uuid.uuid4())
    await _register(client, asset_id)

    resp = await client.post(
        _url(asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-reviewer-token"),
    )
    assert resp.status_code == 403


async def test_other_asset_types_are_refused(client: httpx.AsyncClient, db: AsyncSession) -> None:
    knowledge = await make_draft_asset_version(db)

    resp = await client.post(
        _url(knowledge.asset_id),
        data={"version": "1.0.1", "files_source": "REUSE_PREVIOUS"},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ASSET_STATE_TRANSITION_INVALID"
