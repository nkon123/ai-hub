"""P15 관리자 설정 router — M02
(01-portal-and-distribution.md §2 P15).

Deliberately a single read-only endpoint, not 8 editable sub-screens: this
PoC has no `users`/`sites`/`roles` tables, so several P15 sub-areas ("사용자
·역할 매핑", "조직·사업장", "Package Trust/Signature 설정", 그리고 "보관기간"
절반의 "보안등급과 보관기간") have no storage to edit. Building forms over
storage that doesn't exist would render a screen that looks functional but
silently does nothing — CLAUDE.md 원칙 5 ("테스트 증거 없는 기능은 완료로
표시하지 않는다")와 정면으로 충돌한다. Instead this reports the *actually
effective* configuration, read from its real source at request time, and
reports each of the 8 sub-areas as either genuinely available or explicitly
미구현 with a named reason + open-decisions.md id (D-065). See that entry
for the full rationale and exactly which sub-areas are which.

ADMIN only (`Permission.ADMIN_SETTINGS_READ`) — a denial is recorded as a
DENIED `AuditEvent` by `rbac.require_permission`, same as every other
endpoint. A *successful* read is not separately audited, mirroring
`list_audit_events`/`list_asset_version_lifecycle` (no other GET-only
admin/governance screen in this codebase writes a SUCCESS audit row for
being viewed).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import UTC, datetime

import yaml
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from observability import get_trace_id
from security_policy import (
    ACL_METADATA_FIELDS,
    NEXT_STAGE,
    ROLE_PERMISSIONS,
    Classification,
    Permission,
    Stage,
    redact_if_secret,
)
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.rbac import require_permission
from portal_api.schemas import (
    AdminSettingsOut,
    ApprovalWorkflowSectionOut,
    AssetSizeExtensionPolicySectionOut,
    McpServerAliasSettingOut,
    ModelAliasSettingOut,
    ModelEndpointAliasSectionOut,
    NotImplementedInfoOut,
    OfficeProfileSectionOut,
    OrganizationSiteSectionOut,
    PackageTrustSignatureSectionOut,
    RetentionSubsectionOut,
    RolePermissionRowOut,
    SecurityClassificationRetentionSectionOut,
    SecurityClassificationSubsectionOut,
    UserRoleMappingSectionOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _trace_id() -> str:
    return get_trace_id() or str(uuid.uuid4())


def _build_user_role_mapping() -> UserRoleMappingSectionOut:
    """실제 RBAC 매트릭스 그대로. 사용자 디렉터리(`users` 테이블)가 없어
    "누가 어떤 역할을 가졌는가"는 보여줄 수 없다 — 그 사실을 note에 명시한다
    (숨기지 않음)."""
    return UserRoleMappingSectionOut(
        source="packages/security-policy/src/security_policy/roles.py (ROLE_PERMISSIONS)",
        roles=[
            RolePermissionRowOut(
                role=role.value,
                permissions=sorted(p.value for p in perms),
            )
            for role, perms in ROLE_PERMISSIONS.items()
        ],
        note=(
            "사용자·역할 매핑 자체를 저장하는 사용자 디렉터리(users 테이블)는 "
            "없습니다. 아래는 역할별로 실제 부여된 권한 매트릭스이며, 어떤 "
            "사용자가 어떤 역할을 가졌는지는 이 PoC의 Test Identity Adapter"
            "(D-001)가 요청의 Bearer Token으로부터 매 요청마다 고정 매핑할 "
            "뿐 별도로 저장·조회할 수 없습니다."
        ),
    )


def _build_organization_site() -> OrganizationSiteSectionOut:
    return OrganizationSiteSectionOut(
        not_implemented=NotImplementedInfoOut(
            reason=(
                "조직·사업장을 저장하는 테이블이 없습니다. 사업장 id는 "
                "distribution_requests 등 개별 행의 자유 문자열(site_id)로만 "
                "존재하고, office-profile.json의 sites 목록은 그 프로필이 "
                "적용되는 사업장 라벨을 선언할 뿐 조직·사업장 자체를 등록·"
                "관리하는 저장소가 아닙니다."
            ),
            decision_id="D-065",
        ),
    )


def _read_office_profile() -> tuple[dict | None, str | None]:
    """Returns (profile dict, error message). Never raises — a missing/
    malformed file is reported as an error string, not guessed at."""
    path = settings.office_profile_path
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, f"Office Profile 파일을 찾을 수 없습니다: {path}"
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"Office Profile 파일을 읽을 수 없습니다: {exc}"


def _build_office_profile_sections(
    profile: dict | None,
) -> tuple[OfficeProfileSectionOut, ModelEndpointAliasSectionOut]:
    """`profile` is `None` when `_read_office_profile` failed (missing/
    malformed file) — the caller already logs that error; this returns
    empty-but-honest sections (empty strings/lists, never guessed values)
    rather than raising, so the rest of the P15 payload still renders."""
    source = str(settings.office_profile_path)
    if profile is None:
        return (
            OfficeProfileSectionOut(source=source, name="", version="", org="", sites=[]),
            ModelEndpointAliasSectionOut(source=source, model_aliases=[], mcp_servers=[]),
        )

    security = profile.get("security") or {}
    office_section = OfficeProfileSectionOut(
        source=source,
        name=profile.get("name", ""),
        version=profile.get("version", ""),
        org=profile.get("org", ""),
        sites=list(profile.get("sites") or []),
        max_classification_allowed=security.get("max_classification_allowed"),
        audit_retention_days=security.get("audit_retention_days"),
    )

    model_aliases = [
        ModelAliasSettingOut(
            alias=alias,
            provider=cfg.get("provider", ""),
            model_id=cfg.get("model_id", ""),
            # Endpoints in this schema are loopback/internal URLs only (no
            # credential field exists per office-profile.schema.json), but
            # redact defensively in case a hand-edited file ever embeds one
            # (e.g. an http://user:pass@host authority) — never trust the
            # schema alone to guarantee a Secret never reaches this screen.
            endpoint=redact_if_secret(cfg.get("endpoint", "")),
            max_context_tokens=cfg.get("max_context_tokens"),
        )
        for alias, cfg in (profile.get("model_aliases") or {}).items()
    ]
    mcp_servers = [
        McpServerAliasSettingOut(
            alias=srv.get("alias", ""),
            endpoint=redact_if_secret(srv.get("endpoint", "")),
            allowed_tools=list(srv.get("allowed_tools") or []),
        )
        for srv in (profile.get("allowed_mcp_servers") or [])
    ]
    alias_section = ModelEndpointAliasSectionOut(
        source=source, model_aliases=model_aliases, mcp_servers=mcp_servers
    )
    return office_section, alias_section


def _read_knowledge_package_policy() -> tuple[dict | None, str | None]:
    path = settings.knowledge_package_policy_path
    try:
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not isinstance(data, dict):
            return None, f"Package 정책 파일 형식이 올바르지 않습니다: {path}"
        return data, None
    except FileNotFoundError:
        return None, f"Package 정책 파일을 찾을 수 없습니다: {path}"
    except (yaml.YAMLError, OSError) as exc:
        return None, f"Package 정책 파일을 읽을 수 없습니다: {exc}"


# --- Desktop bundle-install policy ------------------------------------------
# `packages/schemas/policies/bundle-install-policy.json` is the shared
# Contract `apps/desktop-client/electron/bundle-verify.ts` (M04) also reads
# directly (CLAUDE.md 원칙 2/3) — portal-api never imports M04's TypeScript
# source or parses its formatting, it reads the same data file M04 reads.
# See `packages/schemas/policies/bundle-install-policy.schema.json` for the
# contract shape. A missing/malformed file is reported as an honest error
# string here, never guessed at or silently defaulted.
def _read_desktop_bundle_policy() -> tuple[dict, str | None]:
    path = settings.desktop_bundle_policy_path
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, f"Desktop bundle-install 정책 파일을 찾을 수 없습니다: {path}"
    except (json.JSONDecodeError, OSError) as exc:
        return {}, f"Desktop bundle-install 정책 파일을 읽을 수 없습니다: {exc}"

    if not isinstance(data, dict):
        return {}, f"Desktop bundle-install 정책 파일 형식이 올바르지 않습니다: {path}"

    size_caps = data.get("size_caps") or {}
    return (
        {
            "archive_extensions": list(data.get("archive_extensions") or []),
            "executable_extensions": list(data.get("executable_extensions") or []),
            "max_total_uncompressed_bytes": size_caps.get("max_total_uncompressed_bytes"),
            "max_single_file_uncompressed_bytes": size_caps.get(
                "max_single_file_uncompressed_bytes"
            ),
            "max_compression_ratio": size_caps.get("max_compression_ratio"),
        },
        None,
    )


def _build_asset_size_extension_policy() -> AssetSizeExtensionPolicySectionOut:
    package_policy, package_error = _read_knowledge_package_policy()
    desktop_policy, desktop_error = _read_desktop_bundle_policy()
    parse_error = " / ".join(e for e in (package_error, desktop_error) if e) or None

    return AssetSizeExtensionPolicySectionOut(
        source=(
            f"{settings.knowledge_package_policy_path} + "
            f"{settings.desktop_bundle_policy_path}"
        ),
        portal_upload_limit_note=(
            "Portal API의 지식 자산 등록(POST /api/v1/assets)에는 별도의 "
            "파일 크기·확장자 제한이 코드에 존재하지 않습니다 — 아래 두 "
            "정책은 각각 Knowledge Package 빌드 시점(M09)과 Desktop Offline "
            "Bundle 설치 시점(M04)에 적용되는 정책입니다."
        ),
        knowledge_package_forbidden_filenames=(
            list(package_policy.get("forbidden_filenames") or []) if package_policy else []
        ),
        knowledge_package_fail_on_fatal=(
            (package_policy.get("verification") or {}).get("fail_on_fatal")
            if package_policy
            else None
        ),
        desktop_bundle_forbidden_archive_extensions=desktop_policy.get("archive_extensions"),
        desktop_bundle_forbidden_executable_extensions=desktop_policy.get("executable_extensions"),
        desktop_bundle_max_total_uncompressed_bytes=desktop_policy.get(
            "max_total_uncompressed_bytes"
        ),
        desktop_bundle_max_single_file_uncompressed_bytes=desktop_policy.get(
            "max_single_file_uncompressed_bytes"
        ),
        desktop_bundle_max_compression_ratio=desktop_policy.get("max_compression_ratio"),
        parse_error=parse_error,
    )


def _build_approval_workflow() -> ApprovalWorkflowSectionOut:
    chain: list[str] = [Stage.TECHNICAL.value]
    cursor: Stage | None = Stage.TECHNICAL
    while True:
        nxt = NEXT_STAGE.get(cursor) if cursor else None
        if nxt is None:
            break
        chain.append(nxt.value)
        cursor = nxt
    return ApprovalWorkflowSectionOut(
        source=(
            "packages/security-policy/src/security_policy/review.py (Stage/NEXT_STAGE) + "
            "portal_api.config.settings.require_service_version_approval"
        ),
        stage_chain=chain,
        require_service_version_approval=settings.require_service_version_approval,
        require_service_version_approval_source=(
            "env PORTAL_REQUIRE_SERVICE_VERSION_APPROVAL (D-063)"
        ),
    )


def _build_security_classification_retention() -> SecurityClassificationRetentionSectionOut:
    # search-runtime (M08) is a separate service/process — portal-api does
    # not import its internal settings module (CLAUDE.md 원칙 2) and cannot
    # observe that other process's actual environment. This reads the
    # SAME env var name from Portal API's own process only, which is the
    # honest limit of what this screen can report without a cross-process
    # config API that doesn't exist — the caveat says so explicitly rather
    # than implying a verified live read of search-runtime itself.
    allow_unknown_raw = os.environ.get("SEARCH_ALLOW_UNKNOWN_CLASSIFICATION", "false")
    allow_unknown = allow_unknown_raw.strip().lower() in {"1", "true", "yes"}

    classification = SecurityClassificationSubsectionOut(
        source=(
            "packages/security-policy/src/security_policy/classification.py (Classification, "
            "ACL_METADATA_FIELDS) — search-runtime 정책은 D-062 참고"
        ),
        classification_levels=[c.value for c in Classification],
        acl_metadata_fields=sorted(ACL_METADATA_FIELDS),
        allow_unknown_classification=allow_unknown,
        allow_unknown_classification_caveat=(
            "이 값은 Portal API 프로세스 자체의 SEARCH_ALLOW_UNKNOWN_CLASSIFICATION "
            "환경변수를 읽은 것입니다(기본 false=Fail-closed, D-062). search-runtime은 "
            "별도 프로세스로 실행되므로 그 프로세스의 실제 값과 다를 수 있습니다 — "
            "Portal API가 다른 서비스의 내부 설정을 원격으로 조회할 수단이 아직 없습니다."
        ),
    )
    retention = RetentionSubsectionOut(
        not_implemented=NotImplementedInfoOut(
            reason=(
                "보관기간(Retention) 정책을 저장·집행하는 코드나 설정이 어디에도 "
                "없습니다. office-profile.json의 security.audit_retention_days는 "
                "AI Service 실행 정책값 선언일 뿐 실제 Audit/문서 보관·삭제를 "
                "집행하지 않습니다(참고용으로 Office Profile 절에 그대로 표시됨)."
            ),
            decision_id="D-065",
        ),
    )
    return SecurityClassificationRetentionSectionOut(
        classification=classification, retention=retention
    )


def _build_package_trust_signature() -> PackageTrustSignatureSectionOut:
    return PackageTrustSignatureSectionOut(
        not_implemented=NotImplementedInfoOut(
            reason=(
                "Package Signature는 Checksum(SHA-256)만 필수이고 실제 PKI/서명키 "
                "발급·검증은 구현되어 있지 않습니다(D-016). Desktop Installer 코드 "
                "서명 인증서도 아직 발급되지 않았습니다(D-048). Trust Store 설정 "
                "화면이 관리할 대상 자체가 없습니다."
            ),
            decision_id="D-016",
        ),
    )


@router.get("/settings", response_model=None)
async def get_admin_settings(
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
) -> AdminSettingsOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ADMIN_SETTINGS_READ, trace_id=trace_id, resource_type="ADMIN_SETTINGS"
    )
    if denial:
        return denial

    profile, profile_error = _read_office_profile()
    if profile_error:
        logger.warning("P15 admin settings: office profile unavailable: %s", profile_error)
    office_section, alias_section = _build_office_profile_sections(profile)

    return AdminSettingsOut(
        generated_at=datetime.now(UTC),
        trace_id=trace_id,
        user_role_mapping=_build_user_role_mapping(),
        organization_site=_build_organization_site(),
        office_profile=office_section,
        model_endpoint_alias=alias_section,
        asset_size_extension_policy=_build_asset_size_extension_policy(),
        approval_workflow=_build_approval_workflow(),
        security_classification_retention=_build_security_classification_retention(),
        package_trust_signature=_build_package_trust_signature(),
    )
