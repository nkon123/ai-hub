"use client";

/**
 * 개발/데모 용 역할 전환 (Role Switcher) — D-001 Test Identity Adapter PoC.
 *
 * There is no login screen yet; portal-api's Test Identity Adapter
 * (apps/portal-api/src/portal_api/auth.py) maps a fixed set of `dev-*-token`
 * bearer tokens to roles. This context exposes the currently selected role
 * (persisted in localStorage) so every screen can send the matching token
 * instead of hardcoding one. A real deployment gets identity from SSO
 * (see open-decisions.md D-001) — this is scaffolding only, not a feature.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type RoleCode =
  | "CREATOR"
  | "TECH_REVIEWER"
  | "SECURITY_REVIEWER"
  | "RELEASE_MANAGER"
  | "AUDITOR"
  | "ADMIN";

export interface RoleDef {
  code: RoleCode;
  label: string;
  token: string;
  /** Must mirror portal_api.auth._TEST_TOKENS[token].user_id exactly. */
  userId: string;
}

export const ROLES: RoleDef[] = [
  { code: "CREATOR", label: "자산 제작자", token: "dev-user-token", userId: "dev-user@miracom.com" },
  {
    code: "TECH_REVIEWER",
    label: "기술 검토자",
    token: "dev-reviewer-token",
    userId: "reviewer@miracom.com",
  },
  {
    code: "SECURITY_REVIEWER",
    label: "보안 검토자",
    token: "dev-security-token",
    userId: "security-reviewer@miracom.com",
  },
  {
    code: "RELEASE_MANAGER",
    label: "배포 관리자",
    token: "dev-release-token",
    userId: "release-manager@miracom.com",
  },
  { code: "AUDITOR", label: "감사자", token: "dev-auditor-token", userId: "auditor@miracom.com" },
  { code: "ADMIN", label: "관리자", token: "dev-admin-token", userId: "admin@miracom.com" },
];

const DEFAULT_ROLE = ROLES[0];
const STORAGE_KEY = "aihub.dev-role";

interface RoleContextValue {
  role: RoleDef;
  setRoleCode: (code: RoleCode) => void;
}

const RoleContext = createContext<RoleContextValue>({
  role: DEFAULT_ROLE,
  setRoleCode: () => {},
});

export function RoleProvider({ children }: { children: ReactNode }) {
  const [roleCode, setRoleCodeState] = useState<RoleCode>(DEFAULT_ROLE.code);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && ROLES.some((r) => r.code === saved)) {
      setRoleCodeState(saved as RoleCode);
    }
  }, []);

  function setRoleCode(code: RoleCode) {
    setRoleCodeState(code);
    window.localStorage.setItem(STORAGE_KEY, code);
  }

  const role = ROLES.find((r) => r.code === roleCode) ?? DEFAULT_ROLE;

  return <RoleContext.Provider value={{ role, setRoleCode }}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  return useContext(RoleContext);
}

/**
 * Client-side mirror of the AUDIT_READ grant in
 * `packages/security-policy/src/security_policy/roles.py`
 * (`ROLE_PERMISSIONS[Role.AUDITOR]` / `[Role.ADMIN]`) — AUDITOR and ADMIN
 * only. This exists purely as a UX affordance so screens can skip issuing a
 * request the current role is already known to be denied for (e.g. a
 * background dashboard fetch that would otherwise manufacture a
 * `PERMISSION_DENIED:AUDIT_READ` audit row on every page view). The server
 * remains the sole authority on this permission — never treat this helper
 * as enforcement, and keep handling 403 responses from the API regardless
 * of what it returns. Keep this set in sync with roles.py if that matrix
 * changes.
 */
const AUDIT_READ_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>(["AUDITOR", "ADMIN"]);

export function canReadAudit(role: RoleCode): boolean {
  return AUDIT_READ_ROLES.has(role);
}

/**
 * Client-side mirror of the DISTRIBUTION_CREATE grant in
 * `packages/security-policy/src/security_policy/roles.py` — CREATOR and
 * ADMIN only (USER also has it server-side, but no `dev-*-token` in this
 * PoC's Test Identity Adapter maps to plain USER). Same caveat as
 * `canReadAudit`: UX affordance only, never enforcement — the server is the
 * sole authority and P10 still surfaces the real 403 if this drifts out of
 * sync with roles.py.
 */
