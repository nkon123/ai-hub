"""Integration tests for the `POST /api/v1/assets` inbound upload hardening
(`routers/assets.py::create_asset` + `packages/schemas/policies/
asset-upload-policy.json`).

Before this change, `create_asset` had no file-count/size/extension cap at
all and read each upload fully into memory via `await upload.read()`
(trusting nothing external, but also enforcing nothing). This suite proves,
per distinct cause, that the request is rejected with a distinct error code
+ filename-identified message, that any partial files already written for
the request are cleaned up, and that enforcement is based on bytes actually
read during streaming — not on the `Content-Length` header a caller can
forge (`test_content_length_forged_smaller_than_body_is_still_enforced`).

Uses `prompt`/`agent` manifests (not `knowledge`) so `create_asset` never
schedules the `_trigger_indexing` background task — keeps these tests
focused on the upload-handling path shared by every asset type, mirroring
`test_asset_registration.py`'s existing manifest fixtures.

`settings.storage_root` is NOT isolated per test (no existing fixture does
this — see `conftest.py`; `/storage/` is gitignored for exactly this
reason), so every test below uses a fresh `uuid4()` asset_id to avoid
cross-test collisions and computes the real on-disk `storage_path` the same
way `create_asset` does, to assert on file presence/absence there.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

import httpx
import pytest
from portal_api.config import settings

from tests.integration.portal_api.conftest import auth_header

pytestmark = pytest.mark.asyncio


def _prompt_manifest(asset_id: str, **overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": asset_id,
        "type": "prompt",
        "name": "테스트 프롬프트 (safe to delete, upload-limits suite)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_asset_upload_limits.py fixture",
        "template": {"system": "당신은 테스트 어시스턴트입니다.", "file": "template.md"},
        "variables": [{"name": "question", "type": "string", "required": True}],
    }
    manifest.update(overrides)
    return manifest


def _storage_path(asset_id: str, version: str = "1.0.0") -> Path:
    return (settings.storage_root / "prompt" / asset_id / version).resolve()


def _write_policy(tmp_path: Path, **overrides) -> Path:
    policy = {
        "version": "1.0.0",
        "max_single_file_bytes": 200,
        "max_total_request_bytes": 300,
        "max_file_count": 2,
        "rejected_extensions": [".exe"],
    }
    policy.update(overrides)
    path = tmp_path / "asset-upload-policy.json"
    path.write_text(json.dumps(policy), encoding="utf-8")
    return path


@pytest.fixture
def small_policy(tmp_path, monkeypatch):
    """200B single-file / 300B total / 2-file caps — small enough to exercise
    every rejection path with tiny in-memory payloads instead of real
    50MB/150MB fixtures."""
    path = _write_policy(tmp_path)
    monkeypatch.setattr(settings, "asset_upload_policy_path", path)
    return path


async def test_single_file_exceeding_cap_is_rejected(
    client: httpx.AsyncClient, small_policy
) -> None:
    asset_id = str(uuid.uuid4())
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("template.md", b"x" * 300, "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_UPLOAD_FILE_TOO_LARGE"
    assert "template.md" in body["error"]["message"]
    assert body["error"]["trace_id"]

    storage_path = _storage_path(asset_id)
    assert not storage_path.exists() or list(storage_path.iterdir()) == []


async def test_total_request_size_exceeding_cap_is_rejected(
    client: httpx.AsyncClient, small_policy
) -> None:
    """Two files, each individually under the 200B single-file cap, summing
    to 330B > the 300B total-request cap."""
    asset_id = str(uuid.uuid4())
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files=[
            ("files", ("template.md", b"a" * 150, "text/markdown")),
            ("files", ("extra.md", b"b" * 180, "text/markdown")),
        ],
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_UPLOAD_REQUEST_TOO_LARGE"
    assert body["error"]["trace_id"]

    storage_path = _storage_path(asset_id)
    assert not storage_path.exists() or list(storage_path.iterdir()) == []


async def test_too_many_files_is_rejected(client: httpx.AsyncClient, small_policy) -> None:
    asset_id = str(uuid.uuid4())
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files=[
            ("files", ("template.md", b"x", "text/markdown")),
            ("files", ("extra1.md", b"x", "text/markdown")),
            ("files", ("extra2.md", b"x", "text/markdown")),
        ],
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_UPLOAD_TOO_MANY_FILES"
    assert body["error"]["trace_id"]

    storage_path = _storage_path(asset_id)
    assert not storage_path.exists() or list(storage_path.iterdir()) == []


async def test_rejected_extension_is_rejected(client: httpx.AsyncClient, small_policy) -> None:
    asset_id = str(uuid.uuid4())
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("payload.exe", b"MZ\x90\x00", "application/octet-stream")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "ASSET_UPLOAD_EXTENSION_REJECTED"
    assert "payload.exe" in body["error"]["message"]
    assert body["error"]["trace_id"]

    storage_path = _storage_path(asset_id)
    assert not storage_path.exists() or list(storage_path.iterdir()) == []


async def test_content_length_forged_smaller_than_body_is_still_enforced(
    client: httpx.AsyncClient, small_policy
) -> None:
    """Proves enforcement is byte-counted during streaming, not derived from
    the `Content-Length` header: send a real multipart body whose true
    encoded length is 300B(over the 200B single-file cap), but claim a much
    smaller `Content-Length`. The ASGI transport delivers the actual bytes
    regardless of what the header claims (Starlette never trusts
    `Content-Length` to decide how many bytes to read from the stream) — if
    the caps below were ever refactored to read `request.headers[
    'content-length']` instead of counting streamed chunks, this test would
    start passing incorrectly (200 instead of 400), catching that
    regression.
    """
    asset_id = str(uuid.uuid4())
    manifest_json = json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)
    boundary = "----uploadlimitstestboundary"
    file_content = b"y" * 300
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="manifest"\r\n\r\n'
        f"{manifest_json}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="files"; filename="template.md"\r\n'
        f"Content-Type: text/markdown\r\n\r\n"
    ).encode() + file_content + f"\r\n--{boundary}--\r\n".encode()

    true_length = len(body)
    forged_length = 10
    assert forged_length < true_length

    resp = await client.post(
        "/api/v1/assets",
        content=body,
        headers={
            **auth_header("dev-user-token"),
            "content-type": f"multipart/form-data; boundary={boundary}",
            "content-length": str(forged_length),
        },
    )
    assert resp.status_code == 400, resp.text
    body_json = resp.json()
    assert body_json["error"]["code"] == "ASSET_UPLOAD_FILE_TOO_LARGE"

    storage_path = _storage_path(asset_id)
    assert not storage_path.exists() or list(storage_path.iterdir()) == []


async def test_normal_upload_succeeds_and_checksum_is_recorded(
    client: httpx.AsyncClient, small_policy
) -> None:
    asset_id = str(uuid.uuid4())
    content = b"# Template\n\n{{question}}\n"
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("template.md", content, "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    storage_path = _storage_path(asset_id)
    saved_file = storage_path / "template.md"
    assert saved_file.read_bytes() == content

    checksums_path = storage_path / "checksums.sha256"
    assert checksums_path.exists()
    expected_sha256 = hashlib.sha256(content).hexdigest()
    lines = checksums_path.read_text(encoding="utf-8").strip().splitlines()
    parsed = dict(reversed(line.split("  ", 1)) for line in lines)
    assert parsed["template.md"] == expected_sha256


async def test_missing_policy_file_falls_back_to_safe_defaults(
    client: httpx.AsyncClient, tmp_path, monkeypatch
) -> None:
    """`settings.asset_upload_policy_path` pointed at a nonexistent path —
    registration must still succeed via the safe built-in fallback defaults
    (fail closed into working-but-conservative limits, never fail open into
    "no limits", and never crash)."""
    monkeypatch.setattr(
        settings, "asset_upload_policy_path", tmp_path / "does-not-exist.json"
    )
    asset_id = str(uuid.uuid4())
    content = b"# Template\n\n{{question}}\n"
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_prompt_manifest(asset_id), ensure_ascii=False)},
        files={"files": ("template.md", content, "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text

    storage_path = _storage_path(asset_id)
    assert (storage_path / "template.md").read_bytes() == content
    assert (storage_path / "checksums.sha256").exists()
