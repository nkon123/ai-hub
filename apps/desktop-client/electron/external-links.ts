// D-093 "Ollama 본체와 모델을 폐쇄망 PC에 어떻게 전달할 것인가" — (1) Ollama
// 본체 경로: Desktop이 Ollama에 닿지 못하면 설치 안내와 함께 공식 배포처
// 링크를 보여준다.
//
// 이 저장소에는 지금까지 `shell.openExternal`이 전혀 없었다 — 루트
// CLAUDE.md 구현 원칙 7("승인되지 않은 임의 Python 실행, 외부 URL, Package
// 설치 기능을 만들지 않는다")이 그 이유다. D-093은 **이 한 주소에 한해서만**
// 명시적으로 예외를 승인했다(사용자에게 폐쇄망에서 링크가 열리지 않을 수
// 있다는 점과, 이전에는 이런 기능이 전혀 없었다는 점을 알리고 재확인받음).
// 그래서 이 파일은 임의 URL을 인자로 받는 함수를 절대 내보내지 않는다 —
// 주소는 아래 상수 하나뿐이고, IPC 브릿지(`electron/types.ts`의
// `openOllamaDownloadPage`)도 인자를 받지 않는다. 새 주소가 필요해지면 이
// 파일에 상수를 하나 더 추가하고 동일하게 무인자 메서드를 새로 만든다 —
// 기존 메서드를 매개변수화하지 않는다(그 순간 승인 범위를 벗어난다).
export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

import type { ConnectionStatus } from "./types";

export type OllamaConnectionJudgement = "connected" | "failed" | "unknown";

/**
 * 연결 상태 판정을 한 곳에 모은다 — "실패로 확인됨"과 "아직 모름(검사
 * 전/검사 중)"을 구분한다. 후자를 실패로 취급해 설치 안내를 미리 띄우면,
 * 실제로는 정상인데 검사가 끝나기 전이라 설치 안내가 잠깐 보이는 오탐이
 * 생긴다.
 */
export function judgeOllamaConnection(status: ConnectionStatus | null | undefined): OllamaConnectionJudgement {
  if (!status) return "unknown";
  return status.ok ? "connected" : "failed";
}

/**
 * Ollama 설치 안내(공식 배포처 링크 + 복사 가능한 주소)를 보여줄지 결정하는
 * 순수 판정. 이미 연결돼 있으면(connected) 절대 보여주지 않는다. 아직
 * 확인하지 않았거나 확인 중이면(unknown) 보여주지 않는다 — 검사가 끝나
 * 실패로 확정된 뒤에만 보여준다.
 */
export function shouldShowOllamaInstallGuidance(status: ConnectionStatus | null | undefined): boolean {
  return judgeOllamaConnection(status) === "failed";
}
