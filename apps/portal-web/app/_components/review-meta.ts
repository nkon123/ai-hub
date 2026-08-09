// Shared display metadata for the review workflow (P08/P09), mirroring
// security_policy.review.Stage / ReviewStatus / ReviewDecisionType
// (packages/security-policy/src/security_policy/review.py). Kept as plain
// data so both /reviews and /reviews/[id] render identical Korean labels.
import type { BadgeTone } from "./ui";

export const STAGE_LABEL: Record<string, string> = {
  TECHNICAL: "기술 검토",
  SECURITY: "보안 검토",
  RELEASE: "배포 승인",
};

export const STAGE_TONE: Record<string, BadgeTone> = {
  TECHNICAL: "info",
  SECURITY: "purple",
  RELEASE: "brand",
};

/** Role required to decide a review at each stage (STAGE_PERMISSION in security_policy). */
export const STAGE_REQUIRED_ROLE_LABEL: Record<string, string> = {
  TECHNICAL: "기술 검토자",
  SECURITY: "보안 검토자",
  RELEASE: "배포 관리자",
};

export const DECISION_LABEL: Record<string, string> = {
  APPROVE: "승인",
  REJECT: "반려",
  REQUEST_CHANGES: "수정 요청",
};

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  PENDING: "대기중",
  APPROVED: "승인됨",
  REJECTED: "반려됨",
  CHANGES_REQUESTED: "수정요청됨",
  CANCELLED: "취소됨",
};

export const ASSET_TYPE_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  agent: "Agent",
  prompt: "Prompt",
  mcp_tool: "MCP 도구",
  service: "서비스",
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR");
}
