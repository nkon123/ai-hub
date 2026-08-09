"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, XCircle } from "lucide-react";
import { Button, ErrorBanner } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import type { ServiceVersionOut, ValidationResult } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// SERVICE_CREATE permission holders (security_policy.roles.ROLE_PERMISSIONS).
const SERVICE_CREATE_ROLES = new Set(["CREATOR", "ADMIN"]);

export interface Draft {
  serviceVersionId: string;
  serviceId: string;
  status: string;
  definitionSnapshot: string;
  serviceDefinition: Record<string, unknown>;
}

interface GeneralError {
  message: string;
  traceId?: string;
  kind: "error" | "permission";
  schemaErrors?: string[];
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function StepValidate({
  serviceName,
  definition,
  draft,
  validation,
  onDraftChange,
  onValidationChange,
}: {
  serviceName: string;
  definition: Record<string, unknown>;
  draft: Draft | null;
  validation: ValidationResult | null;
  onDraftChange: (draft: Draft) => void;
  onValidationChange: (result: ValidationResult | null) => void;
}) {
  const { role } = useRole();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<GeneralError | null>(null);

  const currentJson = JSON.stringify(definition);
  const isStale = draft !== null && draft.definitionSnapshot !== currentJson;
  const canCreate = SERVICE_CREATE_ROLES.has(role.code);

  async function runValidate() {
    if (!canCreate) return;
    setRunning(true);
    setError(null);
    onValidationChange(null);

    try {
      let activeDraft = draft;
      if (!activeDraft || isStale) {
        const res = await fetch(`${API_BASE}/api/v1/services`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
          body: JSON.stringify({ name: serviceName, service_definition: definition }),
        });
        if (!res.ok) {
          const body = await safeJson(res);
          setError({
            message: body?.error?.message ?? `Service 초안 생성에 실패했습니다. (HTTP ${res.status})`,
            traceId: body?.error?.trace_id,
            kind: res.status === 403 ? "permission" : "error",
            schemaErrors: body?.error?.details?.errors,
          });
          setRunning(false);
          return;
        }
        const data: ServiceVersionOut = await res.json();
        activeDraft = {
          serviceVersionId: data.id,
          serviceId: data.service_id,
          status: data.status,
          definitionSnapshot: currentJson,
          serviceDefinition: data.service_definition,
        };
        onDraftChange(activeDraft);
      }

      const validateRes = await fetch(
        `${API_BASE}/api/v1/service-versions/${activeDraft.serviceVersionId}/validate`,
        { method: "POST", headers: { Authorization: `Bearer ${role.token}` } }
      );
      if (!validateRes.ok) {
        const body = await safeJson(validateRes);
        setError({
          message: body?.error?.message ?? `구성 검증에 실패했습니다. (HTTP ${validateRes.status})`,
          traceId: body?.error?.trace_id,
          kind: "error",
        });
        setRunning(false);
        return;
      }
      const result: ValidationResult = await validateRes.json();
      onValidationChange(result);
    } catch {
      setError({ message: "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.", kind: "error" });
    } finally {
      setRunning(false);
    }
  }

  const passedCount = validation?.checks.filter((c) => c.passed).length ?? 0;
  const failedCount = validation?.checks.filter((c) => !c.passed).length ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">구성 검증</h2>
        <p className="text-body text-text-secondary">
          실제 <code>POST /api/v1/services</code>로 초안을 저장하고{" "}
          <code>POST /api/v1/service-versions/&#123;id&#125;/validate</code>로 Schema·Knowledge 참조·인덱싱·모델
          정책을 검증합니다.
        </p>
      </div>

      {draft && (
        <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
          Service Version ID: <span className="font-mono text-text-primary">{draft.serviceVersionId}</span> · 상태:{" "}
          {draft.status}
          {isStale && (
            <span className="ml-2 text-warning">
              — 이전 단계 입력이 변경되어 이 초안은 최신 상태가 아닙니다. 다시 검증하면 새 초안이 저장됩니다.
            </span>
          )}
        </div>
      )}

      {!canCreate && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
          <Lock size={15} className="mt-0.5 shrink-0" />
          <span>
            Service 초안을 생성하려면 자산 제작자(CREATOR) 또는 관리자 역할이 필요합니다. 현재 역할:{" "}
            {role.label}.
          </span>
        </div>
      )}

      {error &&
        (error.kind === "permission" ? (
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
            {error.message}
            {error.traceId && <p className="mt-1 text-caption text-warning">Trace ID: {error.traceId}</p>}
          </div>
        ) : (
          <div className="space-y-1">
            <ErrorBanner message={error.message} />
            {error.schemaErrors && error.schemaErrors.length > 0 && (
              <ul className="ml-4 list-disc text-caption text-danger">
                {error.schemaErrors.map((e, idx) => (
                  <li key={idx}>{e}</li>
                ))}
              </ul>
            )}
            {error.traceId && <p className="text-caption text-text-muted">Trace ID: {error.traceId}</p>}
          </div>
        ))}

      <Button onClick={runValidate} disabled={running || !canCreate}>
        {running ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            검증 실행 중...
          </>
        ) : draft && !isStale ? (
          "다시 검증"
        ) : (
          "초안 저장 및 검증 실행"
        )}
      </Button>

      {validation && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-body font-semibold ${
                validation.passed ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
              }`}
            >
              {validation.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {validation.passed ? "검증 통과" : "검증 실패"}
            </span>
            <span className="text-caption text-text-muted">
              통과 {passedCount} · 실패 {failedCount}
            </span>
          </div>

          <div className="space-y-2">
            {validation.checks.map((check) => (
              <div
                key={check.name}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-body ${
                  check.passed ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"
                }`}
              >
                {check.passed ? (
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
                )}
                <div>
                  <div className="font-medium text-text-primary">{check.name}</div>
                  <div className={check.passed ? "text-text-secondary" : "text-danger"}>{check.message}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
