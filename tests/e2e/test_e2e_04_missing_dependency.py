"""E2E-04 — 의존성 누락 (06-quality-delivery.md §8).

  1. Knowledge 파일을 Bundle에서 제거 -> build a real bundle (same
     already-APPROVED seeded Knowledge as E2E-03; read-only, no re-index),
     then remove one declared file from the ZIP entirely (not just
     corrupt it — this is the "missing", not "mismatched", case).
  2. Import 검증 실패                 -> replicate
     `bundle-verify.ts::checkChecksums`'s `missing[]` detection directly
     (same rationale as E2E-03: Electron unavailable on this machine).
  3. 어떤 자산·파일이 누락됐는지 표시 -> assert the missing arcname is
     precisely identified, not just "verification failed".
  4. 부분 설치 없음 확인              -> Desktop-side atomicity (no files
     get installed when verification fails before install starts) is a
     Desktop Client behavior; skipped here with a named reason, same as
     E2E-03 steps 3-6.
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


async def test_e2e_04_bundle_with_removed_file_fails_dependency_verification(
    portal: httpx.AsyncClient,
) -> None:
    # Step 1a: build a real, valid bundle first.
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
    bundle_bytes = resp.content

    with zipfile.ZipFile(io.BytesIO(bundle_bytes)) as zf:
        checksums_content = zf.read("checksums.sha256").decode("utf-8")
        declared = parse_checksums_file(checksums_content)
        # Pick a real Knowledge asset file to remove (not the manifest/
        # checksums files themselves) so the failure is unambiguously a
        # missing *dependency file*, matching the scenario's title.
        candidates = [
            name
            for name in declared
            if name.startswith("assets/knowledge/") and name != "checksums.sha256"
        ]
        assert candidates, f"expected at least one knowledge asset file in bundle: {declared}"
        removed_name = candidates[0]

        # Sanity: the untouched bundle verifies clean first.
        missing, mismatched = check_checksums(declared, zf)
        assert not missing and not mismatched, (missing, mismatched)

    # Step 1b: rebuild the zip with that one file entirely removed.
    out = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(bundle_bytes)) as src,
        zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst,
    ):
        for item in src.infolist():
            if item.filename == removed_name:
                continue
            dst.writestr(item, src.read(item.filename))
    out.seek(0)

    # Steps 2/3: verification must fail and name exactly the missing file.
    with zipfile.ZipFile(out) as truncated_zf:
        missing, mismatched = check_checksums(declared, truncated_zf)
    assert missing == [removed_name], (missing, removed_name)
    assert mismatched == []


def test_e2e_04_step4_no_partial_install_not_available() -> None:
    pytest.skip(
        "E2E-04 step 4 (부분 설치 없음 확인) is a Desktop Client install-atomicity "
        "behavior (bundle-install.ts treats any verification FAIL, including a missing "
        "file, as a hard stop before any file is written) and cannot be exercised "
        "without Electron, which is quarantined by macOS Gatekeeper on this machine. "
        "The missing-file DETECTION that gates that stop is verified directly above."
    )
