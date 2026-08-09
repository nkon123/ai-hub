// D11 로그/진단 필터 — 순수 함수(fs 없음). "기간, Level, Run ID, Trace ID,
// 모듈, 오류코드" 6개 필터 차원을 모두 AND 조건으로 적용한다.
import type { LogEntry, LogFilters } from "./types";

export function filterLogEntries(entries: LogEntry[], filters: LogFilters): LogEntry[] {
  return entries.filter((e) => {
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    if (filters.level && e.level !== filters.level) return false;
    if (filters.runId && e.runId !== filters.runId) return false;
    if (filters.traceId && e.traceId !== filters.traceId) return false;
    if (filters.module && e.module !== filters.module) return false;
    if (filters.errorCode && e.errorCode !== filters.errorCode) return false;
    return true;
  });
}
