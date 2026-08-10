// D13 정보/보안 (`02-desktop-and-agent-runtime.md` §D13): Client·Runtime·
// Schema 지원 버전 / Trust Store 상태와 마지막 Revocation List 날짜 / 라이선스와
// 오픈소스 고지 / 진단 경로 / 데이터 저장 위치.
//
// "진단 경로"는 D11(LogsScreen)의 진단 Bundle 생성을 그대로 재사용한다 —
// 별도의 진단 로직을 두지 않는다. Trust Store는 이 PoC에 PKI가 없어
// (open-decisions.md D-016/D-048) 항상 "신뢰됨"류 배지를 보여주지 않고
// 그 사실을 그대로 말한다.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileWarning, RefreshCw, ShieldOff } from "lucide-react";
import type { DiagnosticBundle, SystemInfoView } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, BridgeUnavailableState, Card, ErrorBanner, LoadingState, Modal, PageHeader, ReadOnlyField } from "../ui";
import { formatDateTime } from "../format";

function SectionHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-card-title font-semibold text-text-primary">{title}</h2>;
}

export function InfoScreen() {
  const bridge = getDesktopBridge();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SystemInfoView | null>(null);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setInfo(await bridge.getSystemInfo());
    } catch (err) {
      setError(err instanceof Error ? err.message : "정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  // 진단 Bundle 생성 — D11과 동일한 IPC 호출(별도 구현 없음).
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleResult, setBundleResult] = useState<{ bundle: DiagnosticBundle; savedPath: string } | null>(null);

  async function generateDiagnostics() {
    if (!bridge) return;
    setBundleBusy(true);
    setBundleError(null);
    try {
      setBundleResult(await bridge.generateDiagnosticBundle({}));
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : "진단 Bundle 생성 중 오류가 발생했습니다.");
    } finally {
      setBundleBusy(false);
    }
  }

  if (!bridge) {
    return (
      <div>
        <PageHeader title="정보/보안" description="Client·Runtime 버전, Trust 상태, 라이선스를 확인합니다." />
        <BridgeUnavailableState detail="정보/보안 화면은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다." />
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="정보/보안" description="Client·Runtime 버전, Trust 상태, 라이선스를 확인합니다." />
        <LoadingState label="정보를 불러오는 중..." />
      </div>
    );
  }

  if (error || !info) {
    return (
      <div>
        <PageHeader
          title="정보/보안"
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw size={14} /> 새로고침
            </Button>
          }
        />
        <ErrorBanner message={error ?? "정보를 불러오지 못했습니다."} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="정보/보안"
        description="Client·Runtime·Schema 지원 버전, Trust 상태, 라이선스, 데이터 저장 위치를 확인합니다."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} /> 새로고침
          </Button>
        }
      />

      <Card className="p-6">
        <SectionHeader title="Client · Runtime · Schema 지원 버전" />
        <div className="grid gap-3 sm:grid-cols-3">
          <ReadOnlyField label="Client 버전" value={info.clientVersion} />
          <ReadOnlyField
            label="Runtime 버전"
            value={info.runtimeVersion ?? "확인 불가"}
            policyNote={info.runtimeVersionNote ?? undefined}
          />
          <ReadOnlyField label="지원 Manifest Schema 버전" value={info.schemaVersion.supportedVersion} policyNote={info.schemaVersion.source} />
        </div>
      </Card>

      <Card className="p-6">
        <SectionHeader title="Trust Store 상태 · 마지막 Revocation List 반영 시각" />
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <ShieldOff size={16} className="mt-0.5 shrink-0" />
          <span>{info.trustStore.message}</span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ReadOnlyField label="로컬에 알려진 Revocation 항목 수" value={String(info.revocationList.knownEntryCount)} />
          <ReadOnlyField
            label="마지막 로컬 반영 시각"
            value={info.revocationList.lastLocalUpdateAt ? formatDateTime(info.revocationList.lastLocalUpdateAt) : "아직 없음"}
            policyNote={info.revocationList.note}
          />
        </div>
      </Card>

      <Card className="p-6">
        <SectionHeader title="라이선스와 오픈소스 고지" />
        <p className="mb-3 flex items-start gap-1.5 text-caption text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {info.openSourceNotices.incompleteReason}
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-caption">
            <thead className="border-b border-border bg-background text-text-muted">
              <tr>
                <th className="px-3 py-2">Package</th>
                <th className="px-3 py-2">선언된 범위</th>
                <th className="px-3 py-2">설치된 버전</th>
                <th className="px-3 py-2">License</th>
              </tr>
            </thead>
            <tbody>
              {info.openSourceNotices.entries.map((e) => (
                <tr key={e.name} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-text-primary">{e.name}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.declaredRange}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.resolvedVersion ?? "확인 불가"}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.license ?? "확인 불가"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-card-title font-semibold text-text-primary">진단 경로</h2>
          <Button variant="secondary" size="sm" onClick={() => void generateDiagnostics()} disabled={bundleBusy}>
            <FileWarning size={14} /> {bundleBusy ? "생성 중..." : "진단 Bundle 생성(D11과 동일)"}
          </Button>
        </div>
        <ReadOnlyField label="진단 Bundle 저장 경로" value={info.dataLocations.diagnosticsDir} />
        {bundleError && (
          <div className="mt-3">
            <ErrorBanner message={bundleError} />
          </div>
        )}
      </Card>

      <Card className="p-6">
        <SectionHeader title="데이터 저장 위치" />
        <div className="grid gap-3 sm:grid-cols-2">
          <ReadOnlyField label="설치 Root" value={info.dataLocations.installRoot} />
          <ReadOnlyField label="자산(Assets)" value={info.dataLocations.assetsDir} />
          <ReadOnlyField label="상태(State)" value={info.dataLocations.stateDir} />
          <ReadOnlyField label="로그" value={info.dataLocations.logsDir} />
          <ReadOnlyField label="Quarantine(검증 전 임시 영역)" value={info.dataLocations.quarantineDir} />
          <ReadOnlyField label="Office Profile" value={info.dataLocations.profilesDir} />
        </div>
      </Card>

      <Modal open={bundleResult !== null} title="진단 Bundle 생성 완료" onClose={() => setBundleResult(null)}>
        {bundleResult && (
          <div className="space-y-2">
            <p className="text-body text-text-secondary">다음 경로에 저장되었습니다.</p>
            <p className="break-all rounded-lg bg-background p-2 text-caption text-text-primary">{bundleResult.savedPath}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