const DISTRIBUTION_CREATE_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>(["CREATOR", "ADMIN"]);

export function canCreateDistribution(role: RoleCode): boolean {
  return DISTRIBUTION_CREATE_ROLES.has(role);
}

/**
 * Client-side mirror of `Permission.EVALUATION_RUN` in
 * `packages/security-policy/src/security_policy/roles.py` (P12 Knowledge
 * 품질) — CREATOR (only when they own the Knowledge, checked separately by
 * the caller), TECH_REVIEWER, SECURITY_REVIEWER, ADMIN. Same caveat as
 * `canReadAudit`/`canCreateDistribution`: UX affordance only, the server
 * (open-decisions.md D-056) is the sole authority.
 */
const EVALUATION_RUN_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  "CREATOR",
  "TECH_REVIEWER",
  "SECURITY_REVIEWER",
  "ADMIN",
]);

export function canRunEvaluation(role: RoleCode): boolean {
  return EVALUATION_RUN_ROLES.has(role);
}

/**
 * Client-side mirror of `Permission.EVALUATION_NOTE` — reviewer-only
 * (기준 미달 사유 기록), unlike `canRunEvaluation` this never includes
 * CREATOR even for the asset owner. See open-decisions.md D-056.
 */
const EVALUATION_NOTE_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  "TECH_REVIEWER",
  "SECURITY_REVIEWER",
  "ADMIN",
]);

export function canRecordEvaluationNote(role: RoleCode): boolean {
  return EVALUATION_NOTE_ROLES.has(role);
}

/**
 * Client-side mirror of `Permission.LIFECYCLE_READ` (P16 수명주기/회수) —
 * RELEASE_MANAGER, AUDITOR, ADMIN. Same caveat as `canReadAudit`: UX
 * affordance only, the server is the sole authority.
 */
const LIFECYCLE_READ_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  "RELEASE_MANAGER",
  "AUDITOR",
  "ADMIN",
]);

export function canReadLifecycle(role: RoleCode): boolean {
  return LIFECYCLE_READ_ROLES.has(role);
}

/**
 * Client-side mirror of `Permission.ASSET_RETIRE` /
 * `Permission.ASSET_SET_REPLACEMENT` / `Permission.ASSET_REVOKE` — all three
 * share the same RELEASE_MANAGER/ADMIN audience (P16), so one helper covers
 * every mutating action on the lifecycle screen.
 */
const LIFECYCLE_OPERATOR_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  "RELEASE_MANAGER",
  "ADMIN",
]);

export function canOperateLifecycle(role: RoleCode): boolean {
  return LIFECYCLE_OPERATOR_ROLES.has(role);
}

/**
 * Client-side mirror of `Permission.DOWNLOAD_READ` (P13 다운로드 이력) —
 * CREATOR, AUDITOR, ADMIN in this PoC's fixed Test Identity Adapter (plain
 * USER also has it server-side, but no `dev-*-token` maps to it). Same
 * caveat as `canReadAudit`: UX affordance only, the server enforces both
 * this permission and the own-history-only scoping regardless of what this
 * returns.
 */
const DOWNLOAD_READ_ROLES: ReadonlySet<RoleCode> = new Set<RoleCode>([
  "CREATOR",
  "AUDITOR",
  "ADMIN",
]);

export function canReadDownloadHistory(role: RoleCode): boolean {
  return DOWNLOAD_READ_ROLES.has(role);
}

/**
 * Client-side mirror of "AUDITOR/ADMIN see every user's download history"
 * (`routers/distributions.py::list_download_history`'s `is_auditor` check)
 * — controls whether the 사용자/조직 filter inputs render on `/downloads`.
 * A non-auditor never sees them; passing them anyway is denied server-side
 * regardless.
 */
export function canSearchAllDownloadHistory(role: RoleCode): boolean {
  return role === "AUDITOR" || role === "ADMIN";
}

/**
 * Client-side mirror of `Permission.ADMIN_SETTINGS_READ` (P15 관리자 설정) —
 * ADMIN only (unlike every other `can*` helper above, no other role holds
 * this permission server-side, see `ROLE_PERMISSIONS` in
 * `packages/security-policy/src/security_policy/roles.py`). Same caveat as
 * `canReadAudit`: UX affordance only, the server is the sole authority.
 */
export function canReadAdminSettings(role: RoleCode): boolean {
  return role === "ADMIN";
}
