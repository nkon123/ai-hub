"use client";

/**
 * MCP 서버 자산의 새 버전 만들기 — 코드 파일과 매니페스트를 바꿀 수 있다(D-101).
 *
 * 범용 "새 버전 만들기"(`POST /api/v1/assets/{id}/versions`)는 직전 버전의 파일과
 * Manifest 를 그대로 복사하고 버전 번호·Changelog 만 바꾼다. MCP 서버는 새 버전을
 * 만드는 이유가 대개 코드(`server.py`)나 Tool 선언·권한이 바뀌어서라(2026-09-18
 * 실사용: hello-mcp 의 `allowed_roles` 에 USER 를 더해야 했다) 그 경로로는 쓸
 * 수 없었다.
 *
 * 서버는 `POST /api/v1/assets/{assetId}/mcp-server-versions` 하나로 받는다. 라디오가
 * `files_source` 와 1:1 로 대응하고, 무엇을 하는지 제출 전에 문장으로 보여 준다 —
 * "새 코드를 올린 줄 알았는데 이전 코드 그대로였다"가 가장 늦게 드러나는 실수다.
 *
 * 매니페스트는 등록 위저드(`/assets/new/mcp_server`)와 같은 **Manifest JSON** 으로
 * 받는다. 직전 버전 값을 채워 두고, 바꿀 수 없는 `id`·`type`·`server_alias` 는
 * 화면에서도 미리 막는다(서버가 최종 판정한다).
 */

import { useMemo, useState } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, FormField, inputClass } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/** `create_mcp_server_version` 의 `files_source` 와 같은 값이어야 한다. */
type FilesSource = "UPLOAD" | "REUSE_PREVIOUS";

/** 서버 `_MCP_SERVER_IMMUTABLE_FIELDS` 와 같은 목록. */
const IMMUTABLE_FIELDS = ["id", "type", "server_alias"] as const;

export interface McpVersionSummary {
  id: string;
  version: string;
  created_at: string;
  manifest: Record<string, unknown>;
}

function parseSemver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function bumpPatch(version: string): string {
  const p = parseSemver(version);
  return p ? `${p[0]}.${p[1]}.${p[2] + 1}` : "1.0.0";
}

/** 서버가 소스로 삼는 것과 같은 "직전 버전" — 가장 최근에 만들어진 버전. */
function latestCreated(versions: McpVersionSummary[]): McpVersionSummary | null {
  return versions.reduce<McpVersionSummary | null>(
    (latest, v) => (!latest || v.created_at > latest.created_at ? v : latest),
    null
  );
}

function entrypointOf(manifest: Record<string, unknown> | null): { stdio: boolean; entrypoint: string } {
  const transport = manifest?.transport;
  if (!transport || typeof transport !== "object") return { stdio: false, entrypoint: "" };
  const t = transport as Record<string, unknown>;
  const raw = typeof t.entrypoint === "string" ? t.entrypoint : "";
  return { stdio: t.kind === "STDIO", entrypoint: raw.split(/[\\/]/).pop() ?? "" };
}

