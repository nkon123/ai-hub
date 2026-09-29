// D-107 "MCP 서버 추가" — pure logic for the add dialog
// (LocalMcpServerAddPanel.tsx). The renderer cannot import
// electron/local-mcp-servers.ts (it uses node:fs), so the alias pattern is
// repeated here; `localMcpServerTypes.test.ts` pins it to the main-process copy.

import type { LocalMcpToolChoice, LocalMcpToolDraft } from "../../electron/types";

export type AddServerKind = "STDIO" | "HTTP";

export interface AddServerForm {
  kind: AddServerKind;
  alias: string;
  entryFile: string;
  endpoint: string;
}

/** mcp-server-manifest.schema.json `server_alias`. */
export const SERVER_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function validateAddForm(form: AddServerForm): string | null {
  if (!SERVER_ALIAS_PATTERN.test(form.alias)) {
    return "이름은 영문 소문자로 시작하고 영문 소문자·숫자·하이픈(-)만 쓸 수 있습니다(2~64자).";
  }
  if (form.kind === "STDIO") {
    if (!form.entryFile) return "서버 파일(.py)을 고르세요.";
    if (!form.entryFile.toLowerCase().endsWith(".py")) return "Python 서버 파일(.py)만 추가할 수 있습니다.";
    return null;
  }
  if (!/^https?:\/\/\S+$/i.test(form.endpoint.trim())) return "http:// 또는 https:// 로 시작하는 주소를 넣으세요.";
  return null;
}

/** A starting name from the picked file or the address, in alias form. */
export function suggestAlias(source: string): string {
  const base = source
    .replace(/^https?:\/\//i, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .reduce((last, part, i, all) => (/^server(\.py)?$/i.test(part) && i > 0 ? all[i - 1] : part), "")
    .replace(/\.py$/i, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return SERVER_ALIAS_PATTERN.test(slug) ? slug : "my-mcp-server";
}

export function riskLabel(draft: LocalMcpToolDraft): string {
  return draft.riskLevel === "WRITE" ? "변경 가능" : "읽기";
}

export function confirmNote(draft: LocalMcpToolDraft): string | null {
  if (draft.confirmLocked) return "변경할 수 있는 도구라 항상 실행 전에 확인합니다. 이 도구는 AI가 스스로 고르지 않습니다.";
  if (!draft.registrable) return "도구 이름 형식이 맞지 않아 추가할 수 없습니다.";
  return null;
}

export function toggleChoice(
  choices: LocalMcpToolChoice[],
  toolName: string,
  field: "enabled" | "confirm",
  drafts: LocalMcpToolDraft[],
): LocalMcpToolChoice[] {
  const draft = drafts.find((d) => d.toolName === toolName);
  if (!draft || !draft.registrable) return choices;
  if (field === "confirm" && draft.confirmLocked) return choices;
  return choices.map((c) => (c.toolName === toolName ? { ...c, [field]: !c[field] } : c));
}

export function enabledCount(choices: LocalMcpToolChoice[]): number {
  return choices.filter((c) => c.enabled).length;
}
