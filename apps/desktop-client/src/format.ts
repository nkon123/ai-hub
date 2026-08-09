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