export function NewMcpServerVersionForm({
  assetId,
  versions,
  onCreated,
  onCancel,
}: {
  assetId: string;
  versions: McpVersionSummary[];
  onCreated: (newVersionId: string) => void;
  onCancel: () => void;
}) {
  const { role } = useRole();

  const source = latestCreated(versions);
  const highest = versions.reduce<string | null>(
    (h, v) => (parseSemver(v.version) && (!h || compareSemver(v.version, h) > 0) ? v.version : h),
    null
  );
  const [version, setVersion] = useState(highest ? bumpPatch(highest) : "1.0.0");
  const [filesSource, setFilesSource] = useState<FilesSource>("UPLOAD");
  const [files, setFiles] = useState<File[]>([]);
  const [manifestText, setManifestText] = useState(() => {
    if (!source) return "";
    // 버전·Changelog 는 폼 값이 이긴다(서버도 그렇게 덮어쓴다) — 매니페스트
    // 안의 옛 값을 보여 주면 어느 쪽이 반영되는지 헷갈린다.
    const { version: _v, changelog: _c, ...rest } = source.manifest as Record<string, unknown>;
    return JSON.stringify(rest, null, 2);
  });
  const [changelog, setChangelog] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionError = (() => {
    if (!version.trim()) return "새 버전을 입력하세요.";
    if (!parseSemver(version)) return "major.minor.patch 형식(예: 1.2.3)으로 입력하세요.";
    if (highest && compareSemver(version, highest) <= 0) return `기존 버전(v${highest})보다 커야 합니다.`;
    return null;
  })();

  const sourceManifest = source?.manifest ?? null;
  const parsedManifest = useMemo((): { value: Record<string, unknown> | null; error: string | null } => {
    try {
      const value = JSON.parse(manifestText);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { value: null, error: "Manifest는 JSON 객체({ ... })여야 합니다." };
      }
      const changed = IMMUTABLE_FIELDS.filter(
        (f) => f in value && sourceManifest && JSON.stringify(value[f]) !== JSON.stringify(sourceManifest[f])
      );
      if (changed.length > 0) {
        return {
          value: null,
          error: `새 버전에서는 ${changed.join(", ")}을(를) 바꿀 수 없습니다. 다른 서버라면 새 자산으로 등록하세요.`,
        };
      }
      return { value, error: null };
    } catch (e) {
      return { value: null, error: `JSON 형식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, [manifestText, sourceManifest]);

  const { stdio, entrypoint } = entrypointOf(parsedManifest.value);
  const filesError =
    filesSource === "UPLOAD" && files.length === 0
      ? "파일을 1개 이상 선택하세요."
      : filesSource === "UPLOAD" && stdio && entrypoint && !files.some((f) => f.name === entrypoint)
        ? `시작 파일 '${entrypoint}'이(가) 선택한 파일에 없습니다.`
        : null;
  const canSubmit = !!source && !versionError && !parsedManifest.error && !filesError && !submitting;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("version", version.trim());
      form.append("files_source", filesSource);
      form.append("manifest", manifestText);
      if (changelog.trim()) form.append("changelog", changelog.trim());
      if (filesSource === "UPLOAD") {
        for (const file of files) form.append("files", file, file.name);
      }
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/mcp-server-versions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const traceId = body?.error?.trace_id;
        const details = body?.error?.details?.errors as string[] | undefined;
        setError(
          `${body?.error?.message ?? `새 버전을 만들지 못했습니다. (HTTP ${res.status})`}${
            details?.length ? ` — ${details.slice(0, 3).join("; ")}` : ""
          }${traceId ? ` (trace_id: ${traceId})` : ""}`
        );
        return;
      }
      const created = await res.json();
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!source) {
    return (
      <Card className="p-5">
        <p className="text-body text-text-secondary">소스로 삼을 버전이 없어 새 버전을 만들 수 없습니다.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-card-title font-semibold text-text-primary">새 버전 만들기 — MCP 서버</h3>
        <p className="mt-1 text-caption text-text-secondary">
          v{source.version}을(를) 바탕으로 초안(DRAFT)을 만듭니다. 코드 파일과 매니페스트(Tool 선언·권한 등)를
          바꿀 수 있고, 기존 버전은 그대로 남습니다.
        </p>
      </div>

      <FormField label="새 버전 (SemVer)" required error={versionError ?? undefined}>
        <input
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder={highest ? bumpPatch(highest) : "1.0.0"}
          disabled={submitting}
          className={inputClass}
        />
        {highest && <p className="mt-1 text-caption text-text-muted">현재 최신 버전은 v{highest}입니다.</p>}
      </FormField>

      <FormField label="코드 파일" required>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-body text-text-primary">
            <input
              type="radio"
              name="mcp-files-source"
              checked={filesSource === "UPLOAD"}
              onChange={() => setFilesSource("UPLOAD")}
              disabled={submitting}
              className="mt-1"
            />
            <span>
              <span className="font-medium">새 파일을 올립니다</span>
              <span className="block text-caption text-text-secondary">
                코드가 바뀌었을 때. 올린 파일만 새 버전에 들어갑니다(이전 파일은 합치지 않습니다).
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-body text-text-primary">
            <input
              type="radio"
              name="mcp-files-source"
              checked={filesSource === "REUSE_PREVIOUS"}
              onChange={() => {
                setFilesSource("REUSE_PREVIOUS");
                setFiles([]);
              }}
              disabled={submitting}
              className="mt-1"
            />
            <span>
              <span className="font-medium">기존 파일을 그대로 씁니다</span>
              <span className="block text-caption text-text-secondary">
                코드는 그대로 두고 매니페스트(권한·Tool 설명 등)만 바꿀 때.
              </span>
            </span>
          </label>
        </div>
      </FormField>

      {filesSource === "UPLOAD" && (
        <FormField label="파일" required error={filesError ?? undefined}>
          <input
            type="file"
            multiple
            disabled={submitting}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className={inputClass}
          />
          {stdio && entrypoint && (
            <p className="mt-1 text-caption text-text-muted">
              시작 파일 <code className="rounded bg-slate-100 px-1">{entrypoint}</code>이(가) 반드시 포함되어야 합니다.
            </p>
          )}
          {files.length > 0 && (
            <p className="mt-1 text-caption text-text-secondary">
              {files.length}개 선택됨: {files.map((f) => f.name).join(", ")}
            </p>
          )}
        </FormField>
      )}

      <FormField label="매니페스트 (JSON)" required error={parsedManifest.error ?? undefined}>
        <textarea
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
          rows={16}
          spellCheck={false}
          disabled={submitting}
          className={`${inputClass} font-mono text-xs`}
        />
        <p className="mt-1 text-caption text-text-muted">
          v{source.version}의 매니페스트를 채워 두었습니다. <code>id</code>·<code>type</code>·
          <code>server_alias</code>는 바꿀 수 없고, 버전과 Changelog는 이 폼의 값이 적용됩니다.
        </p>
      </FormField>

      <FormField label="변경 내용 (Changelog)">
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          rows={2}
          placeholder={filesSource === "UPLOAD" ? "예: 시각 형식을 ISO 8601로 변경" : "예: USER 역할도 호출 허용"}
          disabled={submitting}
          className={inputClass}
        />
      </FormField>

      <div className="rounded-lg border border-border bg-slate-50 px-4 py-3 text-caption text-text-secondary">
        {filesSource === "UPLOAD" ? (
          <>
            <Upload size={13} className="mr-1 inline" />
            선택한 파일 {files.length}개와 위 매니페스트로 v{version || "?"}를 만듭니다.
          </>
        ) : (
          <>
            <RefreshCw size={13} className="mr-1 inline" />
            v{source.version}의 파일을 그대로 쓰고 위 매니페스트로 v{version || "?"}를 만듭니다.
          </>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
          취소
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting && <Loader2 size={14} className="animate-spin" />}
          새 버전 만들기
        </Button>
      </div>
    </Card>
  );
}
