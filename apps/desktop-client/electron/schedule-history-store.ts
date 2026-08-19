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

const RESULT_SUMMARY_MAX_CHARS = 240;

/** Truncates a result string to a short summary — never stores the full
 * answer text (CLAUDE.md: Log에 Prompt 원문·문서 전체를 기본 저장하지
 * 않는다, extended here to the history store's `resultSummary`). */
export function truncateResultSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= RESULT_SUMMARY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, RESULT_SUMMARY_MAX_CHARS)}…`;
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
      return (parsed as ScheduleHistoryRecord[]).map((r) => ({ ...r, trigger: r.trigger ?? "scheduled" }));
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
