// D-107 "MCP 서버 추가" — the user points at a local Python file or an HTTP
// address, Desktop connects once to read the tools, the user picks tools and
// per-tool confirmation, then Desktop registers it. No Portal approval.
// All decisions live in `localMcpServerTypes.ts` (tested); this file renders.

import React, { useState } from "react";
import type { LocalMcpToolChoice, PrepareLocalMcpServerResult } from "../../electron/types";
import { getDesktopBridge } from "../bridge";
import { Button, ErrorBanner, LabeledInput, Modal } from "../ui";
import {
  confirmNote,
  enabledCount,
  riskLabel,
  suggestAlias,
  toggleChoice,
  validateAddForm,
  type AddServerForm,
} from "./localMcpServerTypes";

type Prepared = Extract<PrepareLocalMcpServerResult, { ok: true }>;

export function LocalMcpServerAddPanel({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (alias: string) => void }) {
  const [form, setForm] = useState<AddServerForm>({ kind: "STDIO", alias: "", entryFile: "", endpoint: "" });
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [choices, setChoices] = useState<LocalMcpToolChoice[]>([]);
  const [busy, setBusy] = useState<"probing" | "adding" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null only outside Electron with no preview bridge; the screen hides the button then.
  const bridge = getDesktopBridge();

  function reset() {
    setForm({ kind: "STDIO", alias: "", entryFile: "", endpoint: "" });
    setPrepared(null);
    setChoices([]);
    setBusy(null);
    setError(null);
  }

  function close() {
    if (prepared) void bridge?.cancelLocalMcpServer(prepared.draftId);
    reset();
    onClose();
  }

  function update(patch: Partial<AddServerForm>) {
    // Changing what to connect to invalidates an earlier probe.
    if (prepared) {
      void bridge?.cancelLocalMcpServer(prepared.draftId);
      setPrepared(null);
      setChoices([]);
    }
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  async function pickFile() {
    if (!bridge) return;
    const file = await bridge.pickLocalMcpServerFile();
    if (file) update({ entryFile: file, alias: form.alias || suggestAlias(file) });
  }

  async function probe() {
    const invalid = validateAddForm(form);
    if (!bridge) return;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy("probing");
    setError(null);
    const input =
      form.kind === "STDIO"
        ? { kind: "STDIO" as const, alias: form.alias, entryFile: form.entryFile }
        : { kind: "HTTP" as const, alias: form.alias, endpoint: form.endpoint.trim() };
    const result = await bridge.prepareLocalMcpServer(input);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPrepared(result);
    setChoices(result.choices);
  }

  async function add() {
    if (!prepared || !bridge) return;
    setBusy("adding");
    setError(null);
    const result = await bridge.addLocalMcpServer(prepared.draftId, choices);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    reset();
    onAdded(result.alias);
  }

  return (
    <Modal open={open} title="MCP 서버 추가" onClose={close}>
      <div className="space-y-4">
        <p className="text-caption text-text-secondary">
          허브 승인을 거치지 않고 이 PC에서 바로 연결합니다. 직접 고른 코드가 이 PC에서 실행되니 믿을 수 있는 서버만 추가하세요.
        </p>

        <div className="flex gap-2" role="radiogroup" aria-label="서버 종류">
          {(["STDIO", "HTTP"] as const).map((kind) => (
            <Button key={kind} variant={form.kind === kind ? "primary" : "secondary"} onClick={() => update({ kind })} disabled={busy !== null}>
              {kind === "STDIO" ? "로컬 Python 파일" : "HTTP 주소"}
            </Button>
          ))}
        </div>

        {form.kind === "STDIO" ? (
          <div>
            <div className="mb-1 text-caption font-semibold text-text-muted">서버 파일</div>
            <div className="flex items-center gap-2">
              <div className="h-10 min-w-0 flex-1 truncate rounded-lg border border-border px-3 py-2 text-sm text-text-primary" title={form.entryFile}>
                {form.entryFile || "선택한 파일 없음"}
              </div>
              <Button variant="secondary" onClick={() => void pickFile()} disabled={busy !== null}>
                파일 선택
              </Button>
            </div>
            <p className="mt-1 text-caption text-text-muted">파일이 있는 폴더를 통째로 복사해 실행합니다(.venv·캐시 제외, 최대 50MB). 원본을 고치면 삭제 후 다시 추가하세요.</p>
          </div>
        ) : (
          <LabeledInput
            id="local-mcp-endpoint"
            label="서버 주소"
            value={form.endpoint}
            onChange={(endpoint) => update({ endpoint, alias: form.alias || suggestAlias(endpoint) })}
            placeholder="http://127.0.0.1:8000/mcp"
            disabled={busy !== null}
          />
        )}

        <LabeledInput id="local-mcp-alias" label="이름 (영문 소문자·숫자·-)" value={form.alias} onChange={(alias) => update({ alias })} placeholder="my-mcp-server" disabled={busy !== null} />

        {error && <ErrorBanner message={error} />}

        {!prepared ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={busy !== null}>
              취소
            </Button>
            <Button onClick={() => void probe()} disabled={busy !== null}>
              {busy === "probing" ? "연결 시험 중..." : "연결 시험"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {prepared.warnings.map((w) => (
              <div key={w} className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning">
                {w}
              </div>
            ))}
            <div className="text-caption font-semibold text-text-muted">
              발견된 도구 {prepared.tools.length}개{prepared.serverName ? ` · ${prepared.serverName}` : ""}
            </div>
            <div className="divide-y divide-border rounded-lg border border-border">
              {prepared.tools.map((draft) => {
                const choice = choices.find((c) => c.toolName === draft.toolName)!;
                const note = confirmNote(draft);
                return (
                  <div key={draft.toolName} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex min-w-0 flex-1 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={choice.enabled}
                          disabled={!draft.registrable || busy !== null}
                          onChange={() => setChoices((c) => toggleChoice(c, draft.toolName, "enabled", prepared.tools))}
                        />
                        <span className="truncate font-medium text-text-primary">{draft.toolName}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-text-secondary">{riskLabel(draft)}</span>
                      </label>
                      <label className="flex items-center gap-1 text-caption">
                        <input
                          type="checkbox"
                          checked={draft.confirmLocked || choice.confirm}
                          disabled={draft.confirmLocked || !choice.enabled || busy !== null}
                          onChange={() => setChoices((c) => toggleChoice(c, draft.toolName, "confirm", prepared.tools))}
                        />
                        매번 확인
                      </label>
                    </div>
                    {draft.description && <p className="mt-1 text-caption text-text-secondary">{draft.description}</p>}
                    {note && <p className="mt-1 text-caption text-text-muted">{note}</p>}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close} disabled={busy !== null}>
                취소
              </Button>
              <Button onClick={() => void add()} disabled={busy !== null || enabledCount(choices) === 0}>
                {busy === "adding" ? "추가 중..." : `도구 ${enabledCount(choices)}개로 추가`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
