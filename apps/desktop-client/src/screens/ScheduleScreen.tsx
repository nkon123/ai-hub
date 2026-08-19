// D14 "등록된 에이전트를 스케줄에 따라 수행" — 저장된 대화 레시피(질문 +
// Knowledge/로컬 Tool/Local Agent/모델 토글, `ChatScreen.tsx`의 `handleSend`가
// non-ollama-only 턴에서 조립하는 것과 정확히 같은 조합)를 정해진 시각에
// Desktop이 자동으로 실행한다. 실제 타이머 루프는 Main Process
// (`electron/schedule-scheduler.ts`)에 있다 — **이 화면이 열려 있지 않아도,
// 심지어 이 앱이 백그라운드에 있어도 실행되지만, Desktop 앱 자체가 꺼져
// 있으면 전혀 실행되지 않는다.** 이 제약은 상시 배너가 아니라(루트
// CLAUDE.md: "정상일 때는 배너를 띄우지 않는다") 빈 목록 안내문에만 적는다.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Plus, Square, Trash2 } from "lucide-react";
import type {
  InstalledAssetWithStatus,
  LocalTool,
  ScheduleExpression,
  ScheduleHistoryRecord,
  ScheduleRecipe,
  ScheduleRecord,
  ScheduleRunOutcome,
} from "../../electron/types";
import { describeScheduleExpression, nextRunAt } from "../../electron/schedule-time";
import { getDesktopBridge } from "../bridge";
import { formatDateTime } from "../format";
import {
  Button,
  BridgeUnavailableState,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  ReasonConfirmDialog,
  Tabs,
} from "../ui";

type ScreenTab = "list" | "history";
type Kind = ScheduleExpression["kind"];

const KIND_LABELS: Record<Kind, string> = { hourly: "매시", daily: "매일", weekly: "매주", monthly: "매월" };
const WEEKDAY_OPTIONS = ["일", "월", "화", "수", "목", "금", "토"];
const OUTCOME_LABELS: Record<ScheduleRunOutcome, string> = {
  success: "성공",
  failure: "실패",
  missed: "놓침",
  cancelled: "중단됨",
};
const OUTCOME_TONE: Record<ScheduleRunOutcome, string> = {
  success: "text-success",
  failure: "text-danger",
  missed: "text-warning",
  cancelled: "text-text-muted",
};

function defaultRecipe(): ScheduleRecipe {
  return {
    question: "",
    knowledgeLookupActive: false,
    knowledgeIds: [],
    localToolRouteActive: false,
    localAgentId: null,
    chatModelAlias: "default-chat",
  };
}

function defaultExpression(): ScheduleExpression {
  return { kind: "daily", hour: 9, minute: 0 };
}

interface FormState {
  id: string | null;
  name: string;
  active: boolean;
  kind: Kind;
  minute: number;
  hour: number;
  dayOfWeek: number;
  daysOfMonth: string; // comma-separated, edited as free text
  recipe: ScheduleRecipe;
}

function formFromSchedule(schedule: ScheduleRecord | null): FormState {
  const expr = schedule?.expression ?? defaultExpression();
  return {
    id: schedule?.id ?? null,
    name: schedule?.name ?? "",
    active: schedule?.active ?? true,
    kind: expr.kind,
    minute: "minute" in expr ? expr.minute : 0,
    hour: "hour" in expr ? expr.hour : 9,
    dayOfWeek: expr.kind === "weekly" ? expr.dayOfWeek : 1,
    daysOfMonth: expr.kind === "monthly" ? expr.daysOfMonth.join(", ") : "1",
    recipe: schedule?.recipe ?? defaultRecipe(),
  };
}

function buildExpression(form: FormState): ScheduleExpression {
  switch (form.kind) {
    case "hourly":
      return { kind: "hourly", minute: form.minute };
    case "daily":
      return { kind: "daily", hour: form.hour, minute: form.minute };
    case "weekly":
      return { kind: "weekly", dayOfWeek: form.dayOfWeek, hour: form.hour, minute: form.minute };
    case "monthly": {
      const days = form.daysOfMonth
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
      return { kind: "monthly", daysOfMonth: days.length > 0 ? days : [1], hour: form.hour, minute: form.minute };
    }
    default:
      return { kind: "daily", hour: 9, minute: 0 };
  }
}

