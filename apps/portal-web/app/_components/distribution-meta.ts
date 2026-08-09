// Shared display metadata for the 반출 요청 / Offline Bundle 작업 (P10/P11/P13)
// screens, mirroring apps/portal-api's DistributionRequest.status/stage
// vocabulary (07-data-api-contracts.md §10.4, 01-portal-and-distribution.md
// §4.4). Kept as plain data so /distributions, /distributions/new and
// /distributions/[id] render identical Korean labels.

// D-016 (open-decisions.md): "Checksum 필수, Signature Hook만" — SIGNING is
// deliberately not implemented server-side, so the real stage sequence a
// SUCCEEDED job passes through is exactly this list. Screens must render
// SIGNING as 해당 없음/생략 with this reason, never as a pending step.
export const BUNDLE_STAGES = [
  "RESOLVING",
  "COLLECTING",
  "VERIFYING",
  "PACKAGING",
  "SUCCEEDED",
] as const;

export type BundleStage = (typeof BUNDLE_STAGES)[number];

export const STAGE_LABEL: Record<string, string> = {
  RESOLVING: "의존성 해석",
  COLLECTING: "파일 수집",
  VERIFYING: "무결성 검증",
  PACKAGING: "패키징",
  SUCCEEDED: "완료",
};

export const SIGNING_OMITTED_REASON =
  "전자 서명(Signing)은 이 PoC에서 구현하지 않습니다 (D-016: Checksum 필수, Signature Hook만 제공). 대신 Checksum으로 무결성을 검증하세요.";

export const DISTRIBUTION_STATUS_LABEL: Record<string, string> = {
  QUEUED: "대기중",
  RUNNING: "진행중",
  SUCCEEDED: "성공",
  FAILED: "실패",
  CANCELLED: "취소됨",
};

export const ROOT_TYPE_LABEL: Record<string, string> = {
  ASSET_VERSION: "자산 버전",
  SERVICE_VERSION: "AI Service 버전",
};

export const DISTRIBUTION_MODE_LABEL: Record<string, string> = {
  OFFLINE_BUNDLE: "폐쇄망 반출용 Offline Bundle",
  ONLINE: "온라인 단일 다운로드",
};

// Seeded Office Profile sites (fixtures/valid/office-profile-default/office-profile.json
// → "sites": ["headquarters", "gumi"]). Do not invent sites beyond this list.
export const OFFICE_SITES: { id: string; label: string }[] = [
  { id: "headquarters", label: "본사 (headquarters)" },
  { id: "gumi", label: "구미 사업장 (gumi)" },
];

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
