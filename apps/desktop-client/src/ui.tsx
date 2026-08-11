// Local UI primitives for the Desktop Client (M04). Deliberately NOT
// imported from apps/portal-web/app/_components/ui.tsx — cross-module
// imports of another app's internals are disallowed (CLAUDE.md 구현 원칙 2).
// The Tailwind classes mirror that file's visual language (same brand
// tokens, same shapes) so both surfaces read as one product.
import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import type { CheckStatus } from "../electron/types";

// Style guide §9.1/§9.2: primary = brand-500 fill, white text; secondary =
// white fill, brand-500 text, brand-200 (#C9D3FA) border; danger = status
// red. Matches apps/portal-web/app/_components/ui.tsx's Button so both
// surfaces read as one product.
const BUTTON_VARIANTS = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-300 disabled:text-slate-500",
  secondary:
    "bg-white text-brand-500 border border-brand-200 hover:bg-brand-50 disabled:border-slate-200 disabled:text-slate-400",
  danger: "bg-danger text-white hover:bg-red-600 disabled:bg-slate-300 disabled:text-slate-500",
} as const;

// md = style guide §9.1: height 40px, padding 0 18px.
const BUTTON_SIZES = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-[18px] text-sm",
} as const;

type ButtonVariant = keyof typeof BUTTON_VARIANTS;
type ButtonSize = keyof typeof BUTTON_SIZES;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // Style guide §9.1: radius 8px (rounded-lg), font-weight 600, icon-text gap 8px.
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  // Style guide §7.1: 14px radius, 1px border, soft shadow; §7.2: border always visible.
  return <div className={`rounded-card border border-border bg-surface shadow-card ${className}`}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-page-title font-bold text-text-primary">{title}</h1>
        {description && <p className="mt-1.5 text-body text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
      <p className="text-card-title font-medium text-text-primary">{title}</p>
      {description && <p className="text-body text-text-secondary">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "불러오는 중..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-body text-text-muted">
      <Loader2 size={16} className="animate-spin" />
      {label}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** Shown by a screen instead of its normal content when
 * `getDesktopBridge()` returns null — the renderer isn't running inside the
 * Electron shell (or the preload bridge failed to attach). This is a calm,
 * expected state, not an error: no data was lost, the feature simply needs
 * the Desktop runtime. Pair with disabling any action buttons that would
 * otherwise trigger file/IPC work (CLAUDE.md: 호환되지 않는 선택지는 이유와
 * 함께 비활성화). */
export function BridgeUnavailableState({ detail }: { detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-warning/30 bg-warning/5 px-6 py-16 text-center">
      <AlertTriangle size={28} className="text-warning" />
      <p className="text-card-title font-medium text-text-primary">Desktop 런타임이 필요합니다</p>
      <p className="max-w-sm text-body text-text-secondary">
        {detail ?? "이 화면의 기능은 Desktop(Electron) 앱에서 실행할 때만 사용할 수 있습니다."}
      </p>
    </div>
  );
}

// Style guide §5.3 status colors, used at full saturation here (not the
// low-opacity badge fills elsewhere) because this checklist is the one place
// an air-gapped operator decides whether to trust a bundle — the PASS/WARN/
// FAIL distinction must be unmistakable at a glance, not just decorative.
const STATUS_ICON: Record<CheckStatus, ReactNode> = {
  PASS: <CheckCircle2 size={16} className="text-success" />,
  WARN: <AlertTriangle size={16} className="text-warning" />,
  FAIL: <XCircle size={16} className="text-danger" />,
  SKIP: <Loader2 size={16} className="text-text-muted" />,
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  PASS: "통과",
  WARN: "경고",
  FAIL: "실패",
  SKIP: "대기",
};

// Label pill per status (not just the row tint) so PASS/WARN/FAIL reads
// unambiguously even at a glance or in a quick screenshot.
const STATUS_LABEL_TONE: Record<CheckStatus, string> = {
  PASS: "bg-success/10 text-success",
  WARN: "bg-warning/10 text-warning",
  FAIL: "bg-danger/10 text-danger",
  SKIP: "bg-slate-100 text-text-muted",
};

const STATUS_ROW_TONE: Record<CheckStatus, string> = {
  PASS: "border-border",
  WARN: "border-warning/30 bg-warning/5",
  FAIL: "border-danger/30 bg-danger/5",
  SKIP: "border-border/60",
};

/** Lightweight destructive-action confirmation (removal of an installed
 * asset). Modeled after the portal's ReasonDialog pattern but without a
 * required reason field — this is a local uninstall, not an
 * approve/reject/suspend/discard decision subject to CLAUDE.md's "사유 필수"
 * rule. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "확인",
  submitting = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-xl">
        <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
        {description && <div className="mt-1.5 text-body text-text-secondary">{description}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            취소
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Confirmation dialog that additionally requires a non-empty reason before
 * the confirm action becomes available — CLAUDE.md: "승인·반려·중단·폐기는
 * 확인과 사유를 요구한다", extended here to D12/D08's "Active Version 전환/
 * Rollback"과 "버전 제거" (both are meaningful, hard-to-undo state changes on
 * a shared install, unlike the plain local-uninstall case `ConfirmDialog`'s
 * own docstring exempts). Manages its own reason input state so call sites
 * don't need to thread it through their own state — `onConfirm` receives the
 * trimmed reason directly. */
export function ReasonConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "확인",
  reasonLabel = "사유",
  reasonPlaceholder = "이 작업을 수행하는 이유를 입력하세요.",
  danger = true,
  submitting = false,
  error = null,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** false = secondary (blue) confirm button, for non-destructive-but-still-
   * consequential actions like Active Version 전환/Rollback; true (default)
   * = red, for actual removal. */
  danger?: boolean;
  submitting?: boolean;
  /** Shown inside the dialog (not just a page-level banner) so a failed
   * attempt keeps the dialog open with the typed reason intact, letting the
   * user retry without losing context — same pattern D08's removal Modal
   * already used for `removeError`. */
  error?: string | null;
  /** Extra confirm-disabling condition beyond "reason is non-empty" —
   * e.g. D03's removal dialog uses this so the button is never clickable
   * while `checkAssetRemoval` reports the removal is blocked (CLAUDE.md:
   * 호환되지 않는 선택지는 이유와 함께 비활성화). Defaults to `false` so
   * every existing caller keeps its exact previous behavior. */
  confirmDisabled?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  // Reset only when the dialog actually closes (cancel OR a successful
  // confirm, both of which the caller signals by flipping `open` to false) —
  // NOT on every confirm click, so a failed attempt (dialog stays open,
  // `error` gets set) keeps what the user typed instead of wiping it.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setReason("");
  }

  if (!open) return null;

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !submitting && !confirmDisabled;

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm(trimmed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-xl">
        <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
        {description && <div className="mt-1.5 text-body text-text-secondary">{description}</div>}
        <div className="mt-4">
          <label className="mb-1.5 block text-caption font-medium text-text-secondary" htmlFor="reason-confirm-input">
            {reasonLabel} <span className="text-danger">*</span>
          </label>
          <textarea
            id="reason-confirm-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            rows={2}
            disabled={submitting}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-body text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
          />
          {reason.length > 0 && trimmed.length === 0 && (
            <p className="mt-1 text-caption text-danger">공백만으로는 사유가 될 수 없습니다.</p>
          )}
        </div>
        {error && <div className="mt-3">{<ErrorBanner message={error} />}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            취소
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={handleConfirm} disabled={!canConfirm}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Generic detail overlay for D08's "상세 Manifest 보기"/"의존 관계 보기" —
 * same overlay chrome as `ConfirmDialog` but a plain close action instead of
 * a confirm/cancel decision, and a wider/taller body for JSON/list content.
 * Kept separate from `ConfirmDialog` rather than generalizing it, so an
 * existing, already-working destructive-confirmation flow is never touched
 * by an unrelated read-only-panel change. */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-card bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="rounded-lg p-1 text-text-muted transition-colors hover:bg-background hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto text-body text-text-secondary">{children}</div>
      </div>
    </div>
  );
}

/** Shared labeled text input — used by D01(SetupWizardScreen)/D10(SettingsScreen)
 * so both screens' forms look and behave identically (CLAUDE.md: 모든 Form
 * Field에 Label을 제공한다). */
export function LabeledInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-caption font-semibold text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary disabled:bg-slate-50 disabled:text-text-muted"
      />
    </div>
  );
}

