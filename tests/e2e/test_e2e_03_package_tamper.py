"""E2E-03 — Package 변조 (06-quality-delivery.md §8).

  1. 승인 Bundle 생성      -> POST /api/v1/distributions against the
     already-APPROVED, already-indexed seeded Knowledge
     (`APPROVED_KNOWLEDGE_VERSION_ID`) — reused rather than registering a
     fresh asset here because this scenario is about bundle integrity, not
     indexing; building a bundle only *reads* the existing index files
     (never re-indexes/mutates them, per the task's data-hygiene rule).
  2. 파일 한 Byte 수정     -> flip one byte of a file inside the downloaded
     ZIP, in memory, never touching the live DB/bundle on disk.
  3/4. Desktop Import / Checksum 실패 -> Electron can't launch here, so this
     test instead replicates `apps/desktop-client/electron/bundle-verify.ts`
     (`parseChecksumsFile`/`checkChecksums`, a pure/Electron-free module —
     regex `^([0-9a-fA-F]{64})\\s+(.+)$`, sha256 compare) directly in Python
     against the tampered bytes and asserts it flags the mismatch, i.e. the
     exact check the Desktop Checksum-failure path is built on.
  5/6. Quarantine 유지 / Audit·사용자 메시지 확인 -> the Desktop-side
     Quarantine state transition and its UI message are skipped (Electron
     unavailable) — this test proves the detection the Desktop relies on
     works; it does not exercise the Desktop's reaction to that detection.
"""

from __future__ import annotations

import io
import zipfile

import httpx
import pytest

from tests.e2e.conftest import (
    APPROVED_KNOWLEDGE_VERSION_ID,
    auth,
    check_checksums,
    parse_checksums_file,
    wait_for_distribution,
)

pytestmark = pytest.mark.e2e


async def _build_and_download_bundle(portal: httpx.AsyncClient) -> bytes:
    resp = await portal.post(
        "/api/v1/distributions",
        json={
            "root_type": "ASSET_VERSION",
            "root_id": APPROVED_KNOWLEDGE_VERSION_ID,
            "mode": "OFFLINE_BUNDLE",
        },
        headers=auth("CREATOR"),
    )
    assert resp.status_code == 202, resp.text
    distribution_id = resp.json()["id"]
    distribution = await wait_for_distribution(portal, distribution_id)
    assert distribution["status"] == "SUCCEEDED", distribution

    resp = await portal.get(
        f"/api/v1/distributions/{distribution_id}/download", headers=auth("CREATOR")
    )
    resp.raise_for_status()
    assert resp.headers["content-type"] == "application/zip"
    return resp.content


async def test_e2e_03_tampered_bundle_fails_checksum_verification(
    portal: httpx.AsyncClient,
) -> None:
    bundle_bytes = await _build_and_download_bundle(portal)

    with zipfile.ZipFile(io.BytesIO(bundle_bytes)) as zf:
        names = zf.namelist()
        assert "checksums.sha256" in names, names
        checksums_content = zf.read("checksums.sha256").decode("utf-8")
        declared = parse_checksums_file(checksums_content)
        assert declared, "expected at least one declared checksum entry"

        # Sanity check: the untouched bundle must verify clean first, so the
        # failure we assert below is caused by our tamper, not a pre-existing bug.
        missing, mismatched = check_checksums(declared, zf)
        assert not missing and not mismatched, (missing, mismatched)

        # Step 2: flip one byte of a real, checksummed file (never
        # `checksums.sha256` itself -- that would just make parsing fail,
        # not reproduce a checksum *mismatch*).
        tamper_target = next(name for name in declared if name != "checksums.sha256")
        original = zf.read(tamper_target)
        assert original, f"expected non-empty file to tamper: {tamper_target}"

    tampered_byte = original[0] ^ 0xFF
    tampered_content = bytes([tampered_byte]) + original[1:]

    # Rebuild the zip in memory with the one file swapped, preserving
    # everything else (including checksums.sha256) byte-for-byte.
    out = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(bundle_bytes)) as src,
        zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst,
    ):
        for item in src.infolist():
            data = tampered_content if item.filename == tamper_target else src.read(item.filename)
            dst.writestr(item, data)
    out.seek(0)

    # Steps 3/4: re-verify — the tamper must now be caught.
    with zipfile.ZipFile(out) as tampered_zf:
        missing, mismatched = check_checksums(declared, tampered_zf)
    assert missing == []
    assert mismatched == [tamper_target], (missing, mismatched, tamper_target)


def test_e2e_03_step3to6_desktop_quarantine_flow_not_available() -> None:
    pytest.skip(
        "E2E-03 steps 3-6 (Desktop Import -> Checksum 실패 -> Quarantine 유지 -> "
        "Audit/사용자 메시지 확인) cannot run on this machine: Electron was "
        "quarantined by macOS Gatekeeper (unsigned runtime) this session. The "
        "Checksum-mismatch DETECTION this flow depends on (bundle-verify.ts's "
        "parseChecksumsFile/checkChecksums) is verified directly, byte-for-byte, in "
        "test_e2e_03_tampered_bundle_fails_checksum_verification above."
    )
