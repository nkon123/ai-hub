"use client";

import { FormField, inputClass } from "../../../_components/ui";
import { OFFICE_PROFILE_ORG, OFFICE_PROFILE_SITES, TARGET_USER_ROLES } from "./constants";
import { AUDIT_LEVEL_LABEL } from "./types";
import type { AuditLevel, LimitsDraft, TargetUsersDraft } from "./types";

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function StepLimits({
  limits,
  onLimitsChange,
  targetUsers,
  onTargetUsersChange,
  agentMaxMcpCalls,
}: {
  limits: LimitsDraft;
  onLimitsChange: (next: LimitsDraft) => void;
  targetUsers: TargetUsersDraft;
  onTargetUsersChange: (next: TargetUsersDraft) => void;
  agentMaxMcpCalls: number;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">제한·보안</h2>
        <p className="text-body text-text-secondary">
          사용자는 조직 정책보다 값을 완화할 수 없습니다. 이 PoC는 별도 정책 서버가 없어 Agent의 선언 값을
          상한으로 사용합니다.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="전체 실행 Timeout (초)" required>
          <input
            type="number"
            min={1}
            value={limits.timeoutSeconds}
            onChange={(e) => onLimitsChange({ ...limits, timeoutSeconds: Number(e.target.value) })}
            className={inputClass}
          />
        </FormField>

        <FormField label="최대 MCP Tool 호출 수">
          <input
            type="number"
            min={0}
            max={agentMaxMcpCalls}
            value={limits.maxMcpCalls}
            onChange={(e) =>
              onLimitsChange({ ...limits, maxMcpCalls: Math.min(Number(e.target.value), agentMaxMcpCalls) })
            }
            className={inputClass}
          />
          <p className="mt-1 text-caption text-text-muted">Agent 상한: {agentMaxMcpCalls}회 (MCP Tool 미연결 시 실제 호출은 0회)</p>
        </FormField>

        <FormField label="최대 Context Token">
          <input
            type="number"
            min={0}
            value={limits.maxContextTokens}
            onChange={(e) => onLimitsChange({ ...limits, maxContextTokens: Number(e.target.value) })}
            className={inputClass}
          />
        </FormField>

        <FormField label="최대 입력 크기 (bytes)">
          <input
            type="number"
            min={0}
            value={limits.maxInputBytes}
            onChange={(e) => onLimitsChange({ ...limits, maxInputBytes: Number(e.target.value) })}
            className={inputClass}
          />
        </FormField>
      </div>

      <FormField label="Audit Level">
        <select
          value={limits.auditLevel}
          onChange={(e) => onLimitsChange({ ...limits, auditLevel: e.target.value as AuditLevel })}
          className={`${inputClass} w-auto`}
        >
          {(Object.keys(AUDIT_LEVEL_LABEL) as AuditLevel[]).map((level) => (
            <option key={level} value={level}>
              {AUDIT_LEVEL_LABEL[level]}
            </option>
          ))}
        </select>
      </FormField>

      <div className="border-t border-border pt-5">
        <h3 className="mb-1 text-card-title font-semibold text-text-primary">대상 사용자 범위 (선택)</h3>
        <p className="mb-3 text-body text-text-secondary">
          비워두면 Service Definition에 <code>target_users</code>가 포함되지 않습니다 (제한 없음으로 해석되지
          않도록 게시 시 별도 검토가 필요합니다).
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="대상 조직">
            <label className="flex items-center gap-2 text-body text-text-secondary">
              <input
                type="checkbox"
                checked={targetUsers.orgs.includes(OFFICE_PROFILE_ORG)}
                onChange={() => onTargetUsersChange({ ...targetUsers, orgs: toggleValue(targetUsers.orgs, OFFICE_PROFILE_ORG) })}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              {OFFICE_PROFILE_ORG}
            </label>
          </FormField>

          <FormField label="대상 사업장">
            <div className="space-y-1.5">
              {OFFICE_PROFILE_SITES.map((site) => (
                <label key={site} className="flex items-center gap-2 text-body text-text-secondary">
                  <input
                    type="checkbox"
                    checked={targetUsers.sites.includes(site)}
                    onChange={() => onTargetUsersChange({ ...targetUsers, sites: toggleValue(targetUsers.sites, site) })}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  {site}
                </label>
              ))}
            </div>
          </FormField>

          <FormField label="대상 역할">
            <div className="space-y-1.5">
              {TARGET_USER_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-body text-text-secondary">
                  <input
                    type="checkbox"
                    checked={targetUsers.roles.includes(r)}
                    onChange={() => onTargetUsersChange({ ...targetUsers, roles: toggleValue(targetUsers.roles, r) })}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  {r}
                </label>
              ))}
            </div>
          </FormField>
        </div>
      </div>
    </div>
  );
}
