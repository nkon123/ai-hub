// D-093 "Ollama 본체와 모델을 폐쇄망 PC에 어떻게 전달할 것인가" — (1) Ollama
// 본체 경로. Desktop이 Ollama에 닿지 못할 때(D09 연결 상태, D01 3단계) 설치
// 방법을 알려주는 공용 안내 블록. D09/D01 두 화면이 이 컴포넌트를 그대로
// 공유한다(로직을 두 곳에 복제하지 않는다).
//
// D-093 결정문: "이것은 루트 구현 원칙 7에 대한 명시적 승인이다 — 사용자에게
// 폐쇄망에서 링크가 열리지 않는다는 점과 Desktop에 외부 URL 여는 기능이 아예
// 없다는 점을 알린 뒤 재확인받았다." 이 컴포넌트는 그 약속 두 가지를 화면
// 문구로 지킨다: (a) 버튼을 눌러도 안 열릴 수 있다고 먼저 말한다, (b) 주소를
// 항상 복사 가능한 텍스트로 함께 보여준다(버튼만 두지 않는다).
//
// 새 버튼/카드 스타일을 만들지 않는다 — 기존 `Card`/`Button`/`ErrorBanner`만
// 조합한다(apps/desktop-client CLAUDE.md).
import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { OLLAMA_DOWNLOAD_URL } from "../../electron/external-links";
import type { DesktopBridge } from "../../electron/types";
import { Button, Card, ErrorBanner } from "../ui";

export function OllamaInstallGuidance({
  bridge,
  disabled = false,
  disabledReason,
}: {
  bridge: Pick<DesktopBridge, "openOllamaDownloadPage">;
  /** Electron 런타임 밖(브라우저 개발 모드)에서는 실제로 브라우저를 열 수
   * 없다 — 조용히 실패시키지 않고 버튼 자체를 비활성화하고 이유를 보여준다.
   * 주소는 이 값과 무관하게 항상 복사 가능한 텍스트로 보인다. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleOpen() {
    setOpenError(null);
    setOpening(true);
    try {
      const result = await bridge.openOllamaDownloadPage();
      if (!result.ok) {
        setOpenError(result.error ?? "설치 페이지를 열지 못했습니다.");
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "설치 페이지를 열지 못했습니다.");
    } finally {
      setOpening(false);
    }
  }

  function handleCopy() {
    setCopyError(null);
    navigator.clipboard
      .writeText(OLLAMA_DOWNLOAD_URL)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopyError("클립보드에 복사하지 못했습니다. 아래 주소를 직접 선택해 복사하세요."));
  }

  return (
    <Card className="border-warning/40 bg-warning/5 p-5">
      <p className="text-card-title font-semibold text-text-primary">Ollama 설치가 필요합니다</p>
      <p className="mt-1 text-body text-text-secondary">
        Ollama에 연결할 수 없습니다. 공식 배포처에서 설치 파일을 내려받아 설치한 뒤 다시 연결을 확인하세요. 이 PC가
        폐쇄망(사내망)이라면 아래 버튼을 눌러도 페이지가 열리지 않을 수 있습니다 — 인터넷이 되는 PC에서 아래 주소를
        열어 설치 파일을 내려받은 뒤 USB 등으로 반입하는 것이 실제 절차입니다.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <p className="flex-1 break-all rounded-lg border border-border bg-white px-3 py-2 font-mono text-caption text-text-primary">
          {OLLAMA_DOWNLOAD_URL}
        </p>
        <Button variant="secondary" size="sm" onClick={handleCopy} title="주소를 클립보드에 복사">
          <Copy size={14} /> {copied ? "복사됨" : "주소 복사"}
        </Button>
      </div>
      {copyError && (
        <div className="mt-2">
          <ErrorBanner message={copyError} />
        </div>
      )}

      <div className="mt-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleOpen()}
          disabled={disabled || opening}
          title={disabled ? disabledReason : undefined}
        >
          <ExternalLink size={14} /> {opening ? "여는 중..." : "설치 페이지 열기"}
        </Button>
        {disabled && disabledReason && <p className="mt-1 text-caption text-text-muted">{disabledReason}</p>}
      </div>
      {!disabled && openError && (
        <div className="mt-2">
          <ErrorBanner message={openError} />
        </div>
      )}
    </Card>
  );
}
