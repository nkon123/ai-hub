"use client";

import { ROLES, useRole, type RoleCode } from "./role-context";

/** Compact 개발/데모 용 역할 전환 control rendered in the top nav. */
export function RoleSwitcher() {
  const { role, setRoleCode } = useRole();

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-caption text-text-muted sm:inline">개발용 역할</span>
      <select
        value={role.code}
        onChange={(e) => setRoleCode(e.target.value as RoleCode)}
        title="개발/데모 용 역할 전환입니다. 실제 배포에서는 사내 SSO 로그인으로 역할이 결정됩니다."
        className="rounded-md border border-border bg-white px-2 py-1.5 text-caption font-medium text-text-primary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      >
        {ROLES.map((r) => (
          <option key={r.code} value={r.code}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
