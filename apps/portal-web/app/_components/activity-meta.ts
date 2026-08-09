// Shared display metadata for the dashboard's 최근 활동 (Recent Activity) feed,
// which reads directly from GET /api/v1/audit-events (AUDITOR/ADMIN only —
// see rbac.py RBAC_PERMISSIONS / AUDIT_READ). Event type strings are internal
// wire values (portal_api/routers/*.py `record_audit(event_type=...)` calls);
// this file is the single place that turns them into the Korean business
// language CLAUDE.md and the style guide §15 require ("사용자가 이해해야
//하는 것은 기술 구성 요소가 아니라 무엇이 일어났는가") — never render the
// raw event_type string in the dashboard.

/** Exact event_type -> Korean label. Covers every literal event_type emitted
 * by apps/portal-api (grepped from routers/*.py and audit.py). Dynamic
 * event types (REVIEW_DECISION_*, PERMISSION_DENIED:*) are handled in
 * `describeEventType` below rather than enumerated here. */
const EVENT_TYPE_LABEL: Record<string, string> = {
  ASSET_VERSION_CREATED: "자산 버전 등록",
  ASSET_VERSION_SUBMITTED: "검토 요청",
  ASSET_VERSION_SUBMIT_DENIED: "검토 요청 거부됨",
  ASSET_VERSION_SUSPENDED: "버전 중단",
  ASSET_DEPRECATED: "자산 폐기",
  DEPLOYMENT_PUBLISHED: "챗봇 게시",
  DEPLOYMENT_SUSPENDED: "게시 중단",
  DEPLOYMENT_RESUMED: "게시 재개",
  DEPLOYMENT_ROLLED_BACK: "게시 롤백",
  SERVICE_VERSION_CREATED: "서비스 정의 생성",
  DISTRIBUTION_REQUESTED: "배포판 요청",
  BUNDLE_DOWNLOADED: "오프라인 번들 다운로드",
};

const REVIEW_DECISION_LABEL: Record<string, string> = {
  APPROVE: "검토 승인",
  REJECT: "검토 반려",
  REQUEST_CHANGES: "검토 수정 요청",
};

export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  ASSET: "자산",
  ASSET_VERSION: "자산 버전",
  AUDIT_EVENT: "감사 로그",
  DEPLOYMENT: "배포",
  DISTRIBUTION: "배포판",
  REVIEW: "검토",
  SERVICE: "서비스",
  SERVICE_VERSION: "서비스 버전",
};

/** Turns a raw event_type wire value into a short Korean business-language label.
 * Falls back to the raw value (rather than throwing) for any future event_type
 * this file hasn't been updated for yet — so a new event never breaks the page,
 * it just shows literally until this map is extended. */
export function describeEventType(eventType: string): string {
  if (eventType.startsWith("PERMISSION_DENIED")) {
    const permission = eventType.split(":")[1];
    return permission ? `권한 거부 (${permission})` : "권한 거부";
  }
  if (eventType.startsWith("REVIEW_DECISION_")) {
    const decision = eventType.slice("REVIEW_DECISION_".length);
    return REVIEW_DECISION_LABEL[decision] ?? "검토 결정";
  }
  return EVENT_TYPE_LABEL[eventType] ?? eventType;
}
