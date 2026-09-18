"use client";

/**
 * 지식 자산의 새 버전 만들기 — 문서 교체 또는 색인 전략 변경(재색인).
 *
 * 이 화면 이전에는 재색인 경로가 UI에 아예 없었다: `/knowledge/new` 는 매번
 * 새 자산을 만들고(새 uuid, v1.0.0 고정), `/assets/{id}/versions` 의 "새 버전
 * 만들기" 는 파일과 Manifest 를 복사만 해 색인을 걸지 않는다. 그래서 문서를
 * 갱신하거나 청킹 전략을 바꾸려면 자산을 통째로 다시 등록하는 수밖에 없었고,
 * 그러면 같은 지식이 서로 다른 자산 id 로 둘이 된다.
 *
 * 서버는 `POST /api/v1/assets/{assetId}/knowledge-versions` 하나로 두 경우를
 * 받는다(`documents_source`). 이 폼의 라디오가 그 값과 1:1로 대응하며, 두 경우
 * 중 무엇을 하는지 제출 전에 문장으로 보여 준다 — "새 문서를 올린 줄 알았는데
 * 전략만 바뀌어 있었다"가 가장 늦게 드러나는 실수라서다.
 */

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, FormField, inputClass } from "../../../_components/ui";
import {
  INDEXING_PRESETS,
  RETRIEVAL_PRESETS,
  indexingStrategyOf,
  retrievalStrategyOf,
  type IndexingStrategyKey,
  type RetrievalStrategyKey,
} from "../../../_components/knowledge-profiles";
import { useRole } from "../../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/** `create_knowledge_version` 의 `documents_source` 와 같은 값이어야 한다. */
type DocumentsSource = "UPLOAD" | "REUSE_PREVIOUS";

/** 현재 설정을 그대로 두는 선택. 빈 문자열이면 해당 필드를 아예 보내지 않고,
 *  서버가 직전 버전 값을 유지한다. */
const KEEP = "";

export interface VersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** 서버가 요구하는 것과 같은 규칙: 기존 **모든** 버전보다 커야 한다. */
function highestVersion(versions: VersionSummary[]): string | null {
  const parseable = versions.map((v) => v.version).filter((v) => parseSemver(v) !== null);
  if (parseable.length === 0) return null;
  return parseable.sort(compareSemver)[parseable.length - 1];
}

function bumpPatch(version: string): string {
  const parsed = parseSemver(version);
  if (!parsed) return "";
  return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
}

