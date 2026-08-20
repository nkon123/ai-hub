"""Integration tests — Runtime Model router (M02, open-decisions.md D-093).

`GET /api/v1/runtime-models*`. All models used here are tiny fixture files
(kilobytes, not gigabytes) written under a per-test tmp directory — never
the real repo, and never a real multi-GB weight file (task brief forbids
committing/creating one).
"""

from __future__ import annotations

import hashlib
import json

import pytest
from portal_api.models import AuditEvent
from sqlalchemy import func, select

from .conftest import auth_header

pytestmark = pytest.mark.asyncio


@pytest.fixture
def model_root(tmp_path, monkeypatch):
    from portal_api.config import settings

    root = tmp_path / "runtime-models"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "runtime_model_root", root)
    return root


def _write_model(
    model_root,
    model_id: str,
    *,
    content: bytes = b"fake-gguf-bytes-for-testing" * 100,
    purpose: str = "chat",
    upload_status: str = "READY",
    has_modelfile: bool = True,
    write_file: bool = True,
    write_modelfile: bool = True,
) -> dict:
    model_dir = model_root / model_id
    model_dir.mkdir(parents=True, exist_ok=True)
    file_name = f"{model_id}.gguf"
    sha256 = hashlib.sha256(content).hexdigest()
    manifest = {
        "schema_version": "1.0",
        "type": "runtime_model",
        "model_id": model_id,
        "display_name": f"{model_id} display",
        "purpose": purpose,
        "version": "1.0.0",
        "source_model": "exaone3.5:7.8b",
        "file_name": file_name,
        "file_size_bytes": len(content),
        "sha256": sha256,
        "has_modelfile": has_modelfile,
        "upload_status": upload_status,
        "registered_at": "2026-08-20T00:00:00Z",
    }
    if has_modelfile:
        manifest["modelfile_name"] = "Modelfile"
    (model_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if write_file:
        (model_dir / file_name).write_bytes(content)
    if has_modelfile and write_modelfile:
        (model_dir / "Modelfile").write_text(
            "FROM ./model.gguf\nTEMPLATE \"\"\"{{ .Prompt }}\"\"\"\nPARAMETER temperature 0.7\n",
            encoding="utf-8",
        )
    return manifest


async def test_list_empty(client, model_root):
    resp = await client.get("/api/v1/runtime-models", headers=auth_header())
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"] == []
    assert body["total"] == 0


async def test_list_and_detail_show_registered_model(client, model_root):
    manifest = _write_model(model_root, "test-chat-model")

    resp = await client.get("/api/v1/runtime-models", headers=auth_header())
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["model_id"] == "test-chat-model"
    assert items[0]["sha256"] == manifest["sha256"]
    assert items[0]["purpose"] == "chat"
    assert items[0]["upload_status"] == "READY"

    resp = await client.get("/api/v1/runtime-models/test-chat-model", headers=auth_header())
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "test-chat-model display"


async def test_list_filters_by_purpose(client, model_root):
    _write_model(model_root, "chat-a", purpose="chat")
    _write_model(model_root, "embed-a", purpose="embedding")

    resp = await client.get(
        "/api/v1/runtime-models", params={"purpose": "embedding"}, headers=auth_header()
    )
    items = resp.json()["items"]
    assert [i["model_id"] for i in items] == ["embed-a"]


async def test_detail_unknown_model_returns_not_found(client, model_root):
    resp = await client.get("/api/v1/runtime-models/does-not-exist", headers=auth_header())
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


async def test_download_full_file_streams_correct_bytes_and_headers(client, model_root, db):
    content = b"abc123" * 1000
    manifest = _write_model(model_root, "dl-model", content=content)

    resp = await client.get("/api/v1/runtime-models/dl-model/download", headers=auth_header())
    assert resp.status_code == 200
    assert resp.content == content
    assert resp.headers["x-content-sha256"] == manifest["sha256"]
    assert resp.headers["etag"] == f'"{manifest["sha256"]}"'
    assert resp.headers.get("accept-ranges") == "bytes"

    # download initiation (no Range header) is audited exactly once
    count = (
        await db.execute(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.event_type == "RUNTIME_MODEL_DOWNLOADED"
            )
        )
    ).scalar_one()
    assert count == 1


async def test_download_valid_range_returns_partial_content(client, model_root):
    content = bytes(range(256)) * 4  # 1024 bytes, deterministic
    _write_model(model_root, "range-model", content=content)

    resp = await client.get(
        "/api/v1/runtime-models/range-model/download",
        headers={**auth_header(), "Range": "bytes=100-199"},
    )
    assert resp.status_code == 206
    assert resp.content == content[100:200]
    assert resp.headers["content-range"] == f"bytes 100-199/{len(content)}"


async def test_download_invalid_range_returns_416(client, model_root):
    content = b"x" * 100
    _write_model(model_root, "short-model", content=content)

    resp = await client.get(
        "/api/v1/runtime-models/short-model/download",
        headers={**auth_header(), "Range": "bytes=1000-2000"},
    )
    assert resp.status_code == 416


