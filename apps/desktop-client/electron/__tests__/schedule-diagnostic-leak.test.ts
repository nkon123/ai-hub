// D14 — mirrors `conversation-diagnostic-leak` coverage embedded in
// `diagnostic-bundle.test.ts` for `ConversationStore`: `ScheduleHistoryStore`
// holds structural execution records (schedule id/timestamp/outcome/tool
// args/short summary), never full question/answer text — and
// `electron/diagnostic-bundle.ts` must never import it at all (Allow-list
// principle, that file's own module docstring). Two guarantees pinned here:
// (1) a static source check that `diagnostic-bundle.ts` never references the
//     schedule history/store modules — catches the regression the moment
//     someone adds an import, before any behavioral test would even run;
// (2) a real end-to-end check — write a schedule history record carrying
//     recognizable "sensitive-looking" text in its allowed fields, build a
//     Bundle, and confirm that text is nowhere in the serialized output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { ScheduleHistoryStore } from "../schedule-history-store";
import { buildDiagnosticBundle } from "../diagnostic-bundle";

const ROOT = path.join(__dirname, "..", "..");

let tmpRoot: string;
let layout: InstallRootLayout;
let assetsStore: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-schedule-diag-"));
  layout = resolveInstallRoot(tmpRoot);
  assetsStore = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("schedule history diagnostic-bundle isolation (structural)", () => {
  it("diagnostic-bundle.ts never imports the schedule history/store modules", () => {
    const source = fs.readFileSync(path.join(ROOT, "electron", "diagnostic-bundle.ts"), "utf-8");
    expect(source).not.toContain("schedule-history-store");
    expect(source).not.toContain("schedule-store");
    expect(source).not.toContain("ScheduleHistoryStore");
    expect(source).not.toContain("ScheduleStore");
  });
});

describe("schedule history diagnostic-bundle isolation (behavioral)", () => {
  it("never lets a scheduled run's result summary or failure reason survive into the diagnostic Bundle", async () => {
    const historyStore = new ScheduleHistoryStore(layout.stateDir);
    const RAW_RESULT = "2026년도 인사 평가 등급별 인상률은 S 8%, A 5%이며 김민준 대리가 S등급이다";
    const RAW_FAILURE = "employee_id=10293 조회 중 오류: DB 접속 실패, api_key=sk-live-schedule-secret-999";

    historyStore.append({
      scheduleId: "sched-1",
      timestamp: new Date().toISOString(),
      outcome: "success",
      trigger: "scheduled",
      localToolInvocations: [{ toolName: "salary_lookup", args: { employeeId: "10293" } }],
      resultSummary: RAW_RESULT,
      resultTruncated: false,
      failureReason: null,
    });
    historyStore.append({
      scheduleId: "sched-1",
      timestamp: new Date().toISOString(),
      outcome: "failure",
      trigger: "scheduled",
      localToolInvocations: [],
      resultSummary: null,
      resultTruncated: false,
      failureReason: RAW_FAILURE,
    });

    const bundle = await buildDiagnosticBundle(layout, assetsStore, [], {});
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(RAW_RESULT);
    expect(serialized).not.toContain(RAW_FAILURE);
    expect(serialized).not.toContain("sk-live-schedule-secret-999");
    expect(serialized).not.toContain("salary_lookup");
  });
});
