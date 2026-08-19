// D14 — append-only execution history for scheduled runs. Same lifecycle
// pattern as `ConversationStore`/`LocalToolStore`/`ScheduleStore`: single
// JSON file under `stateDir`, Main-process-only, corrupted file => empty.
//
// Log/leak discipline (same as `conversation-store.ts`'s docstring): the
// records this store holds are structural (schedule id, timestamp, outcome,
// tool names/args, a short result summary or failure reason) — never the
// full question/answer text. `electron/diagnostic-bundle.ts` never imports
// this module (allow-list principle, that file's own docstring) —
// `electron/__tests__/schedule-diagnostic-leak.test.ts` pins that as a
// regression test, mirroring `conversation-diagnostic-leak` coverage for
// `ConversationStore`. Call sites that log through `getLogger()` about a
// scheduled run must only pass counts/ids/outcome, never `resultSummary`/
// `failureReason` text verbatim into a log message beyond what's already a
// short, deliberately-truncated summary.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScheduleHistoryRecord } from "./types";

// 실사용 제보(2026-08-19) — 이전 240자 상한은 `conversation-store.ts`의
// `toolExecutions` 요약(사람이 화면 앞에서 바로 읽고 지나가는 대화 맥락)과
// 같은 값을 그대로 가져다 쓴 것이었는데, 그 전제가 스케줄 실행에는 맞지
// 않는다 — 스케줄은 사람이 안 보는 사이 돌고, 이 요약이 그 실행의 유일한
// 산출물이다("메일 요약" 같은 결과가 첫 문단에서 잘리면 이력 기능 자체가
// 무의미해진다). 20,000자로 올린다: 일반적인 LLM 응답 한 건을 거의 항상
// 온전히 담을 수 있는 크기이면서(대략 원고지 100매 안팎), 무제한은 아니다
// — 디스크에 LLM 출력이 무한정 쌓이는 것은 이 변경의 범위 밖인 별개
// 문제이므로 여전히 상한을 둔다.
//
// `conversation-store.ts`의 240자 상한은 그대로 둔다 — 그쪽은 대화 화면에
// 사람이 실시간으로 읽는 툴 실행 요약이라 "짧게 훑고 지나간다"는 전제가
// 맞지만, 이 스토어는 "기록이 곧 결과물"이라는 반대 전제다. 두 상한을
// 하나로 합치지 않는다.
const RESULT_SUMMARY_MAX_CHARS = 20_000;

/** Truncates a result string to a stored summary — never stores unbounded
 * text (CLAUDE.md: Log에 Prompt 원문·문서 전체를 기본 저장하지 않는다,
 * extended here to the history store's `resultSummary`). Returns whether
 * truncation actually happened so callers/UI can say so honestly instead of
 * relying on a "…" suffix heuristic (a genuine answer could itself end in
 * "…"). */
export function truncateResultSummary(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= RESULT_SUMMARY_MAX_CHARS) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, RESULT_SUMMARY_MAX_CHARS)}…`, truncated: true };
}

export class ScheduleHistoryStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "schedule-history.json");
  }

  private readAll(): ScheduleHistoryRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      // D14 후속("지금 실행") — `trigger`가 없는(이 필드 도입 이전) 기록은
      // `"scheduled"`로 정규화한다. 그 시점에는 수동 실행 경로 자체가 없었기
      // 때문에 정확한 사실이다(`local-tool-store.ts`의 `approval` 레거시
      // 정규화와 같은 스타일).
      //
      // 실사용 제보(2026-08-19) — `resultTruncated`가 없는(20,000자 상한 +
      // 이 필드 도입 이전) 기록은 옛 240자 상한으로 잘렸을 가능성이 있다.
      // 그 시점에는 잘림 여부를 별도로 기록하지 않았으므로 정확히 알 수
      // 없다 — "…" 접미사로 끝나는지를 최선-추정(best-effort) 신호로
      // 쓴다(진짜 답변이 "…"로 끝났을 극히 드문 경우 오탐 가능성은 있지만,
      // 반대로 잘린 기록을 "안 잘렸다"고 잘못 단정하는 것보다 안전하다 —
      // 불확실하면 닫는 방향, 루트 CLAUDE.md).
      // 실사용 제보(2026-08-19) — "어떤 툴이 수행됐는지 모르겠다": `toolRouteOutcome`이
      // 없는(이 필드 도입 이전) 기록은 `null`로 정규화한다. 그 시점에는
      // 로컬 Tool 자동선택이 켜져 있었는지조차 기록되지 않았으므로,
      // `"route_inactive"`로 단정하면 실제로는 켜져 있었지만 안 돌았던
      // 기록을 거짓으로 "자동선택 꺼짐"이라고 보여주게 된다 — 불확실하면
      // 닫는(추측하지 않는) 방향을 택한다.
      return (parsed as ScheduleHistoryRecord[]).map((r) => ({
        ...r,
        trigger: r.trigger ?? "scheduled",
        resultTruncated:
          r.resultTruncated ?? (typeof r.resultSummary === "string" && r.resultSummary.endsWith("…")),
        toolRouteOutcome: r.toolRouteOutcome ?? null,
      }));
    } catch {
      return [];
    }
  }

  private save(records: ScheduleHistoryRecord[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }

  append(record: Omit<ScheduleHistoryRecord, "id">): ScheduleHistoryRecord {
    const full: ScheduleHistoryRecord = { ...record, id: crypto.randomUUID() };
    const all = this.readAll();
    all.push(full);
    this.save(all);
    return full;
  }

  /** 최신순. */
  listForSchedule(scheduleId: string): ScheduleHistoryRecord[] {
    return this.readAll()
      .filter((r) => r.scheduleId === scheduleId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** 통합 이력(모든 스케줄), 최신순. */
  listAll(): ScheduleHistoryRecord[] {
    return this.readAll().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}
