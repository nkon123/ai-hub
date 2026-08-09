// Shared display metadata for the 게시 관리 (Deployment lifecycle) screens
// (P0x), mirroring apps/portal-api ServiceDeployment.status /
// DeploymentRevision.status and CreateDeploymentRequest's environment /
// access_policy Literals (portal_api/schemas.py). Kept as plain data so
// /deployments and /deployments/[id] render identical Korean labels.

export const DEPLOYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "대기중",
  ACTIVE: "활성",
  SUSPENDED: "중단됨",
  RETIRED: "폐기됨",
};

export const REVISION_STATUS_LABEL: Record<string, string> = {
  PENDING: "대기중",
  PUBLISHING: "게시 중",
  ACTIVE: "활성",
  SUPERSEDED: "대체됨",
  FAILED: "실패",
};

export const ENVIRONMENT_LABEL: Record<string, string> = {
  internal: "사내",
  demo: "데모",
};

export const ACCESS_POLICY_LABEL: Record<string, string> = {
  INTERNAL_AUTHENTICATED: "사내 인증 사용자만",
  DEMO_TOKEN: "데모 토큰 소지자만",
};

// Role required for DEPLOYMENT_SUSPEND / DEPLOYMENT_ROLLBACK
// (security_policy.roles.ROLE_PERMISSIONS — RELEASE_MANAGER and ADMIN only).
export const DEPLOYMENT_OPERATOR_ROLE_LABEL = "배포 관리자(RELEASE_MANAGER) 또는 관리자";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR");
}
