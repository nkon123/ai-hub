"""Role/Permission enums and the RBAC decision matrix — M11.

Framework-free by design: no FastAPI/SQLAlchemy imports. `apps/portal-api`
(M02) depends on this module for authorization decisions; this module never
depends back on M02 or any web framework (CLAUDE.md 구현 원칙 2, 7).

The permission matrix mirrors the "주요 권한" column of
`docs/implementation-spec/01-portal-and-distribution.md` §3.2 and the role
table in `docs/implementation-spec/README.md` §4.
"""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    """The 7 platform roles — README.md §4. A user may hold several; the
    caller (M02) is responsible for resolving which single role applies to
    a given request in this PoC (D-001: no multi-role composition yet)."""

    USER = "USER"
    CREATOR = "CREATOR"
    TECH_REVIEWER = "TECH_REVIEWER"
    SECURITY_REVIEWER = "SECURITY_REVIEWER"
    RELEASE_MANAGER = "RELEASE_MANAGER"
    AUDITOR = "AUDITOR"
    ADMIN = "ADMIN"


class Permission(StrEnum):
    ASSET_READ = "ASSET_READ"
    ASSET_CREATE = "ASSET_CREATE"
    ASSET_EDIT_DRAFT = "ASSET_EDIT_DRAFT"
    ASSET_SUBMIT_REVIEW = "ASSET_SUBMIT_REVIEW"
    ASSET_VALIDATE = "ASSET_VALIDATE"
    # D-041 후속(ServiceVersion 자체 검토 체인): mirrors ASSET_SUBMIT_REVIEW
    # exactly, kept as its own permission (not reused across subject types)
    # so a future role split between "제작자가 자산을 제출" and "제작자가
    # 서비스를 제출" stays possible without touching this enum again.
    SERVICE_SUBMIT_REVIEW = "SERVICE_SUBMIT_REVIEW"
    REVIEW_LIST = "REVIEW_LIST"
    REVIEW_DECIDE_TECHNICAL = "REVIEW_DECIDE_TECHNICAL"
    REVIEW_DECIDE_SECURITY = "REVIEW_DECIDE_SECURITY"
    REVIEW_DECIDE_RELEASE = "REVIEW_DECIDE_RELEASE"
    ASSET_SUSPEND = "ASSET_SUSPEND"
    ASSET_DEPRECATE = "ASSET_DEPRECATE"
    # P16 수명주기/회수 (01-portal-and-distribution.md §2 P16). Reading the
    # lifecycle screen and the impact query is intentionally narrower than
    # ASSET_READ (granted to every role) — P16's audience is RELEASE_MANAGER,
    # so a fourth read-only permission gates it instead of reusing ASSET_READ.
    LIFECYCLE_READ = "LIFECYCLE_READ"
    ASSET_RETIRE = "ASSET_RETIRE"
    ASSET_SET_REPLACEMENT = "ASSET_SET_REPLACEMENT"
    ASSET_REVOKE = "ASSET_REVOKE"
    SERVICE_READ = "SERVICE_READ"
    SERVICE_CREATE = "SERVICE_CREATE"
    SERVICE_EDIT_DRAFT = "SERVICE_EDIT_DRAFT"
    DEPLOYMENT_CREATE = "DEPLOYMENT_CREATE"
    DEPLOYMENT_PUBLISH = "DEPLOYMENT_PUBLISH"
    DEPLOYMENT_SUSPEND = "DEPLOYMENT_SUSPEND"
    DEPLOYMENT_ROLLBACK = "DEPLOYMENT_ROLLBACK"
    DISTRIBUTION_CREATE = "DISTRIBUTION_CREATE"
    DOWNLOAD_READ = "DOWNLOAD_READ"
    AUDIT_READ = "AUDIT_READ"
    # P12 Knowledge 품질 (01-portal-and-distribution.md §2 P12). Reading
    # evaluation results/list reuses ASSET_READ (already granted to every
    # role) — these three are only for the mutating/sensitive actions.
    EVALUATION_RUN = "EVALUATION_RUN"
    EVALUATION_NOTE = "EVALUATION_NOTE"
    EVALUATION_SOURCE_VIEW = "EVALUATION_SOURCE_VIEW"
    # P15 관리자 설정 (01-portal-and-distribution.md §2 P15). Read-only
    # "정책·구성 현황" screen — no role other than ADMIN is listed under
    # ROLE_PERMISSIONS for it (it only reaches ADMIN via `_ALL_PERMISSIONS`
    # below), kept as its own Permission rather than an ad-hoc `role ==
    # "ADMIN"` check in the router so the denial audit event name
    # (`PERMISSION_DENIED:ADMIN_SETTINGS_READ`) and the RBAC decision both
    # go through the same central matrix as every other endpoint.
    ADMIN_SETTINGS_READ = "ADMIN_SETTINGS_READ"


