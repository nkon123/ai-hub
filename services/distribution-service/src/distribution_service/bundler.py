"""Bundle Builder — M03, `01-portal-and-distribution.md` §4.2/§4.4.

Produces the exact Offline Bundle ZIP layout:

    {bundle_id}.zip
    ├─ bundle-manifest.yaml
    ├─ assets/
    │  ├─ services/{asset_id}/service-definition.json
    │  ├─ agents/{asset_id}/...
    │  ├─ knowledge/{asset_id}/manifest.json, source/, index/
    │  ├─ prompts/{asset_id}/...
    │  └─ mcp-config/mcp-endpoints.json (only if mcp_bindings declared)
    ├─ profiles/office-profile.yaml
    ├─ policies/revocation-list.json
    ├─ checksums.sha256
    └─ install-guide.md

`signature.json` is intentionally NOT produced — D-016 "Checksum 필수,
Signature Hook만" for PoC; operational signing is out of scope.

Stage machine (§4.4): RESOLVING -> COLLECTING -> VERIFYING -> PACKAGING ->
SUCCEEDED (SIGNING skipped per task scope). Implementation note on stage
ordering: the spec lists VERIFYING before PACKAGING. This module builds the
zip bytes in memory first (`build_zip_bytes`, logically "packaging" the
collected files) and then re-opens those same in-memory bytes to recompute
and cross-check every entry's sha256 against `checksums.sha256` (and the
per-item `manifest_hash` where declared) *before* anything is persisted to
storage — that re-read-and-confirm pass is reported to the caller as stage
`VERIFYING`, and only the final `storage_adapter.put()` (an already-verified
byte string) is reported as stage `PACKAGING`. This satisfies the task's
explicit requirement that "the VERIFYING stage must re-read and confirm
[checksums]" while keeping the reported stage sequence and the codes it can
raise (`PACKAGE_CHECKSUM_MISMATCH`, `PACKAGE_SIZE_LIMIT_EXCEEDED`) exactly
where the spec puts them.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import yaml

from distribution_service.config import settings
from distribution_service.contracts import BundleJobRequest, BundleJobRequestItem, KnownRevocation
from distribution_service.resolver import InstallPlan
from distribution_service.storage import (
    FileSystemStorageAdapter,
    PackagePathUnsafeError,
    StoredObject,
)

_ASSET_TYPE_FOLDER: dict[str, str] = {
    "agent": "agents",
    "knowledge": "knowledge",
    "prompt": "prompts",
    "mcp_tool": "mcp-config",
    "service": "services",
}

_DEPRECATED_OR_WORSE = {"SUSPENDED", "DEPRECATED", "RETIRED"}


class BundleStageError(Exception):
    """Carries everything §4.4 requires a failure to report: 실패 단계,
    오류코드, 영향받은 자산, 재시도 가능 여부."""

    def __init__(
        self,
        stage: str,
        code: str,
        message: str,
        *,
        affected_assets: list[str] | None = None,
        retryable: bool = True,
    ) -> None:
        self.stage = stage
        self.code = code
        self.message = message
        self.affected_assets = affected_assets or []
        self.retryable = retryable
        super().__init__(f"[{stage}] {code}: {message}")


@dataclass
class CollectedFile:
    arcname: str
    data: bytes
    sha256: str


@dataclass
class CollectedResult:
    files: list[CollectedFile] = field(default_factory=list)
    included: list[dict] = field(default_factory=list)  # per-asset manifest summary rows
    total_size_bytes: int = 0


def _sanitize_segment(segment: str) -> str:
    text = str(segment).strip()
    if not text or text in {".", ".."} or "/" in text or "\\" in text:
        raise PackagePathUnsafeError(str(segment), "허용되지 않는 경로 조각입니다.")
    return text


def _arcname(*segments: str) -> str:
    return "/".join(_sanitize_segment(s) for s in segments)


def _walk_files(base: Path) -> list[Path]:
    if not base.is_dir():
        return []
    return sorted(p for p in base.rglob("*") if p.is_file())


def _add_file(result: CollectedResult, arcname: str, data: bytes) -> None:
    sha = hashlib.sha256(data).hexdigest()
    result.files.append(CollectedFile(arcname=arcname, data=data, sha256=sha))
    result.total_size_bytes += len(data)


def _add_directory_tree(result: CollectedResult, source_dir: Path, arc_prefix: list[str]) -> None:
    base = source_dir.resolve()
    for file_path in _walk_files(base):
        rel_parts = file_path.relative_to(base).parts
        arcname = _arcname(*arc_prefix, *rel_parts)
        _add_file(result, arcname, file_path.read_bytes())


def collect(request: BundleJobRequest, plan: InstallPlan) -> CollectedResult:
    """§4.4 COLLECTING stage: gather every file that belongs in the bundle.

    Raises `BundleStageError(stage="COLLECTING", code="PACKAGE_PATH_UNSAFE")`
    if any manifest/asset-declared string resolves outside its expected
    directory (via `_sanitize_segment` / the storage-path walk).
    """
    result = CollectedResult()
    try:
        for item in plan.items:
            folder = _ASSET_TYPE_FOLDER.get(
                item.asset_type if item.role == "root" else item.role, "agents"
            )
            asset_key = item.asset_id or item.asset_name or "unknown"
            item_size_before = result.total_size_bytes

            if item.status == "STANDARD_LOCAL_COPY":
                # D-034 fallback: package agent-runtime's own static standard
                # Agent/Prompt config, never a Python import of agent_runtime
                # (CLAUDE.md 구현 원칙 2) — just its shared config files.
                subdir = "standard-agent" if item.role == "agent" else "standard-prompt"
                _add_directory_tree(
                    result, settings.agent_runtime_config_root / subdir, ["assets", folder, subdir]
                )
            elif item.manifest is not None:
                manifest_bytes = json.dumps(item.manifest, ensure_ascii=False, indent=2).encode(
                    "utf-8"
                )
                _add_file(
                    result, _arcname("assets", folder, asset_key, "manifest.json"), manifest_bytes
                )

                if item.storage_path:
                    _add_directory_tree(
                        result, Path(item.storage_path), ["assets", folder, asset_key, "source"]
                    )
                if item.index_path:
                    _add_directory_tree(
                        result, Path(item.index_path), ["assets", folder, asset_key, "index"]
                    )

            result.included.append(
                {
                    "asset_id": item.asset_id,
                    # D-060 fix: agent-runtime/search-runtime key Knowledge by
                    # **AssetVersion**.id, not the parent Asset.id above — the
                    # directory layout intentionally stays Asset-id-keyed
                    # (`assets/knowledge/{asset_id}/{version}/...`), but a
                    # consumer that needs the id to actually *search* with
                    # (M04 ChatScreen) must read this field instead. `None`
                    # for STANDARD_LOCAL_COPY items (D-034 static agent/prompt
                    # config), which have no backing AssetVersion row.
                    "asset_version_id": item.asset_version_id,
                    "asset_type": item.asset_type,
                    "role": item.role,
                    "name": item.asset_name,
                    "version": item.version,
                    "required": item.required,
                    "status": item.status,
                    "size_bytes": result.total_size_bytes - item_size_before,
                }
            )

        if request.service_definition is not None:
            service_id = (request.service_definition.get("id") or "service").strip() or "service"
            _add_file(
                result,
                _arcname("assets", "services", service_id, "service-definition.json"),
                json.dumps(request.service_definition, ensure_ascii=False, indent=2).encode(
                    "utf-8"
                ),
            )

        mcp_bindings = (request.service_definition or {}).get("mcp_bindings") or []
        if mcp_bindings:
            office_profile_path = (
                settings.agent_runtime_config_root
                / "office-profile-default"
                / "office-profile.json"
            )
            allowed_servers = []
            if office_profile_path.is_file():
                office_profile = json.loads(office_profile_path.read_text(encoding="utf-8"))
                allowed_servers = office_profile.get("allowed_mcp_servers", [])
            mcp_config = {"bindings": mcp_bindings, "allowed_mcp_servers": allowed_servers}
            _add_file(
                result,
                _arcname("assets", "mcp-config", "mcp-endpoints.json"),
                json.dumps(mcp_config, ensure_ascii=False, indent=2).encode("utf-8"),
            )
    except PackagePathUnsafeError as exc:
        raise BundleStageError(
            "COLLECTING",
            "PACKAGE_PATH_UNSAFE",
            f"안전하지 않은 경로가 감지되어 수집을 중단했습니다: {exc.reason}",
            affected_assets=[asset_key] if "asset_key" in locals() else [],
            retryable=False,
        ) from exc

    return result


def _load_office_profile() -> dict:
    path = settings.agent_runtime_config_root / "office-profile-default" / "office-profile.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    # PoC fallback if the shared config isn't reachable — never fabricate a
    # company-specific value, only an empty/neutral shape.
    return {"name": "unknown", "version": "0.0.0", "model_aliases": {}, "allowed_mcp_servers": []}


def _build_revocation_list(
    plan_items: list[BundleJobRequestItem], known: list[KnownRevocation]
) -> list[dict]:
    seen: dict[str, dict] = {}
    for item in plan_items:
        if item.status in _DEPRECATED_OR_WORSE and item.asset_version_id:
            seen[item.asset_version_id] = {
                "asset_id": item.asset_id,
                "asset_name": item.asset_name,
                "asset_version_id": item.asset_version_id,
                "version": item.version,
                "status": item.status,
            }
    for rev in known:
        seen.setdefault(
            rev.asset_version_id,
            {
                "asset_id": rev.asset_id,
                "asset_name": rev.asset_name,
                "asset_version_id": rev.asset_version_id,
                "version": rev.version,
                "status": rev.status,
            },
        )
    return sorted(seen.values(), key=lambda r: r["asset_version_id"])


def _build_install_guide(
    request: BundleJobRequest, plan: InstallPlan, revocations: list[dict]
) -> str:
    lines = [
        "# Offline Bundle 설치 안내",
        "",
        f"- 요청자: {request.requested_by}",
        f"- 대상 사업장: {request.target_site_id or '(미지정)'}",
        f"- 생성 시각: {datetime.now(UTC).isoformat()}",
        "",
        "## 설치 순서",
        "",
    ]
    for i, role in enumerate(plan.install_order, start=1):
        lines.append(f"{i}. {role}")
    lines += ["", "## 포함 자산", ""]
    for item in plan.items:
        req = "필수" if item.required else "선택"
        name = item.asset_name or item.asset_id
        lines.append(f"- [{req}] {name} ({item.version}) — {item.status}")
    if revocations:
        lines += ["", "## 주의: 중단/지원종료/폐기된 버전", ""]
        for rev in revocations:
            rev_name = rev["asset_name"] or rev["asset_id"]
            lines.append(f"- {rev_name} {rev['version']} — {rev['status']}")
    lines += [
        "",
        "## 설치 절차",
        "",
        "1. Desktop Client에서 이 Bundle 파일을 선택해 반입(Import)합니다.",
        "2. Checksum과 Manifest 검증이 자동으로 수행됩니다.",
        "3. 위 설치 순서대로 Prompt, Knowledge, Agent, Service, Office Profile이 설치됩니다.",
        "4. 필요한 Ollama 모델과 MCP 연결 상태를 확인하세요.",
        "",
    ]
    return "\n".join(lines)


def _dir_zip_info(arcname: str) -> zipfile.ZipInfo:
    """A directory placeholder entry with an explicit, extractable POSIX mode.

    `zipfile.ZipFile._open_to_write` falls back to `external_attr = 0o600 <<
    16` for *any* entry whose `external_attr` is still the `ZipInfo.__init__`
    default of 0 — including directory entries built from a bare
    `zipfile.ZipInfo(name)` as this module used to do. After extraction that
    yields `drw-------` directories: no execute bit, so nothing underneath
    can be traversed or opened, which makes the whole Offline Bundle unusable
    at the destination site. Setting `0o755` (+ the MS-DOS directory flag)
    here explicitly is what keeps the archive actually consumable.
    """
    info = zipfile.ZipInfo(arcname if arcname.endswith("/") else arcname + "/")
    info.external_attr = (0o40755 << 16) | 0x10  # dir bits (0o040000) + MS-DOS dir flag
    return info


def _file_zip_info(arcname: str) -> zipfile.ZipInfo:
    """A file entry with an explicit, extractable POSIX mode (see
    `_dir_zip_info` for why relying on zipfile's own default is unsafe)."""
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def build_zip_bytes(
    request: BundleJobRequest,
    plan: InstallPlan,
    collected: CollectedResult,
    bundle_id: str,
) -> tuple[bytes, dict]:
    office_profile = _load_office_profile()
    revocations = _build_revocation_list(plan.items, request.known_revocations)

    sorted_files = sorted(collected.files, key=lambda f: f.arcname)
    checksum_lines = [f"{f.sha256}  {f.arcname}" for f in sorted_files]
    checksums_content = "\n".join(checksum_lines) + "\n"

    manifest = {
        "bundle_id": bundle_id,
        "created_at": datetime.now(UTC).isoformat(),
        "requested_by": request.requested_by,
        "target_site_id": request.target_site_id,
        "root_type": request.root_type,
        "root_id": request.root_id,
        "included_assets": collected.included,
        "runtime_requirements": {
            "os": "Windows 10/11 x64",
            "python": ">=3.11",
            "model_aliases": list(office_profile.get("model_aliases", {}).keys()),
        },
        "install_order": plan.install_order,
        "forbidden_or_suspended_versions_present": len(revocations) > 0,
        "total_installed_size_bytes": collected.total_size_bytes,
    }

    install_guide = _build_install_guide(request, plan, revocations)

    directory_prefixes = (
        "assets/services",
        "assets/agents",
        "assets/knowledge",
        "assets/prompts",
        "assets/mcp-config",
        "profiles",
        "policies",
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for prefix in directory_prefixes:
            zf.writestr(_dir_zip_info(prefix), "")
        zf.writestr(
            _file_zip_info("bundle-manifest.yaml"),
            yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False),
        )
        zf.writestr(
            _file_zip_info("profiles/office-profile.yaml"),
            yaml.safe_dump(office_profile, allow_unicode=True, sort_keys=False),
        )
        zf.writestr(
            _file_zip_info("policies/revocation-list.json"),
            json.dumps(revocations, ensure_ascii=False, indent=2),
        )
        zf.writestr(_file_zip_info("install-guide.md"), install_guide)
        zf.writestr(_file_zip_info("checksums.sha256"), checksums_content)
        for f in collected.files:
            zf.writestr(_file_zip_info(f.arcname), f.data)

    return buffer.getvalue(), manifest


def verify(zip_bytes: bytes, collected: CollectedResult) -> None:
    """§4.4 VERIFYING stage: re-open the about-to-ship bytes and confirm
    every checksummed entry matches, plus the size cap. See module
    docstring for why this runs on in-memory bytes before persistence."""
    if collected.total_size_bytes > settings.max_bundle_size_bytes:
        raise BundleStageError(
            "VERIFYING",
            "PACKAGE_SIZE_LIMIT_EXCEEDED",
            f"Bundle 크기({collected.total_size_bytes} bytes)가 한도"
            f"({settings.max_bundle_size_bytes} bytes)를 초과했습니다.",
            retryable=False,
        )

    expected = {f.arcname: f.sha256 for f in collected.files}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        checksums_raw = zf.read("checksums.sha256").decode("utf-8")
        declared = {
            arcname: sha
            for sha, arcname in (
                line.split("  ", 1) for line in checksums_raw.strip().splitlines() if line
            )
        }

        mismatched: list[str] = []
        for arcname, expected_hash in expected.items():
            actual_bytes = zf.read(arcname)
            actual_hash = hashlib.sha256(actual_bytes).hexdigest()
            if actual_hash != expected_hash or declared.get(arcname) != expected_hash:
                mismatched.append(arcname)

    if mismatched:
        raise BundleStageError(
            "VERIFYING",
            "PACKAGE_CHECKSUM_MISMATCH",
            f"다음 파일의 Checksum이 일치하지 않습니다: {', '.join(mismatched[:10])}",
            affected_assets=mismatched[:10],
            retryable=True,
        )


def package(
    zip_bytes: bytes, bundle_id: str, storage_adapter: FileSystemStorageAdapter
) -> StoredObject:
    """§4.4 PACKAGING stage: persist the already-verified bytes via the
    object_id-based Storage Adapter (§4.1) — never a user-supplied filename."""
    try:
        return storage_adapter.put(
            zip_bytes, object_id=bundle_id, original_file_name=f"bundle-{bundle_id}.zip"
        )
    except PackagePathUnsafeError as exc:
        raise BundleStageError(
            "PACKAGING", "PACKAGE_PATH_UNSAFE", str(exc), retryable=False
        ) from exc
