export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
}

/** 밀리초를 사람이 읽는 분/초 단위 문구로 바꾼다 — 원시 밀리초를 그대로
 * 노출하지 않는다(실사용 제보 2026-08-19, `schedule-local-tool-runner.ts`의
 * `describeTimeoutMs`와 같은 취지 — Main-only 모듈이라 렌더러에서 직접
 * import할 수 없어 이 파일에 별도로 둔다). */
export function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}분`;
  const totalSeconds = Math.round(ms / 1000);
  return `${totalSeconds}초`;
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR");
  } catch {
    return iso;
  }
}

const ASSET_TYPE_LABEL: Record<string, string> = {
  agent: "Agent",
  knowledge: "Knowledge",
  prompt: "Prompt",
  mcp_tool: "MCP 설정",
  service: "AI Service",
};

export function assetTypeLabel(assetType: string): string {
  return ASSET_TYPE_LABEL[assetType] ?? assetType;
}
