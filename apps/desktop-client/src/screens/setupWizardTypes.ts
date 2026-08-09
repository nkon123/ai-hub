// D01 최초 설정 Wizard — 화면(SetupWizardScreen.tsx)에서 분리한 순수 로직.
// 다른 screens/*Types.ts(storeTypes.ts, chatTypes.ts 등)와 동일한 관례: IPC나
// React state에 의존하지 않는 계산은 여기 두고 vitest로 직접 검증한다.
import type { CheckStatus, DiskSpaceInfo, OllamaModelsResult } from "../../electron/types";
import { formatBytes } from "../format";

export type WizardStepId = "install-path" | "office-profile" | "ollama" | "models" | "mcp" | "log-policy" | "summary";

export interface WizardStepMeta {
  id: WizardStepId;
  title: string;
}

export const WIZARD_STEPS: WizardStepMeta[] = [
  { id: "install-path", title: "설치 경로" },
  { id: "office-profile", title: "Office Profile" },
  { id: "ollama", title: "Ollama" },
  { id: "models", title: "모델 확인" },
  { id: "mcp", title: "MCP 연결" },
  { id: "log-policy", title: "로그 정책" },
  { id: "summary", title: "완료" },
];

/** 특정 절대 용량 기준을 명세가 못박지 않았으므로(open-decisions.md D-018:
 * "정책 설정, 실제 제한은 환경 측정") 여기서 임의의 엄격한 기준을 지어내지
 * 않는다 — 1GiB 미만이면 "부족할 수 있음" 경고만 준다(사용자가 실제 Package를
 * 가져오는 시점에는 D04/D05가 그 Package의 실제 예상 용량으로 다시, 훨씬
 * 정확하게 검사한다 — 이 값은 어디까지나 최초 설정 시점의 대략적 안내). */
const LOW_DISK_SPACE_WARNING_BYTES = 1024 * 1024 * 1024;

export function computeDiskSpaceCheck(info: DiskSpaceInfo | null, error: string | null): { status: CheckStatus; message: string } {
  if (error) return { status: "FAIL", message: error };
  if (!info) return { status: "SKIP", message: "확인 중..." };
  if (info.freeBytes < LOW_DISK_SPACE_WARNING_BYTES) {
    return { status: "WARN", message: `여유 공간이 ${formatBytes(info.freeBytes)}로 부족할 수 있습니다. Package를 가져올 때 다시 정확히 검사됩니다.` };
  }
  return { status: "PASS", message: `설치 경로: ${info.path} (여유 공간 ${formatBytes(info.freeBytes)})` };
}

export function computeModelsCheck(result: OllamaModelsResult | null): { status: CheckStatus; message: string } {
  if (!result) return { status: "SKIP", message: "아직 확인하지 않았습니다." };
  if (!result.ok) return { status: "FAIL", message: result.error ?? "Ollama에 연결할 수 없습니다." };
  if (result.models.length === 0) {
    return { status: "WARN", message: "Ollama에 설치된 모델이 없습니다. Chat/Embedding 모델을 먼저 설치하세요." };
  }
  return { status: "PASS", message: `설치된 모델: ${result.models.join(", ")}` };
}

/** FAIL이 하나라도 있으면 FAIL, 없지만 WARN/SKIP이 있으면 WARN, 전부 PASS일
 * 때만 PASS — D05 사전점검과 같은 집계 규칙(가장 나쁜 상태가 이긴다). */
export function computeOverallStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return "SKIP";
  if (statuses.some((s) => s === "FAIL")) return "FAIL";
  if (statuses.some((s) => s === "WARN" || s === "SKIP")) return "WARN";
  return "PASS";
}
