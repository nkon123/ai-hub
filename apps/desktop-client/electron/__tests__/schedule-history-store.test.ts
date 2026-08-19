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
        toolRouteOutcome: "route_inactive",
        resultSummary: "완료",
        resultTruncated: false,
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

  describe("truncateResultSummary (실사용 제보 2026-08-19 — 240자 → 20,000자)", () => {
    it("does not truncate text within the new cap and reports truncated: false", () => {
      const text = "x".repeat(20_000);
      const result = truncateResultSummary(text);
      expect(result.text).toBe(text);
      expect(result.truncated).toBe(false);
    });

    it("truncates text beyond the new cap and reports truncated: true", () => {
      const long = "x".repeat(25_000);
      const result = truncateResultSummary(long);
      expect(result.text.length).toBeLessThanOrEqual(20_001);
      expect(result.text.endsWith("…")).toBe(true);
      expect(result.truncated).toBe(true);
    });

    it("a result well over the old 240-char cap round-trips in full through the store (not silently re-truncated)", () => {
      const store = new ScheduleHistoryStore(tmpDir);
      const longAnswer = "이메일 요약: ".concat("본문 내용 ".repeat(1000)); // far over 240 chars
      const { text, truncated } = truncateResultSummary(longAnswer);
      store.append({
        scheduleId: "s1",
        timestamp: "2026-08-19T00:00:00.000Z",
        outcome: "success",
        trigger: "scheduled",
        localToolInvocations: [],
        toolRouteOutcome: "route_inactive",
        resultSummary: text,
        resultTruncated: truncated,
        failureReason: null,
      });
      const reopened = new ScheduleHistoryStore(tmpDir);
      const stored = reopened.listAll()[0];
      expect(stored.resultSummary?.length).toBeGreaterThan(240);
      expect(stored.resultSummary).toBe(text);
    });
  });

  describe("resultTruncated legacy normalization", () => {
    it("normalizes a legacy record written before this field existed using the '…' suffix as a best-effort signal", () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const legacy = [
        {
          id: "h1",
          scheduleId: "s1",
          timestamp: "2026-08-01T00:00:00.000Z",
          outcome: "success",
          trigger: "scheduled",
          localToolInvocations: [],
          resultSummary: "잘려서 저장된 옛 요약…",
          failureReason: null,
          // resultTruncated 필드 자체가 없다(이 필드 도입 이전 기록, 옛 240자
          // 상한에 걸려 "…"가 붙어 있다).
        },
        {
          id: "h2",
          scheduleId: "s1",
          timestamp: "2026-08-02T00:00:00.000Z",
          outcome: "success",
          trigger: "scheduled",
          localToolInvocations: [],
          resultSummary: "잘리지 않은 짧은 답변",
          failureReason: null,
        },
      ];
      fs.writeFileSync(path.join(tmpDir, "schedule-history.json"), JSON.stringify(legacy));
      const store = new ScheduleHistoryStore(tmpDir);
      const [newer, older] = store.listAll();
      expect(older.resultTruncated).toBe(true);
      expect(newer.resultTruncated).toBe(false);
    });
  });

  // 실사용 제보(2026-08-19) — "어떤 툴이 수행됐는지 모르겠다".
  describe("toolRouteOutcome", () => {
    it("persists the value it was given and round-trips through a fresh instance", () => {
      const store = new ScheduleHistoryStore(tmpDir);
      store.append({
        scheduleId: "s1",
        timestamp: "2026-08-19T00:00:00.000Z",
        outcome: "success",
        trigger: "scheduled",
        localToolInvocations: [{ toolName: "add_numbers", args: { a: 1, b: 2 } }],
        toolRouteOutcome: "ran",
        resultSummary: "3",
        resultTruncated: false,
        failureReason: null,
      });
      const reopened = new ScheduleHistoryStore(tmpDir);
      expect(reopened.listAll()[0].toolRouteOutcome).toBe("ran");
    });

    it("normalizes a legacy record written before this field existed to null (does not guess route_inactive)", () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const legacy = [
        {
          id: "h1",
          scheduleId: "s1",
          timestamp: "2026-08-01T00:00:00.000Z",
          outcome: "success",
          trigger: "scheduled",
          localToolInvocations: [],
          resultSummary: "완료",
          resultTruncated: false,
          failureReason: null,
          // toolRouteOutcome 필드 자체가 없다(이 필드 도입 이전 기록) — 그
          // 시점엔 자동선택이 켜져 있었는지조차 기록되지 않았으므로
          // "route_inactive"로 단정하지 않고 null로 정규화한다.
        },
      ];
      fs.writeFileSync(path.join(tmpDir, "schedule-history.json"), JSON.stringify(legacy));
      const store = new ScheduleHistoryStore(tmpDir);
      expect(store.listAll()[0].toolRouteOutcome).toBeNull();
    });
  });
});