export function NewKnowledgeVersionForm({
  assetId,
  versions,
  onCreated,
  onCancel,
}: {
  assetId: string;
  versions: VersionSummary[];
  /** 새 버전이 만들어진 뒤 상세 화면이 스스로 다시 읽도록 알린다. */
  onCreated: (newVersionId: string, newVersion: string) => void;
  onCancel: () => void;
}) {
  const { role } = useRole();

  const highest = highestVersion(versions);
  const [version, setVersion] = useState(highest ? bumpPatch(highest) : "1.0.0");
  const [documentsSource, setDocumentsSource] = useState<DocumentsSource>("UPLOAD");
  const [files, setFiles] = useState<File[]>([]);
  const [indexingStrategy, setIndexingStrategy] = useState<IndexingStrategyKey | typeof KEEP>(KEEP);
  const [retrievalStrategy, setRetrievalStrategy] = useState<RetrievalStrategyKey | typeof KEEP>(KEEP);
  const [changelog, setChangelog] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUnknown, setCurrentUnknown] = useState(false);

  // 직전 버전 Manifest에서 지금 적용된 전략을 읽어 선택지의 기본값으로 둔다 —
  // 사용자가 "무엇을 바꾸는지"를 현재 값과 비교해 고를 수 있어야 한다. 읽지
  // 못하면(수동 편집·옛 버전) 기본을 "현재 설정 유지"로 두고 그렇다고 말한다.
  // 아무 Preset이나 골라 두면 바꿀 의도가 없던 전략이 조용히 바뀐다.
  const latestVersionId = versions[0]?.id;
  useEffect(() => {
    if (!latestVersionId) return;
    let cancelled = false;

    async function loadCurrentProfiles() {
      try {
        const res = await fetch(`${API_BASE}/api/v1/asset-versions/${latestVersionId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const indexing = indexingStrategyOf(data?.manifest?.indexing_profile);
        const retrieval = retrievalStrategyOf(data?.manifest?.retrieval_profile);
        if (indexing) setIndexingStrategy(indexing);
        if (retrieval) setRetrievalStrategy(retrieval);
        setCurrentUnknown(!indexing || !retrieval);
      } catch {
        // 기본값 조회는 편의다 — 실패해도 폼은 "현재 설정 유지"로 동작한다.
        if (!cancelled) setCurrentUnknown(true);
      }
    }

    loadCurrentProfiles();
    return () => {
      cancelled = true;
    };
  }, [latestVersionId, role.token]);

  const versionError = (() => {
    if (!version.trim()) return "새 버전을 입력하세요.";
    if (!parseSemver(version)) return "major.minor.patch 형식(예: 1.2.3)으로 입력하세요.";
    if (highest && compareSemver(version, highest) <= 0)
      return `기존 버전(v${highest})보다 커야 합니다.`;
    return null;
  })();
  const filesError =
    documentsSource === "UPLOAD" && files.length === 0 ? "문서를 1개 이상 선택하세요." : null;
  const canSubmit = !versionError && !filesError && !submitting;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("version", version.trim());
      form.append("documents_source", documentsSource);
      if (changelog.trim()) form.append("changelog", changelog.trim());
      if (indexingStrategy !== KEEP) {
        form.append("indexing_profile", JSON.stringify(INDEXING_PRESETS[indexingStrategy].profile));
        form.append(
          "indexing_profile_ref",
          JSON.stringify({ name: INDEXING_PRESETS[indexingStrategy].ref, version: "1.0.0" })
        );
      }
      if (retrievalStrategy !== KEEP) {
        form.append(
          "retrieval_profile",
          JSON.stringify(RETRIEVAL_PRESETS[retrievalStrategy].profile)
        );
      }
      if (documentsSource === "UPLOAD") {
        for (const file of files) form.append("files", file, file.name);
      }

      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/knowledge-versions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const traceId = body?.error?.trace_id;
        setError(
          `${body?.error?.message ?? `새 버전을 만들지 못했습니다. (HTTP ${res.status})`}${
            traceId ? ` (trace_id: ${traceId})` : ""
          }`
        );
        return;
      }
      const created = await res.json();
      onCreated(created.id, created.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-card-title font-semibold text-text-primary">새 버전 만들기</h3>
        <p className="mt-1 text-caption text-text-secondary">
          새 버전은 초안(DRAFT)으로 만들어지고 색인이 곧바로 다시 실행됩니다. 기존 버전과 그
          색인은 그대로 남습니다.
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
        {highest && (
          <p className="mt-1 text-caption text-text-muted">현재 최신 버전은 v{highest}입니다.</p>
        )}
      </FormField>

      <FormField label="문서" required>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-body text-text-primary">
            <input
              type="radio"
              name="documents-source"
              checked={documentsSource === "UPLOAD"}
              onChange={() => setDocumentsSource("UPLOAD")}
              disabled={submitting}
              className="mt-1"
            />
            <span>
              <span className="font-medium">새 문서를 올립니다</span>
              <span className="block text-caption text-text-secondary">
                문서가 바뀌었을 때. 올린 문서로 색인을 새로 만듭니다.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-body text-text-primary">
            <input
              type="radio"
              name="documents-source"
              checked={documentsSource === "REUSE_PREVIOUS"}
              onChange={() => {
                setDocumentsSource("REUSE_PREVIOUS");
                setFiles([]);
              }}
              disabled={submitting}
              className="mt-1"
            />
            <span>
              <span className="font-medium">기존 문서를 그대로 씁니다</span>
              <span className="block text-caption text-text-secondary">
                문서는 그대로 두고 색인·검색 전략만 바꿔 다시 색인할 때.
              </span>
            </span>
          </label>
        </div>
      </FormField>

      {documentsSource === "UPLOAD" && (
        <FormField label="문서 파일" required error={filesError ?? undefined}>
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt,.pdf,.docx"
            disabled={submitting}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className={inputClass}
          />
          {files.length > 0 && (
            <p className="mt-1 text-caption text-text-secondary">
              {files.length}개 선택됨: {files.map((f) => f.name).join(", ")}
            </p>
          )}
        </FormField>
      )}

      <FormField label="색인 전략">
        <select
          value={indexingStrategy}
          onChange={(e) => setIndexingStrategy(e.target.value as IndexingStrategyKey | typeof KEEP)}
          disabled={submitting}
          className={inputClass}
        >
          <option value={KEEP}>현재 설정 유지</option>
          {Object.entries(INDEXING_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label} ({preset.tech})
            </option>
          ))}
        </select>
        {indexingStrategy !== KEEP && (
          <p className="mt-1 text-caption text-text-secondary">
            {INDEXING_PRESETS[indexingStrategy].description} · {INDEXING_PRESETS[indexingStrategy].params}
          </p>
        )}
      </FormField>

      <FormField label="검색 전략">
        <select
          value={retrievalStrategy}
          onChange={(e) =>
            setRetrievalStrategy(e.target.value as RetrievalStrategyKey | typeof KEEP)
          }
          disabled={submitting}
          className={inputClass}
        >
          <option value={KEEP}>현재 설정 유지</option>
          {Object.entries(RETRIEVAL_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label} ({preset.tech})
            </option>
          ))}
        </select>
        {retrievalStrategy !== KEEP && (
          <p className="mt-1 text-caption text-text-secondary">
            {RETRIEVAL_PRESETS[retrievalStrategy].description} ·{" "}
            {RETRIEVAL_PRESETS[retrievalStrategy].params}
          </p>
        )}
      </FormField>

      {currentUnknown && (
        <p className="text-caption text-text-muted">
          직전 버전에 적용된 전략을 읽지 못해 기본값을 &quot;현재 설정 유지&quot;로 두었습니다.
          바꾸려는 항목만 선택하세요.
        </p>
      )}

      <FormField label="변경 내용 (Changelog)">
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          rows={2}
          placeholder={
            documentsSource === "UPLOAD"
              ? "예: 2026년 개정 문서로 교체"
              : "예: 긴 규정 문서라 문맥 보존 전략으로 변경"
          }
          disabled={submitting}
          className={inputClass}
        />
      </FormField>

      <div className="rounded-lg border border-border bg-slate-50 px-4 py-3 text-caption text-text-secondary">
        {documentsSource === "UPLOAD" ? (
          <>
            <Upload size={13} className="mr-1 inline" />
            선택한 문서 {files.length}개로 v{version || "?"} 를 만들고 색인을 다시 실행합니다.
          </>
        ) : (
          <>
            <RefreshCw size={13} className="mr-1 inline" />
            문서는 그대로 두고 v{version || "?"} 를 만들어 선택한 전략으로 색인만 다시 실행합니다.
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
          새 버전 만들고 색인
        </Button>
      </div>
    </Card>
  );
}
