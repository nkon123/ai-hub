"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Lock, ShieldOff } from "lucide-react";
import { ErrorBanner, LoadingState } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import type { AgentOption } from "./constants";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/**
 * MCP Tool 연결 — always produces an empty `mcp_bindings: []`.
 *
 * `mcp_bindings[].tool_id` in service-definition.schema.json is `format: uuid`,
 * but the only MCP Tool assets that actually exist at runtime
 * (office-mcp-server's `db_metadata.get_tables` / `get_columns` /
 * `table_count.query`) are looked up by *name*, not id, and — per D-034 —
 * are not registered in the Portal asset Registry at all
 * (`GET /api/v1/assets?type=mcp_tool` returns `{items: [], total: 0}`, verified
 * live). There is exactly one MCP Tool manifest with a real UUID in this repo
 * (`fixtures/valid/mcp-readonly-oracle/mcp-tool-manifest.json`,
 * `550e8400-e29b-41d4-a716-446655440030`), but it is a fixture, not something
 * `POST /api/v1/assets` ever created — binding to it would silently point the
 * Service Definition at an asset version that cannot be resolved by the
 * publish-gate validator. Rather than hardcode that (or any other) fake
 * UUID to make the form "work", this step stays permanently informational:
 * it queries the real Registry live and explains exactly why 0 results means
 * 0 bindings are offered.
 */
export function StepMcp({ agent }: { agent: AgentOption }) {
  const { role } = useRole();
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=mcp_tool`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setCount((data.items ?? []).length);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [role.token]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">MCP Tool 연결</h2>
        <p className="text-body text-text-secondary">
          PoC는 읽기 전용(READ_ONLY) Tool만 연결을 허용합니다. 이 단계는 등록된 MCP Tool 자산이 있을 때만
          선택지를 제공합니다.
        </p>
      </div>

      {!agent.mcpAllowed && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-slate-50 px-4 py-3 text-body text-text-secondary">
          <ShieldOff size={16} className="mt-0.5 shrink-0 text-text-muted" />
          <span>
            선택한 Agent(<strong>{agent.name}</strong>)는 MCP Tool을 호출하지 않습니다 (
            <code className="rounded bg-white px-1 py-0.5 text-caption">capabilities.mcp_allowed = false</code>).
            이 단계는 비활성화되어 있으며 <code>mcp_bindings</code>는 빈 배열로 저장됩니다.
          </span>
        </div>
      )}

      {agent.mcpAllowed && (
        <>
          {loading && <LoadingState label="등록된 MCP Tool 자산을 확인하는 중..." />}
          {error && <ErrorBanner message={`MCP Tool 자산 목록을 불러오지 못했습니다: ${error}`} />}
          {!loading && !error && count === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
              <Lock size={16} className="mt-0.5 shrink-0" />
              <div className="space-y-1.5">
                <p>
                  선택한 Agent(<strong>{agent.name}</strong>)는 MCP Tool 호출을 지원하지만, 등록된 MCP Tool
                  자산이 없어 연결할 수 없습니다.
                </p>
                <p className="text-caption">
                  office-mcp-server(:8500)에는 읽기 전용 Tool(<code>db_metadata.get_tables</code>,{" "}
                  <code>db_metadata.get_columns</code>, <code>table_count.query</code>)이 이미 존재하지만,
                  Portal 자산 Registry에는 아직 등록되지 않았습니다 (open-decisions.md D-034). 임의 UUID를
                  만들어 연결하면 게시 구성 검증이 해석할 수 없는 참조가 되므로, MCP Tool 자산이 실제로
                  등록될 때까지 이 단계는 비워둡니다.
                </p>
              </div>
            </div>
          )}
          {!loading && !error && count !== null && count > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                등록된 MCP Tool 자산 {count}건이 발견되었지만, 이 마법사 버전은 MCP Tool 선택 UI를 아직
                구현하지 않았습니다. 연결 없이 계속 진행하거나 다음 릴리스를 기다려 주세요.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
