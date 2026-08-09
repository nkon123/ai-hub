"""Dependency resolver — M03, `01-portal-and-distribution.md` §4.3.

A pure function over the already-DB-resolved `BundleJobRequest.items` list
(portal-api did every Registry lookup before calling this service — see
`contracts.py` module docstring for why). This module performs §4.3 steps
3-7 only:

  3. 필수 의존성을 재귀적으로 순회한다.
     -> already flattened by portal-api into `items` (this codebase's
     Service Definition dependency graph is one level deep: agent_ref +
     knowledge_bindings + mcp_bindings + prompt_bindings; there is no
     asset-to-asset Dependency table yet, so "recursive" degenerates to
     "walk the given flat list").
  4. 버전 Range와 대상 환경의 호환성을 검사한다.
     -> Office Profile Registry doesn't exist yet (no model/MCP allow-list
     to check against); this step is a documented no-op pending that
     Registry (see open-decisions.md).
  5. 동일 자산이 여러 버전으로 요구되면 충돌을 반환한다.
  6. Office Profile이 허용하지 않는 모델·MCP를 거부한다.
     -> same no-op as step 4.
  7. 결과를 정렬된 Install Plan으로 반환한다.

Also enforces two registry rules that aren't among the 7 numbered steps but
are load-bearing here:

  - a required, non-root dependency that is currently SUSPENDED or RETIRED
    must not be packaged into a *new* Offline Bundle
    (01-portal-and-distribution.md §3.5: "SUSPENDED는 긴급 중단이며 신규
    배포를 금지한다"; RETIRED is terminal) — this raises `PACKAGE_REVOKED`.
    DEPRECATED dependencies are still bundleable (지원 종료 예정이지 사용
    금지가 아님) but are listed in the revocation list for visibility.
  - a required item carrying `revoked=True` (P16 긴급 Revocation, orthogonal
    to `status` — see `contracts.py`) must never be packaged, regardless of
    its lifecycle status — this raises `AssetVersionRevokedError` and is
    checked *before* the SUSPENDED/RETIRED check since an emergency recall
    on an otherwise-APPROVED version is the more urgent failure to surface.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from distribution_service.contracts import BundleJobRequest, BundleJobRequestItem

# 06 §6.2: "의존성 순서대로 Prompt/Knowledge/Agent/Service/Office Profile을
# 설치한다". mcp_tool has no explicit slot in that sentence; placed after
# agent (tools an agent calls) and before service (the composition that
# binds everything together).
_INSTALL_PRIORITY: dict[str, int] = {
    "prompt": 0,
    "knowledge": 1,
    "agent": 2,
    "mcp_tool": 3,
    "service": 4,
}

# Statuses that carry no real resolved version and must never be reported
# as version conflicts nor as SUSPENDED/RETIRED revocations.
_NON_VERSIONED_STATUSES = {"NOT_FOUND", "STANDARD_LOCAL_COPY"}
_BLOCKING_STATUSES = {"SUSPENDED", "RETIRED"}


class DependencyMissingError(Exception):
    """-> `DEPENDENCY_MISSING`."""

    def __init__(self, items: list[BundleJobRequestItem]) -> None:
        self.items = items
        ids = ", ".join(i.asset_name or i.asset_id or "?" for i in items)
        super().__init__(f"Missing required dependencies: {ids}")


class DependencyVersionConflictError(Exception):
    """-> `DEPENDENCY_VERSION_CONFLICT`."""

    def __init__(self, conflicts: dict[str, list[str]]) -> None:
        self.conflicts = conflicts
        super().__init__(f"Conflicting versions requested: {conflicts}")


class PackageRevokedError(Exception):
    """-> `PACKAGE_REVOKED`."""

    def __init__(self, items: list[BundleJobRequestItem]) -> None:
        self.items = items
        ids = ", ".join(i.asset_name or i.asset_id or "?" for i in items)
        super().__init__(f"Cannot bundle SUSPENDED/RETIRED dependency: {ids}")


class AssetVersionRevokedError(Exception):
    """-> `ASSET_VERSION_REVOKED`. See module docstring — orthogonal to
    `PackageRevokedError` (lifecycle status), driven by `item.revoked`
    (P16 긴급 Revocation)."""

    def __init__(self, items: list[BundleJobRequestItem]) -> None:
        self.items = items
        ids = ", ".join(i.asset_name or i.asset_id or "?" for i in items)
        super().__init__(f"Cannot bundle emergency-revoked version: {ids}")


@dataclass
class InstallPlan:
    items: list[BundleJobRequestItem]
    install_order: list[str] = field(default_factory=list)


def _effective_type(item: BundleJobRequestItem) -> str:
    return item.asset_type if item.role == "root" else item.role


def _sort_key(item: BundleJobRequestItem) -> tuple[int, str]:
    priority = _INSTALL_PRIORITY.get(_effective_type(item), 99)
    return (priority, item.asset_name or item.asset_id or "")


def resolve(request: BundleJobRequest) -> InstallPlan:
    """Run §4.3 steps 3-7. Raises `DependencyMissingError`,
    `DependencyVersionConflictError`, `AssetVersionRevokedError`, or
    `PackageRevokedError` on failure; returns a sorted `InstallPlan` on
    success.
    """
    missing = [i for i in request.items if i.required and i.status == "NOT_FOUND"]
    if missing:
        raise DependencyMissingError(missing)

    emergency_revoked = [i for i in request.items if i.required and i.revoked]
    if emergency_revoked:
        raise AssetVersionRevokedError(emergency_revoked)

    revoked = [
        i
        for i in request.items
        if i.required and i.status in _BLOCKING_STATUSES and i.status not in _NON_VERSIONED_STATUSES
    ]
    if revoked:
        raise PackageRevokedError(revoked)

    by_asset: dict[str, set[str]] = {}
    for i in request.items:
        if not i.required or i.status in _NON_VERSIONED_STATUSES or not i.asset_id:
            continue
        by_asset.setdefault(i.asset_id, set()).add(i.version or "")

    conflicts = {
        asset_id: sorted(versions) for asset_id, versions in by_asset.items() if len(versions) > 1
    }
    if conflicts:
        raise DependencyVersionConflictError(conflicts)

    # Steps 4/6 (Office Profile compatibility) are a documented no-op — see
    # module docstring; no Office Profile Registry exists yet to check
    # against (open-decisions.md).

    sorted_items = sorted(request.items, key=_sort_key)
    install_order = list(dict.fromkeys(_effective_type(i) for i in sorted_items))
    return InstallPlan(items=sorted_items, install_order=install_order)
