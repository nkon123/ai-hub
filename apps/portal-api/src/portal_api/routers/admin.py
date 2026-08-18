"""P15 관리자 설정 router — M02
(01-portal-and-distribution.md §2 P15).

Mostly a read-only "정책·구성 현황" screen, not 8 editable sub-screens: this
PoC has no `users`/`sites`/`roles` tables, so several P15 sub-areas ("사용자
·역할 매핑", "조직·사업장", "Package Trust/Signature 설정", 그리고 "보관기간"
절반의 "보안등급과 보관기간") have no storage to edit. Building forms over
storage that doesn't exist would render a screen that looks functional but
silently does nothing — CLAUDE.md 원칙 5 ("테스트 증거 없는 기능은 완료로
표시하지 않는다")와 정면으로 충돌한다. Most of this reports the *actually
effective* configuration, read from its real source at request time, and
reports each of the 8 sub-areas as either genuinely available or explicitly
미구현 with a named reason + open-decisions.md id (D-065). See that entry
for the full rationale and exactly which sub-areas are which.

**UPDATE (D-065 UPDATE / D-075): one sub-area now IS editable** — the
indexing embedding model (`_build_indexing_embedding_model`,
`list_embedding_models`, `set_indexing_embedding_model` below). It has real
storage (`portal_api.platform_settings`, a `platform_settings` table added
specifically for this) and portal-api's own `_trigger_indexing`
(`routers/assets.py`) actually reads the value back and forwards it to
indexing-runtime. Every other section in this file remains read-only for
the same reason as before — this is not a general precedent for adding more
editable forms without storage.

ADMIN only. Reads use `Permission.ADMIN_SETTINGS_READ`; the one write uses
a separate `Permission.ADMIN_SETTINGS_WRITE` so its denial audit event name
is distinguishable. A denial is recorded as a DENIED `AuditEvent` by
`rbac.require_permission`, same as every other endpoint. A *successful*
read is not separately audited (mirrors `list_audit_events`), but a
*successful write* to the embedding model setting is (a real state change,
unlike every read-only section here).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import httpx
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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.audit import record_audit
from portal_api.auth import UserContext, get_current_user
from portal_api.config import settings
from portal_api.database import get_db
from portal_api.errors import error_response
from portal_api.models import PlatformSetting
from portal_api.platform_settings import INDEXING_EMBED_MODEL_KEY, get_setting, set_setting
from portal_api.rbac import require_permission
from portal_api.schemas import (
    AdminSettingsOut,
    ApprovalWorkflowSectionOut,
    AssetSizeExtensionPolicySectionOut,
    EmbeddingModelInfoOut,
    EmbeddingModelsOut,
    IndexingEmbeddingModelSectionOut,
    IndexingEmbeddingModelUpdateIn,
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


# --- Portal inbound asset-upload policy -------------------------------------
# `packages/schemas/policies/asset-upload-policy.json` is the shared
# Contract `routers/assets.py::create_asset`(M02, POST /api/v1/assets) reads
# directly to enforce per-request size/count/extension limits at
# registration time — see that router's `_read_asset_upload_policy` for the
# enforcement side (streamed, chunk-counted, fail-closed to built-in
# defaults on a missing/malformed file). This function mirrors that same
# fail-closed honesty for the *display* side: a missing/malformed file is
# reported as an explicit error string, never silently treated as "no
# limits" and never silently replaced with the built-in defaults without
# saying so — an admin reading this screen must be able to tell the
# difference between "the policy file says X" and "the file couldn't be
# read, so the code fell back to a default".
def _read_asset_upload_policy() -> tuple[dict, str | None]:
    path = settings.asset_upload_policy_path
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, f"자산 업로드 정책 파일을 찾을 수 없습니다: {path}"
    except (json.JSONDecodeError, OSError) as exc:
        return {}, f"자산 업로드 정책 파일을 읽을 수 없습니다: {exc}"

    if not isinstance(data, dict):
        return {}, f"자산 업로드 정책 파일 형식이 올바르지 않습니다: {path}"

    return (
        {
            "max_single_file_bytes": data.get("max_single_file_bytes"),
            "max_total_request_bytes": data.get("max_total_request_bytes"),
            "max_file_count": data.get("max_file_count"),
            "rejected_extensions": list(data.get("rejected_extensions") or []),
        },
        None,
    )


def _build_asset_size_extension_policy() -> AssetSizeExtensionPolicySectionOut:
    package_policy, package_error = _read_knowledge_package_policy()
    desktop_policy, desktop_error = _read_desktop_bundle_policy()
    upload_policy, upload_error = _read_asset_upload_policy()
    parse_error = (
        " / ".join(e for e in (package_error, desktop_error, upload_error) if e) or None
    )

    if upload_error:
        # Honest about the display-only fallback: the *enforcement* side
        # (`routers/assets.py::create_asset`) still applies its own
        # built-in defaults even when this file can't be read — this note
        # must not claim "no limits apply" just because the display read
        # failed (that would be the exact false-claim bug this screen is
        # being fixed to avoid).
        upload_limit_note = (
            "Portal API의 지식 자산 등록(POST /api/v1/assets)에는 파일 크기·개수·확장자 "
            "제한이 적용됩니다. 다만 정책 파일을 읽지 못해(아래 오류 참고) 현재 이 화면은 "
            "실제 적용 중인 값 대신 코드에 내장된 기본값 기준을 보여줄 수 없습니다 — "
            "등록 시점에는 여전히 안전한 내장 기본값으로 제한이 적용됩니다."
        )
    else:
        upload_limit_note = (
            "Portal API의 지식 자산 등록(POST /api/v1/assets)에는 파일 크기·개수·확장자 "
            "제한이 적용됩니다(아래 '자산 등록 업로드 제한' 참고). 아래 Knowledge "
            "Package/Desktop Offline Bundle 정책은 각각 Knowledge Package 빌드 "
            "시점(M09)과 Desktop Offline Bundle 설치 시점(M04)에 적용되는 별도 정책입니다."
        )

    return AssetSizeExtensionPolicySectionOut(
        source=(
            f"{settings.knowledge_package_policy_path} + "
            f"{settings.desktop_bundle_policy_path} + "
            f"{settings.asset_upload_policy_path}"
        ),
        portal_upload_limit_note=upload_limit_note,
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
        asset_upload_max_single_file_bytes=upload_policy.get("max_single_file_bytes"),
        asset_upload_max_total_request_bytes=upload_policy.get("max_total_request_bytes"),
        asset_upload_max_file_count=upload_policy.get("max_file_count"),
        asset_upload_rejected_extensions=upload_policy.get("rejected_extensions"),
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


async def _build_indexing_embedding_model(db: AsyncSession) -> IndexingEmbeddingModelSectionOut:
    """D-065 UPDATE / D-075: the only P15 sub-area with real storage
    (`portal_api.platform_settings`, `portal.db`'s `platform_settings`
    table) — everything else in this router is read-only reporting. A
    `None` `configured_model` means indexing-runtime's own
    `INDEXING_EMBED_MODEL` default applies (see that setting's docstring);
    this never guesses a value here."""
    row = (
        await db.execute(
            select(PlatformSetting).where(PlatformSetting.key == INDEXING_EMBED_MODEL_KEY)
        )
    ).scalar_one_or_none()

    return IndexingEmbeddingModelSectionOut(
        source="portal.db platform_settings + services/indexing-runtime (GET /indexing/v1/models)",
        configured_model=row.value if row is not None else None,
        updated_at=row.updated_at if row is not None else None,
        updated_by=row.updated_by_user_id if row is not None else None,
        note=(
            "값이 비어 있으면 indexing-runtime 자체 기본값(INDEXING_EMBED_MODEL 설정)이 "
            "적용됩니다. 이 설정을 바꿔도 이미 만들어진 인덱스는 바뀌지 않습니다 — 각 "
            "인덱스는 색인 시점에 index-meta.json에 기록된 자신의 임베딩 모델로만 "
            "검색되며(D-075), 기존 Knowledge에 새 모델을 적용하려면 재인덱싱이 "
            "필요합니다. 모델 계열을 바꾸는 경우 search-runtime의 "
            "SEARCH_QUERY_INSTRUCT_PREFIX도 함께 재검토해야 합니다(D-046/D-075) — "
            "그렇지 않으면 관련도 임계값이 더 이상 작동하지 않을 수 있습니다."
        ),
    )


async def _call_indexing_runtime_models_http() -> tuple[list[dict], str | None, str | None]:
    """Proxies indexing-runtime's `GET /indexing/v1/models` (the service
    that actually owns the embedding relationship, D-075 — portal-api never
    calls Ollama directly per CLAUDE.md).

    Returns `(models, default_embed_model, error_message)`. Never raises —
    `error_message` set (models empty) distinguishes "couldn't ask" from a
    genuinely empty install (`error_message is None`, `models == []`)."""
    url = f"{settings.indexing_runtime_url}/indexing/v1/models"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        return [], None, f"indexing-runtime({url})에 연결할 수 없습니다: {exc}"

    if resp.status_code >= 400:
        try:
            body = resp.json()
            message = (body.get("error") or {}).get("message") or f"HTTP {resp.status_code}"
        except ValueError:
            message = f"HTTP {resp.status_code}"
        return [], None, message

    data = resp.json()
    return list(data.get("models") or []), data.get("default_embed_model"), None


EmbeddingModelsCaller = Callable[[], Awaitable[tuple[list[dict], str | None, str | None]]]


def get_embedding_models_caller() -> EmbeddingModelsCaller:
    """FastAPI dependency seam — overridden in integration tests
    (`app.dependency_overrides[get_embedding_models_caller]`) so the suite
    never needs a real indexing-runtime process running. Mirrors
    `routers.distributions.get_distribution_caller` exactly (same
    rationale, just for a synchronous in-request call rather than a
    background task)."""
    return _call_indexing_runtime_models_http


@router.get("/embedding-models", response_model=None)
async def list_embedding_models(
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    embedding_models_caller: EmbeddingModelsCaller = Depends(get_embedding_models_caller),
) -> EmbeddingModelsOut | JSONResponse:
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ADMIN_SETTINGS_READ, trace_id=trace_id, resource_type="ADMIN_SETTINGS"
    )
    if denial:
        return denial

    models, default_model, error = await embedding_models_caller()
    if error:
        return error_response(
            503,
            "MODEL_UNAVAILABLE",
            f"사용 가능한 임베딩 모델 목록을 가져오지 못했습니다: {error}",
            trace_id,
        )

    return EmbeddingModelsOut(
        models=[
            EmbeddingModelInfoOut(
                name=m.get("name", ""),
                embedding_capable=bool(m.get("embedding_capable")),
                size=m.get("size"),
                modified_at=m.get("modified_at"),
            )
            for m in models
        ],
        default_embed_model=default_model or "",
        source=f"{settings.indexing_runtime_url}/indexing/v1/models",
        trace_id=trace_id,
    )


@router.put("/indexing-embedding-model", response_model=None)
async def set_indexing_embedding_model(
    body: IndexingEmbeddingModelUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: UserContext = Depends(get_current_user),
    embedding_models_caller: EmbeddingModelsCaller = Depends(get_embedding_models_caller),
) -> IndexingEmbeddingModelSectionOut | JSONResponse:
    """ADMIN only (`Permission.ADMIN_SETTINGS_WRITE`, distinct from the read
    permission so its denial audit event is separately identifiable). A
    model that indexing-runtime doesn't report as `embedding_capable` is
    rejected outright (D-065 UPDATE design decision 4) — accepting it would
    surface as a confusing indexing failure much later instead of here,
    now, with the actual list of usable models attached."""
    trace_id = _trace_id()
    denial = await require_permission(
        db, user, Permission.ADMIN_SETTINGS_WRITE, trace_id=trace_id, resource_type="ADMIN_SETTINGS"
    )
    if denial:
        return denial

    model_name = body.model.strip()
    if not model_name:
        return error_response(400, "VALIDATION_ERROR", "모델명을 입력하세요.", trace_id)

    models, _default_model, error = await embedding_models_caller()
    if error:
        return error_response(
            503,
            "MODEL_UNAVAILABLE",
            f"사용 가능한 임베딩 모델 목록을 가져오지 못해 저장할 수 없습니다: {error}",
            trace_id,
        )

    usable = sorted({m.get("name", "") for m in models if m.get("embedding_capable")})
    if model_name not in usable:
        await record_audit(
            db,
            event_type="INDEXING_EMBEDDING_MODEL_UPDATE_REJECTED",
            actor=user,
            resource_type="ADMIN_SETTINGS",
            resource_id="indexing_embedding_model",
            result="FAILED",
            trace_id=trace_id,
            metadata={"requested_model": model_name, "available_embedding_models": usable},
        )
        return error_response(
            400,
            "VALIDATION_ERROR",
            f"'{model_name}'은(는) Ollama에서 임베딩 가능 모델로 확인되지 않습니다.",
            trace_id,
            details={"requested_model": model_name, "available_embedding_models": usable},
        )

    previous_model = await get_setting(db, INDEXING_EMBED_MODEL_KEY)
    await set_setting(
        db,
        INDEXING_EMBED_MODEL_KEY,
        model_name,
        updated_by_user_id=user.user_id,
        trace_id=trace_id,
    )
    await record_audit(
        db,
        event_type="INDEXING_EMBEDDING_MODEL_UPDATED",
        actor=user,
        resource_type="ADMIN_SETTINGS",
        resource_id="indexing_embedding_model",
        result="SUCCESS",
        trace_id=trace_id,
        metadata={"previous_model": previous_model, "new_model": model_name},
    )

    return await _build_indexing_embedding_model(db)


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
        indexing_embedding_model=await _build_indexing_embedding_model(db),
    )
