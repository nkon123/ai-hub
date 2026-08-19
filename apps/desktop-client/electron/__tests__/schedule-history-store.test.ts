import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleHistoryStore, truncateResultSummary } from "../schedule-history-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-history-store-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ScheduleHistoryStore", () => {
  it("returns an empty list when nothing has been recorded yet", () => {
    const store = new ScheduleHistoryStore(tmpDir);
    expect(store.listAll()).toEqual([]);
  });

  // D14 후속("지금 실행", 실사용 제보 3).
  describe("trigger (scheduled vs manual)", () => {
    it("persists the trigger it was given and round-trips through a fresh instance", () => {
      const store = new ScheduleHistoryStore(tmpDir);
      store.append({
        scheduleId: "s1",
        timestamp: "2026-08-19T00:00:00.000Z",
        outcome: "success",
        trigger: "manual",
        localToolInvocations: [],
        resultSummary: "완료",
        failureReason: null,
      });
      const reopened = new ScheduleHistoryStore(tmpDir);
      expect(reopened.listAll()[0].trigger).toBe("manual");
    });

    it("normalizes a legacy record written before this field existed to 'scheduled'", () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const legacy = [
        {
          id: "h1",
          scheduleId: "s1",
          timestamp: "2026-08-01T00:00:00.000Z",
          outcome: "success",
          localToolInvocations: [],
          resultSummary: "완료",
          failureReason: null,
          // trigger 필드 자체가 없다(이 필드 도입 이전 기록).
        },
      ];
      fs.writeFileSync(path.join(tmpDir, "schedule-history.json"), JSON.stringify(legacy));
      const store = new ScheduleHistoryStore(tmpDir);
      expect(store.listAll()[0].trigger).toBe("scheduled");
    });
  });

  it("truncateResultSummary caps overly long text", () => {
    const long = "x".repeat(500);
    const truncated = truncateResultSummary(long);
    expect(truncated.length).toBeLessThanOrEqual(241);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
