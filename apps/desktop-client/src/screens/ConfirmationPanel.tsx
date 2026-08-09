// D06 대화/실행 — Tool 호출 확인 Panel (02-desktop-and-agent-runtime.md
// §D06 규칙 "Tool 호출 전 사용자 확인이 필요한 경우 실행 중 명확한 확인
// Panel을 표시한다"; §5.3 WAITING_FOR_USER; D-052 후속).
//
// 표시되는 값은 오직 agent-runtime의 `mcp.confirmation_required` SSE
// 이벤트(또는 `GET /runs/{id}`의 `pending_confirmation`)가 준 안전한
// 요약뿐이다 — Tool의 실제 입력(Filter 값 등)이나 결과는 절대 포함하지
// 않는다(D-052 후속 "이벤트가 원본 Tool 입력/결과를 담지 않는다"는 성질을
// 이 Panel도 그대로 지킨다).
import { useEffect, useState } from "react";
import { AlertTriangle, Ban, Check, Clock } from "lucide-react";
import { Button } from "../ui";
import type { PendingConfirmation } from "../agentRuntime";

function remainingSeconds(deadline: string): number {
  const ms = new Date(deadline).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "0초";
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

export function ConfirmationPanel({
  pending,
  busy,
  error,
  onApprove,
  onDeny,
}: {
  pending: PendingConfirmation;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [remaining, setRemaining] = useState(() => remainingSeconds(pending.deadline));

  // 남은 시간을 1초마다 갱신 — 만료되면 agent-runtime이 스스로 Run을
  // FAILED로 전이시키고 그 결과가 SSE로 도착하므로, 여기서는 표시만 하고
  // 별도로 만료를 판단/전송하지 않는다(Runtime이 유일한 권위 있는 시계).
  useEffect(() => {
    setRemaining(remainingSeconds(pending.deadline));
    const timer = window.setInterval(() => {
      setRemaining(remainingSeconds(pending.deadline));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pending.deadline]);

  const expiringSoon = remaining <= 15;

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="flex-1">
          <p className="text-body font-semibold text-text-primary">Tool 실행 확인이 필요합니다</p>
          <p className="mt-1 text-body text-text-secondary">{pending.summary}</p>
          <p className="mt-1 text-caption text-text-muted">Tool: {pending.tool_name}</p>
          <p
            className={`mt-2 flex items-center gap-1.5 text-caption font-medium ${
              expiringSoon ? "text-danger" : "text-text-muted"
            }`}
          >
            <Clock size={13} />
            {remaining > 0
              ? `${formatRemaining(remaining)} 후 자동으로 실행이 중단됩니다`
              : "확인 대기 시간이 곧 만료됩니다..."}
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-caption text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onApprove} disabled={busy} title={busy ? "처리 중입니다." : undefined}>
          <Check size={13} /> 승인
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onDeny}
          disabled={busy}
          title={busy ? "처리 중입니다." : undefined}
        >
          <Ban size={13} /> 거부
        </Button>
      </div>
    </div>
  );
}
