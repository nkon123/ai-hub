// D11 로그/진단 — 필터(기간, Level, Run ID, Trace ID, 모듈, 오류코드)와 진단
// Bundle 생성(Sanitized 설정·설치 자산 Hash·Health·Sanitized Log만 포함,
// 실제 Prompt·문서·DB 결과·Secret은 제외).
import { useCallback, useMemo, useState } from "react";
import { Download, FileWarning, RefreshCw } from "lucide-react";
import type { DiagnosticBundle, LogEntry, LogFilters, LogLevel } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, EmptyState, ErrorBanner, LoadingState, Modal, PageHeader } from "../ui";
import { formatDateTime } from "../format";

const LEVEL_OPTIONS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

const LEVEL_TONE: Record<LogLevel, string> = {
  DEBUG: "bg-slate-100 text-text-muted",
  INFO: "bg-brand-50 text-brand-700",
  WARN: "bg-warning/10 text-warning",
  ERROR: "bg-danger/10 text-danger",
};

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption font-semibold text-text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "h-9 rounded-lg border border-border bg-white px-3 text-sm text-text-primary focus:border-brand-500 focus:outline-none";

export function LogsScreen() {
  const bridge = getDesktopBridge();
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [level, setLevel] = useState<LogLevel | "">("");
  const [runId, setRunId] = useState("");
  const [traceId, setTraceId] = useState("");
  const [logModule, setLogModule] = useState("");
  const [errorCode, setErrorCode] = useState("");

  const [bundleResult, setBundleResult] = useState<{ bundle: DiagnosticBundle; savedPath: string } | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const currentFilters: LogFilters = useMemo(
    () => ({
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      level: level || undefined,
      runId: runId.trim() || undefined,
      traceId: traceId.trim() || undefined,
      module: logModule.trim() || undefined,
      errorCode: errorCode.trim() || undefined,
    }),
    [from, to, level, runId, traceId, logModule, errorCode],
  );

  const load = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    setLoading(true);
    try {
      setLogs(await bridge.listLogs(currentFilters));
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그를 불러오지 못했습니다.");
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [bridge, currentFilters]);

  async function handleGenerateBundle() {
    if (!bridge) return;
    setBundleBusy(true);
    setBundleError(null);
    try {
      const result = await bridge.generateDiagnosticBundle(currentFilters);
      setBundleResult(result);
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : "진단 Bundle 생성 중 오류가 발생했습니다.");
    } finally {
      setBundleBusy(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="로그/진단" />
        <BridgeUnavailableState detail="로그 조회와 진단 Bundle 생성은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="로그/진단"
        description="오류를 검색하고, 공유 가능한 진단 Bundle을 생성합니다(실제 Prompt·문서·DB 결과·Secret은 제외됩니다)."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} /> 조회
          </Button>
        }
      />

      <Card className="mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-3 lg:grid-cols-6">
        <FilterField label="시작 시각">
          <input type="datetime-local" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        </FilterField>
        <FilterField label="종료 시각">
          <input type="datetime-local" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </FilterField>
        <FilterField label="Level">
          <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value as LogLevel | "")}>
            <option value="">전체</option>
            {LEVEL_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Run ID">
          <input className={inputClass} value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="run-..." />
        </FilterField>
        <FilterField label="Trace ID">
          <input className={inputClass} value={traceId} onChange={(e) => setTraceId(e.target.value)} placeholder="trace-..." />
        </FilterField>
        <FilterField label="모듈">
          <input className={inputClass} value={logModule} onChange={(e) => setLogModule(e.target.value)} placeholder="bundle-install" />
        </FilterField>
        <FilterField label="오류코드">
          <input className={inputClass} value={errorCode} onChange={(e) => setErrorCode(e.target.value)} placeholder="CHECKSUM_MISMATCH" />
        </FilterField>
        <div className="col-span-full flex justify-end">
          <Button onClick={() => void handleGenerateBundle()} disabled={bundleBusy}>
            <FileWarning size={14} /> {bundleBusy ? "생성 중..." : "진단 Bundle 생성"}
          </Button>
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {bundleError && (
        <div className="mb-4">
          <ErrorBanner message={bundleError} />
        </div>
      )}

      {loading && <LoadingState label="로그를 불러오는 중..." />}

      {!loading && logs === null && (
        <EmptyState title="조회를 시작하세요" description="위 필터를 설정한 뒤 '조회' 버튼을 눌러 로그를 확인합니다." />
      )}

      {!loading && logs !== null && logs.length === 0 && (
        <EmptyState title="조건에 맞는 로그가 없습니다" description="필터를 조정하거나 기간을 넓혀 다시 조회해 보세요." />
      )}

      {!loading && logs !== null && logs.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
          <table className="w-full text-left text-caption">
            <thead className="border-b border-border bg-background text-text-muted">
              <tr>
                <th className="px-3 py-2">시각</th>
                <th className="px-3 py-2">Level</th>
                <th className="px-3 py-2">모듈</th>
                <th className="px-3 py-2">메시지</th>
                <th className="px-3 py-2">Run ID</th>
                <th className="px-3 py-2">Trace ID</th>
                <th className="px-3 py-2">오류코드</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry, idx) => (
                <tr key={idx} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{formatDateTime(entry.timestamp)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${LEVEL_TONE[entry.level]}`}>{entry.level}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{entry.module}</td>
                  <td className="px-3 py-2 text-text-primary">{entry.message}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">{entry.runId ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">{entry.traceId ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">{entry.errorCode ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={bundleResult !== null} title="진단 Bundle 생성 완료" onClose={() => setBundleResult(null)}>
        {bundleResult && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 text-body text-text-secondary">
              <Download size={16} className="mt-0.5 shrink-0 text-success" />
              다음 경로에 저장되었습니다. 이 파일을 공유해 진단에 사용할 수 있습니다.
            </p>
            <p className="break-all rounded-lg bg-background p-2 text-caption text-text-primary">{bundleResult.savedPath}</p>
            <ul className="space-y-1 text-caption text-text-secondary">
              <li>Client 버전: {bundleResult.bundle.clientVersion}</li>
              <li>Runtime 버전: {bundleResult.bundle.runtimeVersion ?? `확인 불가 (${bundleResult.bundle.runtimeVersionNote})`}</li>
              <li>
                OS: {bundleResult.bundle.os.platform} {bundleResult.bundle.os.release} ({bundleResult.bundle.os.arch})
              </li>
              <li>Python 정보: {bundleResult.bundle.pythonVersionNote}</li>
              <li>설치 자산 수: {bundleResult.bundle.installedAssets.length}</li>
              <li>포함된 Log: {bundleResult.bundle.logs.length}건 (Sanitized)</li>
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}
