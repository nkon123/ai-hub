"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

// Style guide §9.1/§9.2: primary = brand-500 fill, white text; secondary =
// white fill, brand-500 text, brand-200 (#C9D3FA) border; danger = status
// red. `accent` isn't in the guide's button spec — kept as a purple variant
// (existing callers use it for a Knowledge→Chatbot cross-sell CTA) so its
// signature/behavior doesn't change, just its shade.
const BUTTON_VARIANTS = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-300 disabled:text-slate-500",
  secondary:
    "bg-white text-brand-500 border border-brand-200 hover:bg-brand-50 disabled:border-slate-200 disabled:text-slate-400",
  accent: "bg-purple-600 text-white hover:bg-purple-700 disabled:bg-slate-300 disabled:text-slate-500",
  danger: "bg-danger text-white hover:bg-red-600 disabled:bg-slate-300 disabled:text-slate-500",
  // "On dark/brand background" pair — for CTAs placed over the Welcome Banner's brand-colored
  // fill (style guide §8.1). Kept as distinct variants rather than overriding primary/secondary
  // via `className`: Tailwind utilities have no specificity difference, so a caller-supplied
  // `text-brand-700` does NOT reliably beat this file's own `text-white` in the cascade — the
  // winner depends on generated CSS source order, not JSX class order. Separate variants avoid
  // that footgun entirely.
  inverse: "bg-white text-brand-700 hover:bg-brand-50 disabled:bg-white/50 disabled:text-brand-300",
  "inverse-outline":
    "border border-white/40 bg-white/10 text-white hover:bg-white/20 disabled:border-white/20 disabled:text-white/50",
} as const;

// md = style guide §9.1: height 40px, padding 0 18px.
const BUTTON_SIZES = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-[18px] text-sm",
  lg: "h-12 px-6 text-[15px]",
} as const;

type ButtonVariant = keyof typeof BUTTON_VARIANTS;
type ButtonSize = keyof typeof BUTTON_SIZES;

interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}