/** Read-only field row for D10 values fixed by policy — CLAUDE.md/spec §D10:
 * "정책으로 고정된 값은 읽기 전용으로 표시하고 출처 정책명을 보여준다." */
export function ReadOnlyField({ label, value, policyNote }: { label: string; value: string; policyNote?: string }) {
  return (
    <div>
      <p className="mb-1 text-caption font-semibold text-text-muted">{label}</p>
      <p className="text-body text-text-primary">{value}</p>
      {policyNote && <p className="mt-0.5 text-caption text-text-muted">{policyNote}</p>}
    </div>
  );
}

// D-IA02 IA 재편(11개 사이드바 탭 -> 3개 + 하위 탭)에서 도입. 하위 탭(자산
// 허브의 스토어/가져오기/설치된 자산/업데이트·복구, 설정의 일반/연결
// 상태/로그·진단/정보·보안)을 위한 공용 primitive. 시각 언어는
// apps/portal-web/app/_components/ui.tsx의 `Tabs`를 그대로 미러링한다(같은
// 제품처럼 보이게) — 하지만 그 파일을 import하지 않는다(모듈 경계 위반,
// CLAUDE.md 구현 원칙 2).
export interface TabItem {
  id: string;
  label: string;
}

export function Tabs({ tabs, activeId, onChange }: { tabs: TabItem[]; activeId: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-body font-medium transition-colors ${
              active ? "border-brand-500 text-brand-700" : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function CheckRow({ label, status, message }: { label: string; status: CheckStatus; message: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${STATUS_ROW_TONE[status]}`}>
      <div className="mt-0.5 shrink-0">{STATUS_ICON[status]}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium text-text-primary">{label}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_LABEL_TONE[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
        <p className="mt-0.5 text-caption text-text-secondary">{message}</p>
      </div>
    </div>
  );
}