export function ScheduleScreen() {
  const bridge = getDesktopBridge();
  const [tab, setTab] = useState<ScreenTab>("list");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [history, setHistory] = useState<ScheduleHistoryRecord[]>([]);
  const [localTools, setLocalTools] = useState<LocalTool[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<InstalledAssetWithStatus[]>([]);
  const [agentOptions, setAgentOptions] = useState<InstalledAssetWithStatus[]>([]);
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(formFromSchedule(null));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [riskConfirmOpen, setRiskConfirmOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ScheduleRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [deactivateTarget, setDeactivateTarget] = useState<ScheduleRecord | null>(null);
  const [deactivateBusy, setDeactivateBusy] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [scheduleList, historyList, tools, assets, runningId] = await Promise.all([
        bridge.listSchedules(),
        bridge.listScheduleHistory(),
        bridge.listLocalTools(),
        bridge.listInstalledAssets(),
        bridge.getRunningScheduleId(),
      ]);
      setSchedules(scheduleList);
      setHistory(historyList);
      setLocalTools(tools);
      setKnowledgeOptions(
        assets.filter(
          (a) => a.assetType === "knowledge" && (a.activation?.state === "ACTIVE" || a.activation?.state === "ALREADY_ACTIVE"),
        ),
      );
      setAgentOptions(assets.filter((a) => a.assetType === "agent" && a.localAgentRegistration?.state === "ACTIVE"));
      setRunningScheduleId(runningId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "스케줄 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  // 실행 중 표시(취소 버튼)를 위한 가벼운 폴링 — 화면이 열려 있는 동안만.
  useEffect(() => {
    if (!bridge) return;
    const timer = setInterval(() => {
      void bridge.getRunningScheduleId().then(setRunningScheduleId);
    }, 5_000);
    return () => clearInterval(timer);
  }, [bridge]);

  if (!bridge) {
    return (
      <div>
        <h2 className="mb-4 text-section-title font-semibold text-text-primary">스케줄</h2>
        <BridgeUnavailableState detail="스케줄은 Main Process 타이머로 동작하므로 브라우저 개발 모드에서는 확인할 수 없습니다." />
      </div>
    );
  }

  function openCreate() {
    setForm(formFromSchedule(null));
    setSaveError(null);
    setFormOpen(true);
  }

  function openEdit(schedule: ScheduleRecord) {
    setForm(formFromSchedule(schedule));
    setSaveError(null);
    setFormOpen(true);
  }

  const isToolCapable = form.recipe.localToolRouteActive;

  async function attemptSave(acknowledgedToolRisk: boolean) {
    if (!bridge) return;
    if (!form.name.trim() || !form.recipe.question.trim()) {
      setSaveError("스케줄 이름과 질문을 모두 입력하세요.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await bridge.saveSchedule(
        {
          id: form.id ?? undefined,
          name: form.name,
          expression: buildExpression(form),
          recipe: form.recipe,
          active: form.active,
        },
        { acknowledgedToolRisk },
      );
      if (!result.ok) {
        if (result.requiresToolRiskAck) {
          setRiskConfirmOpen(true);
          return;
        }
        setSaveError(result.error);
        return;
      }
      setFormOpen(false);
      setRiskConfirmOpen(false);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(reason: string) {
    if (!bridge || !deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await bridge.removeSchedule(deleteTarget.id, reason);
      if (!result.ok) {
        setDeleteError(result.error ?? "삭제하지 못했습니다.");
        return;
      }
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "삭제하지 못했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleToggleActive(reason: string) {
    if (!bridge || !deactivateTarget) return;
    setDeactivateBusy(true);
    setDeactivateError(null);
    try {
      const result = await bridge.setScheduleActive(deactivateTarget.id, !deactivateTarget.active, reason);
      if (!result.ok) {
        setDeactivateError(result.error ?? "상태를 바꾸지 못했습니다.");
        return;
      }
      setDeactivateTarget(null);
      await load();
    } catch (err) {
      setDeactivateError(err instanceof Error ? err.message : "상태를 바꾸지 못했습니다.");
    } finally {
      setDeactivateBusy(false);
    }
  }

  async function handleCancelRunning(scheduleId: string) {
    if (!bridge) return;
    setCancelling(scheduleId);
    setCancelError(null);
    try {
      const result = await bridge.cancelRunningSchedule(scheduleId);
      if (!result.ok) {
        setCancelError(result.error ?? "중단하지 못했습니다.");
      }
      await load();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "중단하지 못했습니다.");
    } finally {
      setCancelling(null);
    }
  }

  const missedSinceLastVisit = history.filter((h) => h.outcome === "missed").length;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-section-title font-semibold text-text-primary">스케줄</h2>
          <p className="text-caption text-text-secondary">등록된 대화 레시피를 정해진 시각에 자동으로 실행합니다.</p>
        </div>
        <Button onClick={openCreate}>
          <Plus size={16} /> 새 스케줄
        </Button>
      </div>

      {/* 정상일 때는 배너를 띄우지 않는다 — 놓친 실행이 실제로 있을 때만. */}
      {missedSinceLastVisit > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            앱이 꺼져 있는 동안 놓친 실행이 {missedSinceLastVisit}건 있습니다 — "실행 이력"에서 확인할 수 있습니다.
          </span>
        </div>
      )}
      {cancelError && <div className="mb-4"><ErrorBanner message={cancelError} /></div>}

      <Tabs
        tabs={[
          { id: "list", label: "스케줄 목록" },
          { id: "history", label: "실행 이력" },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as ScreenTab)}
      />

      <div className="mt-4">
        {loading && <LoadingState label="스케줄 정보를 불러오는 중..." />}
        {!loading && loadError && <ErrorBanner message={loadError} />}

        {!loading && !loadError && tab === "list" && (
          <ScheduleListView
            schedules={schedules}
            runningScheduleId={runningScheduleId}
            cancelling={cancelling}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onToggleActive={setDeactivateTarget}
            onCancelRunning={handleCancelRunning}
          />
        )}

        {!loading && !loadError && tab === "history" && <HistoryView history={history} schedules={schedules} />}
      </div>

      {formOpen && (
        <ScheduleFormPanel
          form={form}
          setForm={setForm}
          knowledgeOptions={knowledgeOptions}
          agentOptions={agentOptions}
          localTools={localTools}
          saveError={saveError}
          saving={saving}
          onCancel={() => {
            setFormOpen(false);
            setRiskConfirmOpen(false);
          }}
          onSave={() => attemptSave(false)}
        />
      )}

      {riskConfirmOpen && (
        <ToolRiskConfirmDialog
          localTools={localTools}
          submitting={saving}
          onCancel={() => setRiskConfirmOpen(false)}
          onConfirm={() => attemptSave(true)}
        />
      )}

      <ReasonConfirmDialog
        open={deleteTarget !== null}
        title="스케줄 삭제"
        description={deleteTarget ? `'${deleteTarget.name}' 스케줄을 삭제합니다. 실행 이력은 남습니다.` : undefined}
        confirmLabel="삭제"
        reasonLabel="삭제 사유"
        submitting={deleteBusy}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />

      <ReasonConfirmDialog
        open={deactivateTarget !== null}
        title={deactivateTarget?.active ? "스케줄 비활성화" : "스케줄 활성화"}
        description={
          deactivateTarget
            ? deactivateTarget.active
              ? `'${deactivateTarget.name}' 스케줄의 예정된 실행을 중단합니다.`
              : `'${deactivateTarget.name}' 스케줄을 다시 활성화합니다.`
            : undefined
        }
        confirmLabel={deactivateTarget?.active ? "비활성화" : "활성화"}
        reasonLabel="사유"
        danger={deactivateTarget?.active ?? true}
        submitting={deactivateBusy}
        error={deactivateError}
        onConfirm={handleToggleActive}
        onCancel={() => {
          setDeactivateTarget(null);
          setDeactivateError(null);
        }}
      />
    </div>
  );
}

function ScheduleListView({
  schedules,
  runningScheduleId,
  cancelling,
  onEdit,
  onDelete,
  onToggleActive,
  onCancelRunning,
}: {
  schedules: ScheduleRecord[];
  runningScheduleId: string | null;
  cancelling: string | null;
  onEdit: (s: ScheduleRecord) => void;
  onDelete: (s: ScheduleRecord) => void;
  onToggleActive: (s: ScheduleRecord) => void;
  onCancelRunning: (id: string) => void;
}) {
  if (schedules.length === 0) {
    return (
      <EmptyState
        title="등록된 스케줄이 없습니다"
        description="새 스케줄을 만들어 등록된 대화 레시피를 자동으로 실행하세요. 스케줄은 Desktop 앱이 실행 중일 때만 동작합니다 — 앱이 꺼져 있으면 실행되지 않고, 다시 켜지면 놓친 실행이 '실행 이력'에 기록됩니다."
      />
    );
  }
  return (
    <div className="space-y-3">
      {schedules.map((s) => {
        const isRunning = runningScheduleId === s.id;
        return (
          <Card key={s.id} className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <CalendarClock size={16} className="shrink-0 text-text-muted" />
                <span className="truncate font-semibold text-text-primary">{s.name}</span>
                {!s.active && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-caption text-text-muted">비활성</span>}
                {isRunning && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-caption text-brand-700">실행 중</span>}
              </div>
              <p className="mt-1 truncate text-caption text-text-secondary">{describeScheduleExpression(s.expression)}</p>
              <p className="mt-1 text-caption text-text-muted">
                다음 실행: {s.active ? formatDateTime(nextRunAt(s.expression, new Date()).toISOString()) : "비활성"} · 마지막 결과:{" "}
                {s.lastRunOutcome ? <span className={OUTCOME_TONE[s.lastRunOutcome]}>{OUTCOME_LABELS[s.lastRunOutcome]}</span> : "없음"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isRunning && (
                <Button variant="secondary" onClick={() => onCancelRunning(s.id)} disabled={cancelling === s.id}>
                  <Square size={14} /> 지금 실행 중단
                </Button>
              )}
              <Button variant="secondary" onClick={() => onToggleActive(s)}>
                {s.active ? "비활성화" : "활성화"}
              </Button>
              <Button variant="secondary" onClick={() => onEdit(s)}>
                수정
              </Button>
              <Button variant="danger" onClick={() => onDelete(s)}>
                <Trash2 size={14} />
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function HistoryView({ history, schedules }: { history: ScheduleHistoryRecord[]; schedules: ScheduleRecord[] }) {
  if (history.length === 0) {
    return <EmptyState title="실행 이력이 없습니다" description="스케줄이 한 번 이상 실행되면 여기에 기록됩니다." />;
  }
  const nameById = new Map(schedules.map((s) => [s.id, s.name] as const));
  return (
    <div className="space-y-2">
      {history.map((h) => (
        <Card key={h.id} className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">{nameById.get(h.scheduleId) ?? h.scheduleId}</span>
              <span className={`text-caption font-semibold ${OUTCOME_TONE[h.outcome]}`}>{OUTCOME_LABELS[h.outcome]}</span>
            </div>
            <p className="mt-1 text-caption text-text-muted">{formatDateTime(h.timestamp)}</p>
            {h.resultSummary && <p className="mt-1 text-caption text-text-secondary">{h.resultSummary}</p>}
            {h.failureReason && <p className="mt-1 text-caption text-danger">{h.failureReason}</p>}
            {h.localToolInvocations.length > 0 && (
              <p className="mt-1 text-caption text-text-muted">
                호출된 로컬 Tool: {h.localToolInvocations.map((i) => i.toolName).join(", ")}
              </p>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function ScheduleFormPanel({
  form,
  setForm,
  knowledgeOptions,
  agentOptions,
  localTools,
  saveError,
  saving,
  onCancel,
  onSave,
}: {
  form: FormState;
  setForm: (updater: (prev: FormState) => FormState) => void;
  knowledgeOptions: InstalledAssetWithStatus[];
  agentOptions: InstalledAssetWithStatus[];
  localTools: LocalTool[];
  saveError: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card bg-surface p-5 shadow-xl">
        <h3 className="text-card-title font-semibold text-text-primary">{form.id ? "스케줄 수정" : "새 스케줄"}</h3>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-caption font-semibold text-text-muted" htmlFor="schedule-name">
              스케줄 이름
            </label>
            <input
              id="schedule-name"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="예: 매일 아침 정책 요약"
              className="h-10 w-full rounded-lg border border-border px-3 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-caption font-semibold text-text-muted" htmlFor="schedule-question">
              실행할 질문
            </label>
            <textarea
              id="schedule-question"
              value={form.recipe.question}
              onChange={(e) => setForm((prev) => ({ ...prev, recipe: { ...prev.recipe, question: e.target.value } }))}
              rows={2}
              placeholder="예: 이번 주 공지사항을 요약해줘"
              className="w-full rounded-lg border border-border px-3 py-2 text-sm"
            />
          </div>

          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-caption font-semibold text-text-muted">실행 주기</legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, kind }))}
                  className={`rounded-lg border px-3 py-1.5 text-caption ${
                    form.kind === kind ? "border-brand-500 bg-brand-50 text-brand-700" : "border-border text-text-secondary"
                  }`}
                >
                  {KIND_LABELS[kind]}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              {form.kind === "weekly" && (
                <div>
                  <label className="mb-1 block text-caption text-text-muted" htmlFor="schedule-weekday">
                    요일
                  </label>
                  <select
                    id="schedule-weekday"
                    value={form.dayOfWeek}
                    onChange={(e) => setForm((prev) => ({ ...prev, dayOfWeek: Number(e.target.value) }))}
                    className="h-9 rounded-lg border border-border px-2 text-sm"
                  >
                    {WEEKDAY_OPTIONS.map((label, idx) => (
                      <option key={label} value={idx}>
                        {label}요일
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {form.kind === "monthly" && (
                <div>
                  <label className="mb-1 block text-caption text-text-muted" htmlFor="schedule-days">
                    날짜(쉼표로 여러 개, 1-31)
                  </label>
                  <input
                    id="schedule-days"
                    value={form.daysOfMonth}
                    onChange={(e) => setForm((prev) => ({ ...prev, daysOfMonth: e.target.value }))}
                    placeholder="1, 15"
                    className="h-9 w-32 rounded-lg border border-border px-2 text-sm"
                  />
                  <p className="mt-1 text-caption text-text-muted">존재하지 않는 날짜(예: 2월 31일)는 그 달에 건너뜁니다.</p>
                </div>
              )}
              {(form.kind === "daily" || form.kind === "weekly" || form.kind === "monthly") && (
                <div>
                  <label className="mb-1 block text-caption text-text-muted" htmlFor="schedule-hour">
                    시
                  </label>
                  <input
                    id="schedule-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={form.hour}
                    onChange={(e) => setForm((prev) => ({ ...prev, hour: Number(e.target.value) }))}
                    className="h-9 w-20 rounded-lg border border-border px-2 text-sm"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-caption text-text-muted" htmlFor="schedule-minute">
                  분
                </label>
                <input
                  id="schedule-minute"
                  type="number"
                  min={0}
                  max={59}
                  value={form.minute}
                  onChange={(e) => setForm((prev) => ({ ...prev, minute: Number(e.target.value) }))}
                  className="h-9 w-20 rounded-lg border border-border px-2 text-sm"
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-caption font-semibold text-text-muted">사용할 지식/도구</legend>
            <label className="flex items-center gap-2 text-body text-text-primary">
              <input
                type="checkbox"
                checked={form.recipe.knowledgeLookupActive}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, recipe: { ...prev.recipe, knowledgeLookupActive: e.target.checked } }))
                }
              />
              Knowledge 검색 사용
            </label>
            {form.recipe.knowledgeLookupActive && (
              <div className="ml-6 mt-2 space-y-1">
                {knowledgeOptions.length === 0 && (
                  <p className="text-caption text-text-muted">활성화된 Knowledge가 없습니다.</p>
                )}
                {knowledgeOptions.map((k) => (
                  <label key={k.assetId} className="flex items-center gap-2 text-caption text-text-secondary">
                    <input
                      type="checkbox"
                      checked={form.recipe.knowledgeIds.includes(k.assetId)}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          recipe: {
                            ...prev.recipe,
                            knowledgeIds: e.target.checked
                              ? [...prev.recipe.knowledgeIds, k.assetId]
                              : prev.recipe.knowledgeIds.filter((id) => id !== k.assetId),
                          },
                        }))
                      }
                    />
                    {k.name}
                  </label>
                ))}
              </div>
            )}

            <label className="mt-3 flex items-center gap-2 text-body text-text-primary">
              <input
                type="checkbox"
                checked={form.recipe.localToolRouteActive}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, recipe: { ...prev.recipe, localToolRouteActive: e.target.checked } }))
                }
              />
              로컬 Tool 자동 선택 사용
            </label>
            {form.recipe.localToolRouteActive && localTools.length === 0 && (
              <p className="ml-6 mt-1 text-caption text-text-muted">등록된 로컬 Tool이 없습니다 — 실행 시 아무 Tool도 호출되지 않습니다.</p>
            )}

            <div className="mt-3">
              <label className="mb-1 block text-caption text-text-muted" htmlFor="schedule-agent">
                Local Agent (선택)
              </label>
              <select
                id="schedule-agent"
                value={form.recipe.localAgentId ?? ""}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, recipe: { ...prev.recipe, localAgentId: e.target.value || null } }))
                }
                className="h-9 w-full rounded-lg border border-border px-2 text-sm"
              >
                <option value="">표준 Agent</option>
                {agentOptions.map((a) => (
                  <option key={a.assetId} value={a.assetId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-body text-text-primary">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((prev) => ({ ...prev, active: e.target.checked }))} />
            저장 후 즉시 활성화
          </label>
        </div>

        {saveError && (
          <div className="mt-4">
            <ErrorBanner message={saveError} />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            취소
          </Button>
          <Button onClick={onSave} disabled={saving}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

/** F — 스케줄 생성/수정 시점의 구조적 위험 확인 화면. 대화형 실행의 네이티브
 * 승인 대화상자(`electron/main.ts`의 `localTool:invoke`)와 같은 수준의
 * 명확함으로 (1) 이 코드가 격리되지 않은 상태로 사용자 권한으로 실행된다는
 * 것과 (2) 어떤 Tool을 어떤 인자로 호출할지 AI가 스스로 결정하며 실행 시점에
 * 사람이 검토하지 않는다는 것을 밝힌다. */
function ToolRiskConfirmDialog({
  localTools,
  submitting,
  onCancel,
  onConfirm,
}: {
  localTools: LocalTool[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4">
      <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl">
        <div className="flex items-center gap-2 text-warning">
          <AlertTriangle size={18} />
          <h3 className="text-card-title font-semibold">로컬 Tool 실행 위험 확인</h3>
        </div>
        <p className="mt-2 text-body text-text-secondary">
          이 스케줄은 실행될 때 아래 등록된 로컬 Tool 중 하나를 사람의 확인 없이 호출할 수 있습니다.
        </p>
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {localTools.length === 0 && <li className="text-caption text-text-muted">현재 등록된 로컬 Tool이 없습니다.</li>}
          {localTools.map((t) => (
            <li key={t.id} className="text-caption text-text-secondary">
              {t.toolName} — {t.filePath}
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1 text-caption text-text-secondary">
          <p>· 이 Tool은 격리되지 않은 상태로, 사용자의 권한으로 실행됩니다 — 직접 실행한 것과 동일합니다.</p>
          <p>· 이 스케줄이 실행될 때 Tool 선택과 인자는 모두 AI가 스스로 결정합니다 — 실행 시점에 사람이 검토하지 않습니다.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            취소
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={submitting}>
            이해했습니다 — 저장
          </Button>
        </div>
      </div>
    </div>
  );
}
