// D-084 "Desktop 로컬 Tool" — persisted store, main-process only (fs
// access). Same lifecycle pattern as `DesktopSettingsStore`/
// `InstalledAssetsStore`: single JSON file under `stateDir`, constructor
// creates the directory if missing.
//
// Deliberately a SEPARATE store file from `InstalledAssetsStore` (Hub 자산)
// — see this module's isolation test
// (`electron/__tests__/local-tool-isolation.test.ts`) for why that
// separation is load-bearing, not stylistic: a local tool must never be
// reachable through the same list agent-runtime's KNOWLEDGE_ROUTE/D-080
// MCP Tool registration walks.
//
// `riskAcknowledgedAt` is enforced structurally, not just by a UI checkbox
// that a future call site could forget to render: `add()` requires
// `acknowledgedRisk: true` and refuses (no write happens) otherwise. This is
// the mechanism, not a UI convention, behind Task Brief 구현 원칙 7's
// "승인된" (approved) side — see `docs/implementation-spec/open-decisions.md`
// D-084 for the full boundary writeup.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LocalTool, LocalToolDiscardedInfo, LocalToolParameterInfo } from "./types";

interface LocalToolFile {
  tools: LocalTool[];
}

const EMPTY_FILE: LocalToolFile = { tools: [] };

export interface AddLocalToolInput {
  filePath: string;
  functionName: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  parameters: LocalToolParameterInfo[];
  discarded: LocalToolDiscardedInfo;
  warnings: string[];
}

export type AddLocalToolResult = { ok: true; tool: LocalTool } | { ok: false; error: string };

export class LocalToolStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "local-tools.json");
  }

  private read(): LocalToolFile {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY_FILE, tools: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed?.tools)) return { tools: [] };
      return { tools: parsed.tools as LocalTool[] };
    } catch {
      // 손상된 파일은 "로컬 Tool 없음"으로 취급한다 — Desktop은 장애 시
      // 종료되지 않는다(CLAUDE.md).
      return { tools: [] };
    }
  }

  private write(next: LocalToolFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
  }

  list(): LocalTool[] {
    return this.read().tools;
  }

  find(id: string): LocalTool | null {
    return this.read().tools.find((tool) => tool.id === id) ?? null;
  }

  /** Refuses (no write) unless `acknowledgedRisk === true` — the not-a-
   * sandbox acknowledgement is enforced here, not only by the renderer's
   * checkbox (Task Brief hard requirement 2/3). `id` is always
   * `crypto.randomUUID()` — never derived from the file name or tool name
   * (Task Brief hard requirement 4: never build identity from a
   * user-supplied name). */
  add(input: AddLocalToolInput, acknowledgedRisk: boolean): AddLocalToolResult {
    if (acknowledgedRisk !== true) {
      return { ok: false, error: "이 Tool이 격리되지 않은 상태로 실행된다는 점을 확인해야 추가할 수 있습니다." };
    }
    const now = new Date().toISOString();
    const tool: LocalTool = {
      id: crypto.randomUUID(),
      filePath: input.filePath,
      functionName: input.functionName,
      toolName: input.toolName,
      inputSchema: input.inputSchema,
      parameters: input.parameters,
      discarded: input.discarded,
      warnings: input.warnings,
      addedAt: now,
      riskAcknowledgedAt: now,
    };
    const current = this.read();
    this.write({ tools: [...current.tools, tool] });
    return { ok: true, tool };
  }

  remove(id: string): { ok: boolean; error: string | null } {
    const current = this.read();
    if (!current.tools.some((tool) => tool.id === id)) {
      return { ok: false, error: "로컬 Tool을 찾을 수 없습니다." };
    }
    this.write({ tools: current.tools.filter((tool) => tool.id !== id) });
    return { ok: true, error: null };
  }
}
