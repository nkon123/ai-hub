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
//
// D-084 후속 3 (2026-08-17, "최초 한번만 승인") — `approval` adds a SEPARATE,
// independently revocable execution approval on top of `riskAcknowledgedAt`.
// The two are not interchangeable: `riskAcknowledgedAt` is the one-time "I
// understand this is unsandboxed" acknowledgement made when the tool is
// added, and it is never null once a tool exists. `approval` is "you may
// skip the per-run native dialog for THIS tool" — it starts `null` (never
// asked) for every tool, including ones added before this field existed
// (`read()` below normalizes missing/legacy records to `approval: null`, so
// no pre-existing tool is silently treated as pre-approved).
// `approval.approvedFileHash` binds the approval to the exact file CONTENT
// at approval time, not to the path — `electron/main.ts`'s `localTool:invoke`
// handler re-reads the file and recomputes the hash on every single
// invocation and refuses to skip the dialog unless the hashes still match.
// Binding to the path alone would turn "approved once" into "anything ever
// placed at that path runs forever," which is not what was approved.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LocalTool, LocalToolApproval, LocalToolDiscardedInfo, LocalToolParameterInfo } from "./types";

/** sha256 of already-read file content, hex-encoded. Pure hashing step
 * shared by the approve-time and invoke-time recomputation so both sides can
 * never drift in how the hash is derived. Callers own the (fallible) file
 * read — this function never touches the filesystem itself. */
export function hashLocalToolSource(source: string): string {
  return crypto.createHash("sha256").update(source, "utf-8").digest("hex");
}

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
      // Legacy records written before `approval` existed lack the field —
      // normalize to `null` (never pre-approved) rather than leaving it
      // `undefined`, so every call site can rely on the field always being
      // present and can never mistake "field missing" for "approved".
      const tools = (parsed.tools as LocalTool[]).map((tool) => ({
        ...tool,
        approval: tool.approval ?? null,
      }));
      return { tools };
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
      approval: null,
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

  /** Records "skip the per-run dialog for this exact file content" — called
   * only from the 자산 > 로컬 Tool screen's explicit "실행 허용" action
   * (`electron/main.ts`'s `localTool:approveExecution` handler), never from
   * the per-run execution dialog (Task Brief 제약: 그 대화상자의 승인은
   * 영구 승인으로 승격되지 않는다). `fileHash` must be recomputed by the
   * caller from a fresh read of `tool.filePath` immediately before calling
   * this — this method does not read the filesystem itself and trusts the
   * hash it's given, so callers are responsible for that freshness. */
  approve(id: string, fileHash: string): AddLocalToolResult {
    const current = this.read();
    const idx = current.tools.findIndex((tool) => tool.id === id);
    if (idx === -1) {
      return { ok: false, error: "로컬 Tool을 찾을 수 없습니다." };
    }
    const approval: LocalToolApproval = { approvedAt: new Date().toISOString(), approvedFileHash: fileHash };
    const nextTools = [...current.tools];
    nextTools[idx] = { ...nextTools[idx], approval };
    this.write({ tools: nextTools });
    return { ok: true, tool: nextTools[idx] };
  }

  /** Withdraws a standing execution approval — the same 로컬 Tool 화면 must
   * offer this next to "실행 허용" (Task Brief 제약: 되돌릴 수 없는 승인을
   * 만들지 않는다). After this, `localTool:invoke` falls back to asking via
   * the native dialog on every run again, exactly like a tool that was
   * never approved. */
  revoke(id: string): AddLocalToolResult {
    const current = this.read();
    const idx = current.tools.findIndex((tool) => tool.id === id);
    if (idx === -1) {
      return { ok: false, error: "로컬 Tool을 찾을 수 없습니다." };
    }
    const nextTools = [...current.tools];
    nextTools[idx] = { ...nextTools[idx], approval: null };
    this.write({ tools: nextTools });
    return { ok: true, tool: nextTools[idx] };
  }
}
