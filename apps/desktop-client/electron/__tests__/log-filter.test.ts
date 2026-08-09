import { describe, expect, it } from "vitest";
import { filterLogEntries } from "../log-filter";
import type { LogEntry } from "../types";

const ENTRIES: LogEntry[] = [
  { timestamp: "2026-08-01T00:00:00.000Z", level: "INFO", module: "bundle-install", message: "설치 성공", runId: "r1" },
  {
    timestamp: "2026-08-05T00:00:00.000Z",
    level: "ERROR",
    module: "asset-management",
    message: "Checksum 불일치",
    runId: "r2",
    traceId: "t2",
    errorCode: "CHECKSUM_MISMATCH",
  },
  { timestamp: "2026-08-10T00:00:00.000Z", level: "WARN", module: "connections", message: "연결 실패", traceId: "t3" },
];

describe("filterLogEntries", () => {
  it("returns everything when no filter is given", () => {
    expect(filterLogEntries(ENTRIES, {})).toHaveLength(3);
  });

  it("filters by period (from/to, inclusive)", () => {
    const result = filterLogEntries(ENTRIES, { from: "2026-08-02T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" });
    expect(result.map((e) => e.message)).toEqual(["Checksum 불일치"]);
  });

  it("filters by level", () => {
    expect(filterLogEntries(ENTRIES, { level: "ERROR" }).map((e) => e.message)).toEqual(["Checksum 불일치"]);
  });

  it("filters by runId", () => {
    expect(filterLogEntries(ENTRIES, { runId: "r1" }).map((e) => e.message)).toEqual(["설치 성공"]);
  });

  it("filters by traceId", () => {
    expect(filterLogEntries(ENTRIES, { traceId: "t3" }).map((e) => e.message)).toEqual(["연결 실패"]);
  });

  it("filters by module", () => {
    expect(filterLogEntries(ENTRIES, { module: "connections" }).map((e) => e.message)).toEqual(["연결 실패"]);
  });

  it("filters by errorCode", () => {
    expect(filterLogEntries(ENTRIES, { errorCode: "CHECKSUM_MISMATCH" }).map((e) => e.message)).toEqual(["Checksum 불일치"]);
  });

  it("combines multiple filters with AND", () => {
    const result = filterLogEntries(ENTRIES, { module: "connections", level: "ERROR" });
    expect(result).toEqual([]);
  });
});