async def test_range_resume_with_stale_if_range_falls_back_to_full_200(client, model_root):
    """Simulates the original file being replaced mid-download: a resuming
    client sends If-Range with the ETag it saw earlier, but the file's
    current sha256/ETag no longer matches, so per RFC 9110 the server must
    ignore the Range and return the full, current file with 200 — never a
    206 that stitches old+new bytes together."""
    content = b"y" * 500
    _write_model(model_root, "replaced-model", content=content)

    stale_etag = '"0000000000000000000000000000000000000000000000000000000000000000"'
    resp = await client.get(
        "/api/v1/runtime-models/replaced-model/download",
        headers={**auth_header(), "Range": "bytes=100-199", "If-Range": stale_etag},
    )
    assert resp.status_code == 200
    assert resp.content == content


async def test_not_ready_model_returns_409_distinct_from_not_found(client, model_root):
    _write_model(model_root, "pending-model", upload_status="PENDING")

    resp = await client.get(
        "/api/v1/runtime-models/pending-model/download", headers=auth_header()
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "RUNTIME_MODEL_NOT_READY"

    # still listed/visible in detail — distinct from "does not exist"
    detail = await client.get("/api/v1/runtime-models/pending-model", headers=auth_header())
    assert detail.status_code == 200
    assert detail.json()["upload_status"] == "PENDING"


async def test_ready_but_file_missing_returns_500_distinct_from_not_ready(client, model_root):
    _write_model(model_root, "ghost-model", write_file=False)

    resp = await client.get("/api/v1/runtime-models/ghost-model/download", headers=auth_header())
    assert resp.status_code == 500
    assert resp.json()["error"]["code"] == "RUNTIME_MODEL_FILE_MISSING"


async def test_path_traversal_model_id_is_rejected(client, model_root):
    _write_model(model_root, "safe-model")

    for evil_id in ["..%2Fsafe-model", "..", "a%2F..%2F..%2Fetc", "SAFE-MODEL"]:
        resp = await client.get(f"/api/v1/runtime-models/{evil_id}", headers=auth_header())
        assert resp.status_code == 404, f"expected 404 for {evil_id!r}, got {resp.status_code}"


async def test_path_traversal_via_resolve_model_dir_directly(model_root):
    """Unit-level guard on the resolver itself, not just via HTTP routing
    (FastAPI/Starlette may normalize some '../' segments before they ever
    reach our code — this proves the function is safe independent of
    that)."""
    from portal_api.config import settings
    from portal_api.runtime_models import resolve_model_dir

    assert settings.runtime_model_root == model_root
    assert resolve_model_dir("../etc") is None
    assert resolve_model_dir("a/../../etc") is None
    assert resolve_model_dir("") is None
    assert resolve_model_dir(".") is None
    assert resolve_model_dir("valid-model-id") is not None


async def test_permission_denied_for_role_without_download_read(client, model_root):
    _write_model(model_root, "denied-model")

    resp = await client.get(
        "/api/v1/runtime-models", headers=auth_header("dev-reviewer-token")
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    resp = await client.get(
        "/api/v1/runtime-models/denied-model/download",
        headers=auth_header("dev-reviewer-token"),
    )
    assert resp.status_code == 403


async def test_unauthenticated_request_is_rejected(client, model_root):
    resp = await client.get("/api/v1/runtime-models")
    assert resp.status_code == 401


async def test_modelfile_returns_text_content(client, model_root):
    _write_model(model_root, "mf-model")

    resp = await client.get("/api/v1/runtime-models/mf-model/modelfile", headers=auth_header())
    assert resp.status_code == 200
    assert "TEMPLATE" in resp.text
    assert "PARAMETER" in resp.text


async def test_modelfile_absent_returns_404(client, model_root):
    _write_model(model_root, "no-mf-model", has_modelfile=False)

    resp = await client.get(
        "/api/v1/runtime-models/no-mf-model/modelfile", headers=auth_header()
    )
    assert resp.status_code == 404


async def test_checksum_exposed_consistently_across_endpoints(client, model_root):
    manifest = _write_model(model_root, "checksum-model")

    detail = await client.get("/api/v1/runtime-models/checksum-model", headers=auth_header())
    download = await client.get(
        "/api/v1/runtime-models/checksum-model/download", headers=auth_header()
    )
    assert detail.json()["sha256"] == manifest["sha256"]
    assert download.headers["x-content-sha256"] == manifest["sha256"]


async def test_range_continuation_not_double_audited(client, model_root, db):
    content = b"z" * 2000
    _write_model(model_root, "resume-model", content=content)

    # Initiation: no Range header.
    await client.get("/api/v1/runtime-models/resume-model/download", headers=auth_header())
    # Resume: Range starting at a nonzero offset — must NOT add another audit row.
    await client.get(
        "/api/v1/runtime-models/resume-model/download",
        headers={**auth_header(), "Range": "bytes=1000-1999"},
    )

    count = (
        await db.execute(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.event_type == "RUNTIME_MODEL_DOWNLOADED",
                AuditEvent.resource_id == "resume-model",
            )
        )
    ).scalar_one()
    assert count == 1