class PermissionDeniedError(Exception):
    """Raised by `require_permission`. Package-local — never
    `fastapi.HTTPException` (this package must stay framework-free)."""

    def __init__(self, role: Role, permission: Permission) -> None:
        self.role = role
        self.permission = permission
        super().__init__(f"Role {role.value} lacks permission {permission.value}")


_ALL_PERMISSIONS: frozenset[Permission] = frozenset(Permission)

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.USER: frozenset(
        {
            Permission.ASSET_READ,
            Permission.SERVICE_READ,
            Permission.DISTRIBUTION_CREATE,
            Permission.DOWNLOAD_READ,
        }
    ),
    Role.CREATOR: frozenset(
        {
            Permission.ASSET_READ,
            Permission.ASSET_CREATE,
            Permission.ASSET_EDIT_DRAFT,
            Permission.ASSET_SUBMIT_REVIEW,
            Permission.ASSET_VALIDATE,
            Permission.SERVICE_READ,
            Permission.SERVICE_CREATE,
            Permission.SERVICE_EDIT_DRAFT,
            Permission.SERVICE_SUBMIT_REVIEW,
            Permission.DEPLOYMENT_CREATE,
            Permission.DISTRIBUTION_CREATE,
            Permission.DOWNLOAD_READ,
            # P12: owning CREATOR may run an evaluation on their own Knowledge
            # (ownership itself is enforced by the router, same pattern as
            # ASSET_SUBMIT_REVIEW) and, as an author, may see unmasked source
            # content in the result (D-056) — but may not record a 기준 미달
            # 사유 (that is reviewer-only, see open-decisions.md D-056).
            Permission.EVALUATION_RUN,
            Permission.EVALUATION_SOURCE_VIEW,
        }
    ),
    Role.TECH_REVIEWER: frozenset(
        {
            Permission.ASSET_READ,
            Permission.SERVICE_READ,
            Permission.REVIEW_LIST,
            Permission.REVIEW_DECIDE_TECHNICAL,
            Permission.EVALUATION_RUN,
            Permission.EVALUATION_NOTE,
            Permission.EVALUATION_SOURCE_VIEW,
        }
    ),
    Role.SECURITY_REVIEWER: frozenset(
        {
            Permission.ASSET_READ,
            Permission.SERVICE_READ,
            Permission.REVIEW_LIST,
            Permission.REVIEW_DECIDE_SECURITY,
            Permission.EVALUATION_RUN,
            Permission.EVALUATION_NOTE,
            Permission.EVALUATION_SOURCE_VIEW,
        }
    ),
    Role.RELEASE_MANAGER: frozenset(
        {
            Permission.ASSET_READ,
            Permission.SERVICE_READ,
            Permission.REVIEW_LIST,
            Permission.REVIEW_DECIDE_RELEASE,
            Permission.ASSET_SUSPEND,
            Permission.ASSET_DEPRECATE,
            Permission.LIFECYCLE_READ,
            Permission.ASSET_RETIRE,
            Permission.ASSET_SET_REPLACEMENT,
            Permission.ASSET_REVOKE,
            Permission.DEPLOYMENT_PUBLISH,
            Permission.DEPLOYMENT_SUSPEND,
            Permission.DEPLOYMENT_ROLLBACK,
            # Publish 의사결정을 위해 마스킹 없이 평가 결과를 볼 수 있어야
            # 하지만, 평가 실행/사유 기록 자체는 검토자 역할이 아니므로 부여
            # 하지 않는다 (D-056).
            Permission.EVALUATION_SOURCE_VIEW,
        }
    ),
    Role.AUDITOR: frozenset(
        {
            Permission.ASSET_READ,
            Permission.SERVICE_READ,
            Permission.AUDIT_READ,
            Permission.DOWNLOAD_READ,
            # P16: AUDITOR가 수명주기 화면·영향 조회를 열람할 수 있어야 감사
            # 목적의 사후 확인이 가능하다(변경 권한은 없음 — RETIRE/SET_
            # REPLACEMENT/REVOKE는 부여하지 않는다).
            Permission.LIFECYCLE_READ,
            # AUDITOR는 P14와 동일한 원칙(문서 본문 비노출)에 따라 평가 결과의
            # 원문도 마스킹된 채로만 본다 — D-056.
        }
    ),
    Role.ADMIN: _ALL_PERMISSIONS,
}


def has_permission(role: Role, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(role, frozenset())


def require_permission(role: Role, permission: Permission) -> None:
    if not has_permission(role, permission):
        raise PermissionDeniedError(role, permission)