type ButtonProps = ButtonBaseProps &
  (
    | ({ href: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className">)
    | ({ href?: undefined } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">)
  );

/** Shared CTA control. Renders an <a> when `href` is given, else a <button>. */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  // Style guide §9.1: radius 8px (rounded-lg), font-weight 600, icon-text gap 8px.
  const classes = `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;

  if ("href" in rest && rest.href !== undefined) {
    return (
      <a className={classes} {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  }
  return (
    <button className={classes} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}

// Status tones use the guide's §5.3 status colors at low-opacity fills
// (small badges only, per §5.4's "never large background fills" rule).
const BADGE_TONES = {
  neutral: "bg-slate-100 text-text-secondary",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  purple: "bg-purple-50 text-purple-700",
  brand: "bg-brand-50 text-brand-700",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Central status → tone mapping, shared by the catalog list and the detail page. */
const STATUS_TONE: Record<string, BadgeTone> = {
  APPROVED: "success",
  ACTIVE: "success",
  COMPLETED: "success",
  DRAFT: "neutral",
  PENDING: "warning",
  VALIDATING: "warning",
  RUNNING: "info",
  READY_FOR_REVIEW: "info",
  IN_REVIEW: "purple",
  CHANGES_REQUESTED: "warning",
  REJECTED: "danger",
  SUSPENDED: "danger",
  DEPRECATED: "danger",
  RETIRED: "neutral",
  CANCELLED: "neutral",
  FAILED: "danger",
  // DeploymentRevision statuses (M02 게시 관리) not already covered above.
  PUBLISHING: "info",
  SUPERSEDED: "neutral",
  // Distribution/Offline Bundle Job status (§10.4) and stage (§4.4) values
  // not already covered above — QUEUED and the RESOLVING→PACKAGING stages
  // are in-progress states, SUCCEEDED mirrors COMPLETED.
  QUEUED: "warning",
  RESOLVING: "info",
  COLLECTING: "info",
  VERIFYING: "info",
  PACKAGING: "info",
  SUCCEEDED: "success",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

// Card's own border/background classes below have the same CSS specificity as any
// color utility a caller might pass via `className` (e.g. "bg-danger/5") — Tailwind
// utilities never out-rank each other by specificity, only by source order in the
// generated stylesheet, which callers can't control. So a tinted card (e.g. a 중단
// 사유 / 위험 알림 card) needs its border+background chosen here, not layered on by
// the caller — same reasoning as the Button `inverse`/`inverse-outline` variants.
const CARD_TONES = {
  neutral: "border-border bg-surface",
  danger: "border-danger/30 bg-danger/5",
} as const;

export function Card({
  href,
  onClick,
  tone = "neutral",
  className = "",
  children,
}: {
  href?: string;
  onClick?: () => void;
  tone?: keyof typeof CARD_TONES;
  className?: string;
  children: ReactNode;
}) {
  // Style guide §7.1: 14px radius, 1px border, soft shadow; §7.2: border always visible.
  const classes = `block rounded-card border shadow-card ${CARD_TONES[tone]} ${
    href || onClick ? "cursor-pointer transition-shadow hover:shadow-[0_4px_16px_rgba(20,30,55,0.08)]" : ""
  } ${className}`;

  if (href) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <div onClick={onClick} className={classes}>
      {children}
    </div>
  );
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

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
      {icon && <div className="mb-1 text-slate-300">{icon}</div>}
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

export function FormField({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-body font-medium text-text-primary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {error && <p className="mt-1.5 text-caption text-danger">{error}</p>}
    </div>
  );
}

/**
 * Horizontal tab strip — P19 Service 상세 is the first screen with enough
 * independent sections (§01-portal-and-distribution.md P19 lists 8) that
 * stacking them as sequential `Card`s (the pattern every other detail page
 * uses — see `app/assets/[id]/page.tsx`, `app/deployments/[id]/page.tsx`)
 * would make the page unnavigably long. No tab-switcher existed anywhere in
 * this codebase to reuse, so this is a new shared primitive rather than a
 * one-off: styled after the Composer's numbered step-nav
 * (`app/services/new/page.tsx`) so it reads as the same design system.
 * A disabled tab (`disabledReason` set) renders inert with its reason as a
 * tooltip, matching CLAUDE.md's "호환되지 않는 선택지는 이유와 함께
 * 비활성화한다."
 */
export interface TabItem {
  id: string;
  label: string;
  disabledReason?: string;
}

export function Tabs({
  tabs,
  activeId,
  onChange,
}: {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const disabled = !!tab.disabledReason;
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            title={tab.disabledReason}
            onClick={() => !disabled && onChange(tab.id)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-body font-medium transition-colors ${
              disabled
                ? "cursor-not-allowed border-transparent text-slate-300"
                : active
                ? "border-brand-500 text-brand-700"
                : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
            {disabled && (
              <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-400">
                미지원
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-body text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

/**
 * Confirmation dialog that requires a non-empty 사유(reason) before the
 * destructive/decisive action (승인·반려·중단·폐기 등) can be submitted —
 * CLAUDE.md UI 규칙: "승인·반려·중단·폐기는 확인과 사유를 요구한다."
 * Reused by the review decision flow and the version lifecycle actions.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  reasonLabel = "사유",
  reasonPlaceholder,
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  submitting?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  // Reset the reason field each time the dialog is (re)opened — it's a
  // single persistent instance (never unmounted), so without this a reused
  // dialog would show the previous action's leftover text.
  useEffect(() => {
    if (open) {
      setReason("");
      setTouched(false);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = reason.trim();
  const validationError = touched && trimmed.length === 0 ? "사유를 입력하세요." : undefined;

  function handleConfirm() {
    setTouched(true);
    if (trimmed.length === 0) return;
    onConfirm(trimmed);
  }

  function handleCancel() {
    setReason("");
    setTouched(false);
    onCancel();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl">
        <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
        {description && <div className="mt-1.5 text-body text-text-secondary">{description}</div>}

        <div className="mt-4">
          <FormField label={reasonLabel} required error={validationError}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={reasonPlaceholder}
              rows={3}
              disabled={submitting}
              className={inputClass}
            />
          </FormField>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorBanner message={error} />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel} disabled={submitting}>
            취소
          </Button>
          <Button variant={confirmVariant} onClick={handleConfirm} disabled={submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
