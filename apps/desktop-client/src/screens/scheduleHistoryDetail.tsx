// 실사용 제보(2026-08-19) — "스케줄봇에서 수행한 이력에서 출력을 보기
// 불편한 것 같다. 마크다운 형태로 보든가, 리스트를 클릭하면 팝업이 뜨고
// 마크다운 뷰어로 보여주든가." D14 실행 이력을 보여주는 두 화면
// (`ChatScreen.tsx`의 스케줄봇 패널, `ScheduleScreen.tsx`의 "실행 이력" 탭)이
// 완전히 같은 데이터(`ScheduleHistoryRecord`)를 완전히 같은 방식(전체
// `resultSummary`를 목록에 그대로 펼침)으로 그리고 있었다 — 상한을 240자에서
// 20,000자로 올린 뒤에는(`schedule-history-store.ts`) 그 방식이 목록 자체를
// 훑기 어렵게 만든다. 이 모듈이 두 화면이 공유하는 "목록 한 줄 요약 +
// 클릭하면 전문 팝업"을 담당한다 — 새 저장 경로나 IPC를 추가하지 않는다,
// 이미 각 화면이 들고 있는 `ScheduleHistoryRecord`를 다르게 보여줄 뿐이다.
import { AlertTriangle, CalendarClock, Terminal } from "lucide-react";
import type { ScheduleHistoryRecord, ScheduleRunOutcome } from "../../electron/types";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { formatDateTime } from "../format";
import { Modal } from "../ui";

export const SCHEDULE_HISTORY_OUTCOME_LABELS: Record<ScheduleRunOutcome, string> = {
  success: "성공",
  failure: "실패",
  missed: "놓침",
  cancelled: "중단됨",
};

export const SCHEDULE_HISTORY_OUTCOME_TONE: Record<ScheduleRunOutcome, string> = {
  success: "text-success",
  failure: "text-danger",
  missed: "text-warning",
  cancelled: "text-text-muted",
};

const LIST_SUMMARY_MAX_CHARS = 140;

/** 목록 한 줄에 보여줄 짧은 요약 — 저장된 `resultSummary`(최대 20,000자)를
 * 다시 한번 화면 표시용으로만 줄인다(저장 형식은 바뀌지 않는다, 순수 표시
 * 로직). 첫 번째 비어 있지 않은 줄만 쓴다 — 여러 문단짜리 결과라도 목록에서
 * 줄바꿈이 섞여 보이지 않게 한다. */
export function summarizeForList(text: string, maxChars: number = LIST_SUMMARY_MAX_CHARS): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const source = firstLine ?? text.trim();
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}…`;
}

/** 실행 1건의 전문 팝업 — Task Brief B: 결과 전문(마크다운 렌더링) +
 * 언제·어떤 스케줄이·성공/실패/놓침·수동/예약·어떤 Tool을 어떤 인자로
 * 호출했는지. 사람이 지켜보지 않는 사이 일어난 일의 유일한 감시 수단이므로
 * 정보를 요약하지 않는다(목록 쪽과 반대). 기존 `Modal`(D08 상세보기와 같은
 * 오버레이)을 그대로 재사용한다 — 새 디자인 언어를 만들지 않는다. */
export function ScheduleHistoryDetailModal({
  open,
  record,
  scheduleName,
  onClose,
}: {
  open: boolean;
  record: ScheduleHistoryRecord | null;
  scheduleName: string;
  onClose: () => void;
}) {
  if (!record) return null;
  return (
    <Modal open={open} title={`${scheduleName} — 실행 결과`} onClose={onClose}>
      <div className="space-y-3 text-body">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`font-semibold ${SCHEDULE_HISTORY_OUTCOME_TONE[record.outcome]}`}>
            {SCHEDULE_HISTORY_OUTCOME_LABELS[record.outcome]}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-caption text-text-muted">
            {record.trigger === "manual" ? "수동 실행" : "예약 실행"}
          </span>
          <span className="flex items-center gap-1 text-caption text-text-muted">
            <CalendarClock size={12} className="shrink-0" aria-hidden="true" />
            {formatDateTime(record.timestamp)}
          </span>
        </div>

        {record.failureReason && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-caption text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{record.failureReason}</span>
          </div>
        )}

        {record.localToolInvocations.length > 0 && (
          <div className="rounded-lg border border-border bg-slate-50 px-3 py-2">
            <p className="flex items-center gap-1 text-caption font-semibold text-text-secondary">
              <Terminal size={12} className="shrink-0" aria-hidden="true" />
              호출된 로컬 Tool
            </p>
            <ul className="mt-1 space-y-2">
              {record.localToolInvocations.map((invocation, idx) => (
                <li key={`${invocation.toolName}-${idx}`} className="text-caption">
                  <span className="font-medium text-text-primary">{invocation.toolName}</span>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-50">
                    {JSON.stringify(invocation.args, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </div>
        )}

        {record.resultSummary && (
          <div>
            <AnswerMarkdown source={record.resultSummary} />
            {record.resultTruncated && (
              <p className="mt-2 flex items-center gap-1 text-caption text-warning">
                <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
                이 결과는 길이 상한을 넘어 잘렸습니다 — 전체 결과 중 일부만 저장되었습니다.
              </p>
            )}
          </div>
        )}

        {!record.resultSummary && !record.failureReason && (
          <p className="text-caption text-text-muted">이 실행에는 표시할 결과 텍스트가 없습니다.</p>
        )}
      </div>
    </Modal>
  );
}
