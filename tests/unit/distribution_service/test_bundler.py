"""Unit tests for the §4.2/§4.4 Bundle Builder (M03) — built against a temp
fixture tree (`tmp_path`), never the live `apps/portal-api/storage` or
`data/indexes`. Exercises `collect()` -> `build_zip_bytes()` -> `verify()`
end to end and inspects the produced ZIP's entry layout directly.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import zipfile

import pytest
from distribution_service import bundler
from distribution_service.bundler import BundleStageError, build_zip_bytes, collect, verify
from distribution_service.contracts import BundleJobRequest, BundleJobRequestItem
from distribution_service.resolver import resolve


@pytest.fixture(autouse=True)
def _patch_agent_runtime_config_root(tmp_path, monkeypatch):
    """Point the D-034 standard-agent/standard-prompt/office-profile lookup
    at a throwaway fixture tree instead of the real
    services/agent-runtime/config/, so these tests never depend on repo
    layout outside this file."""
    config_root = tmp_path / "agent-runtime-config"
    (config_root / "standard-agent").mkdir(parents=True)
    (config_root / "standard-agent" / "agent-manifest.json").write_text('{"id": "std-agent"}')
    (config_root / "standard-prompt").mkdir(parents=True)
    (config_root / "standard-prompt" / "prompt-manifest.json").write_text('{"id": "std-prompt"}')
    (config_root / "standard-prompt" / "template.md").write_text("# template")
    (config_root / "office-profile-default").mkdir(parents=True)
    (config_root / "office-profile-default" / "office-profile.json").write_text(
        json.dumps(
            {
                "name": "test-profile",
                "model_aliases": {"default-chat": {}},
                "allowed_mcp_servers": [],
            }
        )
    )
    monkeypatch.setattr(bundler.settings, "agent_runtime_config_root", config_root)
    return config_root


@pytest.fixture
def knowledge_storage(tmp_path):
    storage_path = tmp_path / "storage" / "knowledge" / "asset-1" / "1.0.0"
    storage_path.mkdir(parents=True)
    (storage_path / "policy.md").write_text("# HR Policy\n휴가 규정...")
    return storage_path


@pytest.fixture
def knowledge_index(tmp_path):
    index_path = tmp_path / "indexes" / "asset-version-1"
    index_path.mkdir(parents=True)
    (index_path / "index-meta.json").write_text('{"chunk_count": 4}')
    (index_path / "parents.json").write_text("{}")
    (index_path / "bm25.pkl").write_bytes(b"\x80\x04fake-pickle")
    return index_path


def _service_definition() -> dict:
    return {
        "id": "service-1",
        "name": "HR 챗봇",
        "version": "1.0.0",
        "agent_ref": {"id": "std-agent-id", "version": "1.0.0"},
        "knowledge_bindings": [{"knowledge_id": "asset-version-1"}],
        "prompt_bindings": [{"prompt_id": "std-prompt-id"}],
        "mcp_bindings": [],
        "model_policy": {"model_alias": "default-chat"},
    }


def _build_request(knowledge_storage, knowledge_index) -> BundleJobRequest:
    root = BundleJobRequestItem(
        asset_id="service-1",
        asset_type="service",
        asset_name="HR 챗봇",
        role="root",
        required=True,
        asset_version_id="service-version-1",
        version="1.0.0",
        status="APPROVED",
    )
    knowledge = BundleJobRequestItem(
        asset_id="asset-1",
        asset_type="knowledge",
        asset_name="HR 정책 Knowledge",
        role="knowledge",
        required=True,
        asset_version_id="asset-version-1",
        version="1.0.0",
        status="APPROVED",
        manifest={"type": "knowledge", "name": "HR 정책 Knowledge"},
        manifest_hash=None,
        storage_path=str(knowledge_storage),
        index_path=str(knowledge_index),
        chunk_count=4,
    )
    agent = BundleJobRequestItem(
        asset_id="std-agent-id",
        asset_type="agent",
        asset_name="Standard Knowledge Chat Agent",
        role="agent",
        required=True,
        status="STANDARD_LOCAL_COPY",
    )
    prompt = BundleJobRequestItem(
        asset_id="std-prompt-id",
        asset_type="prompt",
        asset_name="Standard Knowledge Answer Prompt",
        role="prompt",
        required=True,
        status="STANDARD_LOCAL_COPY",
    )
    return BundleJobRequest(
        job_id="job-1",
        trace_id="trace-1",
        root_type="SERVICE_VERSION",
        root_id="service-version-1",
        target_site_id="site-hq",
        requested_by="dev-user@miracom.com",
        items=[root, knowledge, agent, prompt],
        service_definition=_service_definition(),
    )


def test_bundle_has_exact_section_layout(knowledge_storage, knowledge_index):
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)

    zip_bytes, manifest = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = set(zf.namelist())

    # Top-level §4.2 layout — every required file/section present.
    assert "bundle-manifest.yaml" in names
    assert "profiles/office-profile.yaml" in names
    assert "policies/revocation-list.json" in names
    assert "checksums.sha256" in names
    assert "install-guide.md" in names
    assert "signature.json" not in names  # explicitly out of scope (D-016)

    # Asset subfolders always present (even if a given one ends up empty).
    for prefix in (
        "assets/services/",
        "assets/agents/",
        "assets/knowledge/",
        "assets/prompts/",
        "assets/mcp-config/",
    ):
        assert any(n.startswith(prefix) for n in names), f"missing {prefix}"

    # Real Knowledge content: manifest, source doc, and index artifacts.
    assert "assets/knowledge/asset-1/manifest.json" in names
    assert "assets/knowledge/asset-1/source/policy.md" in names
    assert "assets/knowledge/asset-1/index/index-meta.json" in names
    assert "assets/knowledge/asset-1/index/bm25.pkl" in names

    # Service definition packaged for the SERVICE_VERSION root.
    assert "assets/services/service-1/service-definition.json" in names

    # D-034 standard local copies, not fabricated files.
    assert "assets/agents/standard-agent/agent-manifest.json" in names
    assert "assets/prompts/standard-prompt/prompt-manifest.json" in names
    assert "assets/prompts/standard-prompt/template.md" in names


def test_checksums_file_covers_every_packaged_file_and_matches_content(
    knowledge_storage, knowledge_index
):
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        checksum_lines = zf.read("checksums.sha256").decode("utf-8").strip().splitlines()
        declared = {
            arcname: sha for sha, arcname in (line.split("  ", 1) for line in checksum_lines)
        }

        non_meta_files = [
            n
            for n in zf.namelist()
            if not n.endswith("/")
            and n
            not in {
                "checksums.sha256",
                "bundle-manifest.yaml",
                "profiles/office-profile.yaml",
                "policies/revocation-list.json",
                "install-guide.md",
            }
        ]
        assert non_meta_files, "expected at least one real asset file"
        for name in non_meta_files:
            assert name in declared, f"{name} missing from checksums.sha256"
            actual_hash = hashlib.sha256(zf.read(name)).hexdigest()
            assert declared[name] == actual_hash


def test_extracted_bundle_is_actually_consumable(tmp_path, knowledge_storage, knowledge_index):
    """Regression test for a real air-gapped-extraction bug: a ZIP can have
    the exact right §4.2 entry *names* (as asserted above) and still be
    unusable, if every entry's stored POSIX mode is `0600`. After
    `extractall()` that produces `drw-------` directories — no execute bit,
    so nothing underneath is traversable — which is exactly what a real
    offline site hit running `unzip` then `shasum -a 256 -c
    checksums.sha256`: every line failed with `Permission denied` /
    `FAILED open or read`. This test reproduces that exact check in-process
    so a regression here fails loudly instead of only surfacing on a real
    machine at a real destination site.
    """
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    extract_dir = tmp_path / "extracted"
    extract_dir.mkdir()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        zf.extractall(extract_dir)  # applies each entry's stored mode on POSIX

    saw_dir = False
    saw_file = False
    for root, dirs, files in os.walk(extract_dir):
        for d in dirs:
            path = os.path.join(root, d)
            mode = stat.S_IMODE(os.stat(path).st_mode)
            assert mode & 0o700 == 0o700, f"{path} is not owner-rwx (traversable): {oct(mode)}"
            assert os.access(path, os.X_OK), f"{path} is not traversable"
            saw_dir = True
        for fname in files:
            path = os.path.join(root, fname)
            mode = stat.S_IMODE(os.stat(path).st_mode)
            assert mode & 0o400, f"{path} is not owner-readable: {oct(mode)}"
            assert os.access(path, os.R_OK), f"{path} is not readable"
            with open(path, "rb") as fh:
                fh.read()  # must not raise PermissionError, unlike the real bug
            saw_file = True
    assert saw_dir, "expected at least one extracted directory to check"
    assert saw_file, "expected at least one extracted file to check"

    # Reproduce `shasum -a 256 -c checksums.sha256` in-process, against the
    # files exactly as they landed on disk after extraction — this is the
    # check that failed on every line on the real machine.
    checksums_path = extract_dir / "checksums.sha256"
    checked = 0
    for line in checksums_path.read_text(encoding="utf-8").strip().splitlines():
        expected_hash, arcname = line.split("  ", 1)
        target = extract_dir / arcname
        actual_hash = hashlib.sha256(target.read_bytes()).hexdigest()
        assert actual_hash == expected_hash, f"checksum mismatch for {arcname}"
        checked += 1
    assert checked > 0, "expected at least one checksums.sha256 line to verify"


def test_verify_passes_on_untampered_bundle(knowledge_storage, knowledge_index):
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    verify(zip_bytes, collected)  # must not raise


def test_verify_detects_tampered_bundle(knowledge_storage, knowledge_index):
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    # Tamper: rewrite one asset file's content after the checksums were
    # computed, simulating corruption/tampering between packaging and ship.
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf_read:
        original_entries = {n: zf_read.read(n) for n in zf_read.namelist()}

    tampered_buffer = io.BytesIO()
    with zipfile.ZipFile(tampered_buffer, "w", zipfile.ZIP_DEFLATED) as zf_write:
        for name, data in original_entries.items():
            if name == "assets/knowledge/asset-1/source/policy.md":
                data = b"tampered content"
            zf_write.writestr(name, data)

    with pytest.raises(BundleStageError) as exc_info:
        verify(tampered_buffer.getvalue(), collected)

    assert exc_info.value.code == "PACKAGE_CHECKSUM_MISMATCH"
    assert exc_info.value.stage == "VERIFYING"
    assert exc_info.value.retryable is True


def test_size_limit_exceeded_raises_stage_error(knowledge_storage, knowledge_index, monkeypatch):
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    monkeypatch.setattr(bundler.settings, "max_bundle_size_bytes", 1)

    with pytest.raises(BundleStageError) as exc_info:
        verify(zip_bytes, collected)

    assert exc_info.value.code == "PACKAGE_SIZE_LIMIT_EXCEEDED"
    assert exc_info.value.retryable is False


def test_collect_rejects_path_traversal_in_manifest_derived_names(tmp_path):
    """A manifest-declared asset id containing traversal characters must be
    rejected at COLLECTING with PACKAGE_PATH_UNSAFE, never silently used to
    build an arcname."""
    malicious_item = BundleJobRequestItem(
        asset_id="../../etc",
        asset_type="knowledge",
        asset_name="evil",
        role="knowledge",
        required=True,
        asset_version_id="v1",
        version="1.0.0",
        status="APPROVED",
        manifest={"type": "knowledge"},
    )
    request = BundleJobRequest(
        job_id="job-1",
        trace_id="trace-1",
        root_type="ASSET_VERSION",
        root_id="v1",
        requested_by="dev-user@miracom.com",
        items=[malicious_item],
    )
    plan = resolve(request)

    with pytest.raises(BundleStageError) as exc_info:
        collect(request, plan)

    assert exc_info.value.code == "PACKAGE_PATH_UNSAFE"
    assert exc_info.value.stage == "COLLECTING"


def test_included_assets_carry_asset_version_id_distinct_from_asset_id(
    knowledge_storage, knowledge_index
):
    """D-060 regression guard: agent-runtime/search-runtime key Knowledge
    search by AssetVersion.id, not the parent Asset.id that `asset_id`
    carries — `included_assets[]` must expose `asset_version_id` as its own
    field, and the fixture below deliberately uses DIFFERENT string values
    for the two ids so an implementation that accidentally reuses asset_id
    (the exact D-060 bug) cannot pass this test by coincidence."""
    request = _build_request(knowledge_storage, knowledge_index)
    plan = resolve(request)
    collected = collect(request, plan)
    _, manifest = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    included_by_role = {item["role"]: item for item in manifest["included_assets"]}

    service_item = included_by_role["root"]
    assert service_item["asset_id"] == "service-1"
    assert service_item["asset_version_id"] == "service-version-1"
    assert service_item["asset_id"] != service_item["asset_version_id"]

    knowledge_item = included_by_role["knowledge"]
    assert knowledge_item["asset_id"] == "asset-1"
    assert knowledge_item["asset_version_id"] == "asset-version-1"
    assert knowledge_item["asset_id"] != knowledge_item["asset_version_id"]

    # D-034 STANDARD_LOCAL_COPY items (agent/prompt) have no backing
    # AssetVersion row — must be an honest `None`, never fabricated.
    assert included_by_role["agent"]["asset_version_id"] is None
    assert included_by_role["prompt"]["asset_version_id"] is None


def test_revocation_list_includes_deprecated_and_known_system_wide_entries(
    knowledge_storage, knowledge_index
):
    from distribution_service.contracts import KnownRevocation

    request = _build_request(knowledge_storage, knowledge_index)
    request.items[1].status = "DEPRECATED"  # the knowledge item, still bundleable
    request.known_revocations = [
        KnownRevocation(
            asset_id="other-asset",
            asset_name="Other Asset",
            asset_version_id="other-version",
            version="2.0.0",
            status="SUSPENDED",
        )
    ]
    plan = resolve(request)
    collected = collect(request, plan)
    zip_bytes, _ = build_zip_bytes(request, plan, collected, bundle_id="bundle-123")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        revocation_list = json.loads(zf.read("policies/revocation-list.json"))

    ids = {r["asset_version_id"] for r in revocation_list}
    assert "asset-version-1" in ids  # the DEPRECATED knowledge dependency
    assert "other-version" in ids  # system-wide known revocation
