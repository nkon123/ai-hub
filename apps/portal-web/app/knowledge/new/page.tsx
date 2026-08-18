"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  Package,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import { Button, Card, ErrorBanner, FormField, PageHeader, inputClass } from "../../_components/ui";

// GET /api/v1/assets/upload-policy (D-034 실 서비스 검증) — a new endpoint,
// so it follows the module's stated convention for new code
// (`NEXT_PUBLIC_API_BASE`, absolute URL), unlike this file's existing calls
// which use the relative `/api/*` + next.config.mjs rewrite pattern that
// predates that convention (apps/portal-web/CLAUDE.md "이 모듈의 경계").
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface UploadPolicy {
  maxSingleFileBytes: number;
  maxTotalRequestBytes: number;
  maxFileCount: number;
  rejectedExtensions: string[];
}

type UploadPolicyState =
  | { status: "loading" }
  | { status: "ok"; policy: UploadPolicy }
  | { status: "unknown"; message: string };

function formatBytesKo(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

/** 편의용 사전 검사 — 최종 판정은 서버(POST /api/v1/assets)가 한다. 통과해도
 * 서버 오류 처리를 건너뛰지 않는다. */
function checkFilesAgainstPolicy(files: File[], policy: UploadPolicy): string[] {
  const problems: string[] = [];
  if (files.length > policy.maxFileCount) {
    problems.push(
      `업로드 파일 개수(${files.length}개)가 허용된 최대치(${policy.maxFileCount}개)를 초과했습니다.`
    );
  }
  let total = 0;
  for (const f of files) {
    total += f.size;
    const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "";
    if (policy.rejectedExtensions.includes(ext)) {
      problems.push(`'${f.name}' 파일의 확장자(${ext || "(없음)"})는 허용되지 않습니다.`);
    }
    if (f.size > policy.maxSingleFileBytes) {
      problems.push(
        `'${f.name}' 파일 크기(${formatBytesKo(f.size)})가 허용된 최대치(${formatBytesKo(policy.maxSingleFileBytes)})를 초과했습니다.`
      );
    }
  }
  if (total > policy.maxTotalRequestBytes) {
    problems.push(
      `전체 파일 크기(${formatBytesKo(total)})가 허용된 최대치(${formatBytesKo(policy.maxTotalRequestBytes)})를 초과했습니다.`
    );
  }
  return problems;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface ServerErrorInfo {
  message: string;
  traceId?: string;
  schemaErrors?: string[];
  permission?: boolean;
}

function extractServerError(status: number, body: any): ServerErrorInfo {
  const message: string =
    body?.error?.message ?? body?.detail ?? `요청을 처리하지 못했습니다. (HTTP ${status})`;
  return {
    message,
    traceId: body?.error?.trace_id,
    schemaErrors: body?.error?.details?.errors,
    permission: status === 403,
  };
}

// AI 추천이 지원하는 확장자 — 두 갈래로 나뉜다.
// 1) 브라우저가 client-side로 텍스트를 바로 읽을 수 있는 형식(.md/.txt류).
// 2) .pdf/.docx는 브라우저가 직접 파싱할 수 없어 서버(services/indexing-runtime의
//    loaders/)에 업로드 전 파일 bytes를 보내 텍스트를 추출한다
//    (POST /api/v1/knowledge/extract-text, portal-api가 indexing-runtime으로
//    relay). 두 형식 모두 registration 자체는 이미 항상 지원했다 — 여기서
//    바뀌는 것은 AI 추천 기능의 지원 범위뿐이다.
const AI_SUGGEST_CLIENT_EXTRACT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const AI_SUGGEST_SERVER_EXTRACT_EXTENSIONS = new Set([".pdf", ".docx"]);

// Client-side pre-trim only, a heuristic — the authoritative bound is
// `AgentRuntimeSettings.knowledge_metadata_suggest_excerpt_max_chars`
// (services/agent-runtime), enforced server-side regardless of this value.
const AI_SUGGEST_CLIENT_EXCERPT_CHAR_LIMIT = 4000;

function fileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

interface IndexingJob {
  id: string;
  status: string;
  chunk_count: number | null;
  error_message: string | null;
}

const INDEXING_PRESETS = {
  parent_child: {
    label: "문맥 보존",
    description: "긴 규정·업무 문서에 적합합니다. 작은 검색 조각과 넓은 문맥을 함께 만듭니다.",
    ref: "balanced-parent-child",
    profile: { chunking_strategy: "parent_child", chunk_size: 512, chunk_overlap: 64, parent_chunk_size: 2048, minimum_size: 64, language: "ko" },
  },
  markdown: {
    label: "문서 구조 우선",
    description: "제목과 절 구성이 중요한 매뉴얼·가이드에 적합합니다.",
    ref: "structured-markdown",
    profile: { chunking_strategy: "markdown", chunk_size: 768, chunk_overlap: 80, parent_chunk_size: 2048, minimum_size: 80, language: "ko" },
  },
  recursive: {
    label: "짧은 조각",
    description: "형식이 일정하지 않은 메모·텍스트를 촘촘하게 나눕니다.",
    ref: "compact-recursive",
    profile: { chunking_strategy: "recursive", chunk_size: 384, chunk_overlap: 48, parent_chunk_size: 1536, minimum_size: 48, language: "ko" },
  },
} as const;

const RETRIEVAL_PRESETS = {
  balanced_hybrid: { label: "균형 검색", description: "의미와 키워드를 같은 비중으로 찾습니다.", profile: { strategy: "balanced_hybrid", top_k: 5, hybrid_alpha: 0.5, min_relevance_score: 0.42, enable_parent_expansion: true } },
  keyword_priority: { label: "키워드 우선", description: "제품명·규정 번호처럼 정확한 용어 일치를 더 중시합니다.", profile: { strategy: "keyword_priority", top_k: 8, hybrid_alpha: 0.25, min_relevance_score: 0.42, enable_parent_expansion: true } },
  semantic_priority: { label: "의미 우선", description: "표현이 달라도 의미가 가까운 문장을 더 중시합니다.", profile: { strategy: "semantic_priority", top_k: 5, hybrid_alpha: 0.8, min_relevance_score: 0.45, enable_parent_expansion: true } },
} as const;

export default function NewKnowledgePage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [classification, setClassification] = useState("INTERNAL");
  const [indexingStrategy, setIndexingStrategy] = useState<keyof typeof INDEXING_PRESETS>("parent_child");
  const [retrievalStrategy, setRetrievalStrategy] = useState<keyof typeof RETRIEVAL_PRESETS>("balanced_hybrid");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ assetVersionId: string; assetId: string } | null>(null);
  const [jobStatus, setJobStatus] = useState<IndexingJob | null>(null);
  const [error, setError] = useState<ServerErrorInfo | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // 이미 사용자가 입력한 칸에 대한 추천만 담긴다(빈 칸은 곧바로 채우므로
  // 여기 남지 않는다). 사용자가 "적용"을 누르기 전까지는 입력이 바뀌지 않는다.
  const [pendingSuggestion, setPendingSuggestion] = useState<{
    name: string | null;
    description: string | null;
  } | null>(null);

  // 파일 선택 "전"에 한도를 먼저 보여주고, 선택 "직후" 클라이언트에서 검사한다
  // — 다 올린 뒤 서버가 거절하는 일을 줄이기 위한 편의 기능일 뿐, 최종
  // 판정은 여전히 서버(POST /api/v1/assets)가 한다. 한도 조회가 실패해도
  // 업로드 자체는 막지 않는다(대신 "확인하지 못했습니다"를 표시).
  const [uploadPolicyState, setUploadPolicyState] = useState<UploadPolicyState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/v1/assets/upload-policy`, {
      headers: { Authorization: "Bearer dev-user-token" },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await safeJson(res);
          setUploadPolicyState({
            status: "unknown",
            message: body?.error?.message ?? `한도를 확인하지 못했습니다. (HTTP ${res.status})`,
          });
          return;
        }
        const body = await res.json();
        setUploadPolicyState({
          status: "ok",
          policy: {
            maxSingleFileBytes: body.max_single_file_bytes,
            maxTotalRequestBytes: body.max_total_request_bytes,
            maxFileCount: body.max_file_count,
            rejectedExtensions: (body.rejected_extensions ?? []).map((e: string) => e.toLowerCase()),
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setUploadPolicyState({ status: "unknown", message: "한도를 확인하지 못했습니다. 네트워크 상태를 확인해 주세요." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fileViolations =
    uploadPolicyState.status === "ok" && files.length > 0
      ? checkFilesAgainstPolicy(files, uploadPolicyState.policy)
      : [];

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
    // 새 파일을 고르면 이전 파일에 대한 AI 추천 오류·대기 중인 추천은 더 이상
    // 의미가 없다(다른 문서의 제안을 적용하게 두면 안 된다).
    setSuggestError(null);
    setPendingSuggestion(null);
  }

  const primaryFile = files[0] ?? null;
  const primaryFileExtension = primaryFile ? fileExtension(primaryFile.name) : "";
  const suggestSupported =
    primaryFile !== null &&
    (AI_SUGGEST_CLIENT_EXTRACT_EXTENSIONS.has(primaryFileExtension) ||
      AI_SUGGEST_SERVER_EXTRACT_EXTENSIONS.has(primaryFileExtension));
  // "이 형식은 추천을 지원하지 않습니다" — 클라이언트/서버 어느 쪽도 텍스트를
  // 추출할 방법이 없는 형식(예: .xlsx, .pptx). .pdf/.docx는 여기 해당하지
  // 않는다 — 지원되지만 서버 의존성이 없을 수는 있고, 그 경우의 문구는 서버
  // 응답에서 온다(아래 handleSuggestMetadata의 두 번째 fetch 오류 처리 참고).
  const suggestDisabledReason = !primaryFile
    ? "문서를 먼저 선택하면 AI 추천을 사용할 수 있습니다."
    : !suggestSupported
      ? `${primaryFileExtension || "이"} 형식은 AI 추천을 지원하지 않습니다. 이름과 설명을 직접 입력해 주세요.`
      : null;

  async function handleSuggestMetadata() {
    if (!primaryFile || !suggestSupported) return;
    setSuggestLoading(true);
    setSuggestError(null);
    setPendingSuggestion(null);
    try {
      let excerpt: string;

      if (AI_SUGGEST_CLIENT_EXTRACT_EXTENSIONS.has(primaryFileExtension)) {
        const rawText = await primaryFile.text();
        excerpt = rawText.slice(0, AI_SUGGEST_CLIENT_EXCERPT_CHAR_LIMIT).trim();
      } else {
        // .pdf/.docx — 브라우저가 파싱할 수 없으므로 서버(indexing-runtime,
        // portal-api relay 경유)에 파일을 보내 텍스트를 추출한다. 여기서 나는
        // 오류는 "이 형식은 추천을 지원하지 않습니다"(형식 자체 미지원)와
        // "서버에 PDF/Word 추출 의존성이 설치되어 있지 않습니다"(형식은
        // 지원되지만 이 배포에 pypdf/python-docx가 없음, D-073)를 서버가 서로
        // 다른 문구로 이미 구분해 보내므로 그대로 보여준다 — 여기서 뭉개지
        // 않는다.
        const extractFormData = new FormData();
        extractFormData.append("file", primaryFile, primaryFile.name);
        const extractRes = await fetch("/api/v1/knowledge/extract-text", {
          method: "POST",
          headers: { Authorization: "Bearer dev-user-token" },
          body: extractFormData,
        });

        if (!extractRes.ok) {
          const err = await extractRes.json().catch(() => null);
          const traceId: string | undefined = err?.error?.trace_id;
          const message: string = err?.error?.message ?? `HTTP ${extractRes.status}`;
          setSuggestError(`${message}${traceId ? ` (Trace ID: ${traceId})` : ""}`);
          return;
        }

        const extractData = await extractRes.json();
        excerpt =
          typeof extractData.excerpt === "string" ? extractData.excerpt.trim() : "";
      }

      if (!excerpt) {
        setSuggestError(
          "문서에서 추출한 내용이 비어 있어 추천할 수 없습니다. 이름과 설명을 직접 입력해 주세요."
        );
        return;
      }

      const res = await fetch("/api/v1/knowledge/suggest-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-user-token" },
        body: JSON.stringify({ excerpt, filename: primaryFile.name }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const traceId: string | undefined = err?.error?.trace_id;
        const message: string = err?.error?.message ?? `HTTP ${res.status}`;
        setSuggestError(
          `AI 추천을 가져오지 못했습니다: ${message}${
            traceId ? ` (Trace ID: ${traceId})` : ""
          } 이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.`
        );
        return;
      }

      const data = await res.json();
      const suggestedName = typeof data.suggested_name === "string" ? data.suggested_name.trim() : "";
      const suggestedDescription =
        typeof data.suggested_description === "string" ? data.suggested_description.trim() : "";

      // 사용자가 이미 쓴 내용을 추천이 말없이 덮지 않는다. 비어 있는 칸만
      // 바로 채우고, 이미 내용이 있는 칸은 추천을 따로 보여준 뒤 사용자가
      // "적용"을 눌렀을 때만 바꾼다. 응답에 값이 없다고 해서 기존 입력을
      // 지우지도 않는다(빈 문자열로 덮으면 사용자 입력이 사라진다).
      if (suggestedName && !name.trim()) setName(suggestedName);
      if (suggestedDescription && !description.trim()) setDescription(suggestedDescription);
      setPendingSuggestion({
        name: suggestedName && name.trim() ? suggestedName : null,
        description: suggestedDescription && description.trim() ? suggestedDescription : null,
      });
      if (!suggestedName && !suggestedDescription) {
        setSuggestError(
          "AI가 제안한 내용이 비어 있습니다. 이름과 설명을 직접 입력해 주세요."
        );
      }
    } catch (e: unknown) {
      setSuggestError(
        `AI 추천 요청 중 오류가 발생했습니다: ${
          e instanceof Error ? e.message : String(e)
        } 이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.`
      );
    } finally {
      setSuggestLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) { setError({ message: "문서 파일을 선택하세요." }); return; }
    if (!name.trim()) { setError({ message: "이름을 입력하세요." }); return; }
    // 클라이언트 사전 검사에서 걸린 위반이 있으면 제출 전에 막는다 — 편의
    // 기능이지만 다 올린 뒤 거절당하는 것보다는 낫다. 한도를 확인하지
    // 못했을 때(status "unknown"/"loading")는 막지 않고 서버 판정에 맡긴다.
    if (fileViolations.length > 0) {
      setError({ message: fileViolations.join(" ") });
      return;
    }

    setSubmitting(true);
    setError(null);

    const manifest = {
      schema_version: "1.0",
      id: crypto.randomUUID(),
      type: "knowledge",
      name: name.trim(),
      version: "1.0.0",
      owner: { org: "miracom", creator_id: "dev-user@miracom.com" },
      classification,
      description: description.trim(),
      source: {
        type: "portal_upload",
        documents: files.map((f) => ({
          path: `documents/${f.name}`,
          mime_type: f.type || "text/markdown",
          sha256: "0".repeat(64),
        })),
      },
      indexing_profile_ref: { name: INDEXING_PRESETS[indexingStrategy].ref, version: "1.0.0" },
      indexing_profile: INDEXING_PRESETS[indexingStrategy].profile,
      retrieval_profile: RETRIEVAL_PRESETS[retrievalStrategy].profile,
    };

    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    for (const file of files) {
      formData.append("files", file, file.name);
    }

    try {
      const res = await fetch("/api/v1/assets", {
        method: "POST",
        headers: { Authorization: "Bearer dev-user-token" },
        body: formData,
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setError(extractServerError(res.status, body));
        return;
      }
      const version = await res.json();
      setResult({ assetVersionId: version.id, assetId: version.asset_id });

      // Poll indexing job status
      pollJobStatus(version.asset_id);
    } catch (e: unknown) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  async function pollJobStatus(assetId: string) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/v1/assets/${assetId}/indexing-jobs`, {
          headers: { Authorization: "Bearer dev-user-token" },
        });
        const jobs = await res.json();
        if (jobs.length > 0) {
          setJobStatus(jobs[0]);
          if (jobs[0].status === "COMPLETED" || jobs[0].status === "FAILED") break;
        }
      } catch {
        break;
      }
    }
  }

  return (
    <div className="max-w-xl">
      <PageHeader title="지식 등록" description="Markdown 문서를 업로드하면 자동으로 인덱싱됩니다." />

      {result ? (
        <div className="space-y-4">
          <div className="rounded-card border border-success/30 bg-success/5 p-5">
            <div className="mb-1.5 flex items-center gap-2 font-semibold text-success">
              <CheckCircle2 size={18} />
              등록 완료
            </div>
            <div className="text-caption text-success">Asset ID: {result.assetId}</div>
          </div>

          <div className="rounded-card border border-border bg-surface p-5 shadow-card">
            <div className="mb-3 text-card-title font-semibold text-text-primary">인덱싱 상태</div>
            {!jobStatus ? (
              <div className="flex items-center gap-2 text-body text-text-secondary">
                <Loader2 size={15} className="animate-spin" />
                인덱싱 서버에 요청 중...
              </div>
            ) : jobStatus.status === "COMPLETED" ? (
              <div>
                <div className="flex items-center gap-2 font-semibold text-success">
                  <CheckCircle2 size={16} />
                  인덱싱 완료
                </div>
                <div className="mt-1 text-caption text-text-secondary">
                  청크 수: {jobStatus.chunk_count ?? "-"}
                </div>
                <div className="mt-4 flex gap-3">
                  <Button href="/assets">
                    <Package size={16} />
                    카탈로그 보기
                  </Button>
                  <Button href="/chatbots/new" variant="accent">
                    <MessageSquare size={16} />
                    챗봇 만들기 →
                  </Button>
                </div>
              </div>
            ) : jobStatus.status === "FAILED" ? (
              <div className="flex items-center gap-2 text-danger">
                <XCircle size={16} />
                인덱싱 실패: {jobStatus.error_message ?? "인덱싱 서버를 확인하세요."}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-warning">
                <Loader2 size={15} className="animate-spin" />
                {jobStatus.status}... 잠시 기다려 주세요.
              </div>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-5">
            {/* 파일을 고르기 "전"에 한도를 먼저 보여준다 — 최종 판정은 서버가
                한다(POST /api/v1/assets). 한도 조회 실패는 업로드를 막지
                않되 조용히 넘기지 않는다. */}
            {uploadPolicyState.status === "loading" && (
              <p className="text-caption text-text-muted">업로드 한도를 확인하는 중...</p>
            )}
            {uploadPolicyState.status === "unknown" && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-caption text-warning">
                업로드 한도를 확인하지 못했습니다: {uploadPolicyState.message} 업로드는 계속 진행할 수 있으며,
                최종 판정은 서버가 합니다.
              </div>
            )}
            {uploadPolicyState.status === "ok" && (
              <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
                파일 1개당 최대 {formatBytesKo(uploadPolicyState.policy.maxSingleFileBytes)} · 전체 합계 최대{" "}
                {formatBytesKo(uploadPolicyState.policy.maxTotalRequestBytes)} · 최대{" "}
                {uploadPolicyState.policy.maxFileCount}개
                {uploadPolicyState.policy.rejectedExtensions.length > 0 && (
                  <>
                    {" "}
                    · 허용되지 않는 확장자: {uploadPolicyState.policy.rejectedExtensions.join(", ")}
                  </>
                )}
              </div>
            )}

            <FormField label="문서 업로드" required>
              <div
                className="cursor-pointer rounded-card border-2 border-dashed border-border bg-slate-50 px-5 py-8 text-center transition-colors hover:border-brand-400"
                onClick={() => document.getElementById("file-input")?.click()}
              >
                <Upload size={28} className="mx-auto mb-2 text-text-muted" strokeWidth={1.5} />
                <div className="text-body text-text-secondary">
                  Markdown(.md), 텍스트(.txt), PDF, Word(.docx) 파일을 선택하세요
                </div>
                {files.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {files.map((f) => (
                      <div key={f.name} className="text-caption text-brand-600">
                        ✓ {f.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input
                id="file-input"
                type="file"
                multiple
                accept=".md,.markdown,.txt,.pdf,.docx"
                onChange={handleFileChange}
                className="hidden"
              />
            </FormField>

            {/* 파일을 고른 직후 클라이언트에서 먼저 검사한 결과 — 편의용이며
                최종 판정이 아니다. */}
            {fileViolations.length > 0 && (
              <div className="space-y-1">
                {fileViolations.map((v, i) => (
                  <ErrorBanner key={i} message={v} />
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-slate-50 px-4 py-3">
              <div className="text-caption text-text-secondary">
                문서를 선택하면 AI가 지식 이름과 설명을 추천해 드립니다. 추천 내용은
                등록 전에 자유롭게 수정할 수 있습니다.
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!suggestSupported || suggestLoading}
                onClick={handleSuggestMetadata}
                className="shrink-0"
              >
                {suggestLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {suggestLoading ? "추천 생성 중..." : "AI 추천"}
              </Button>
            </div>
            {suggestDisabledReason && !suggestLoading && (
              <p className="-mt-3 text-caption text-text-muted">{suggestDisabledReason}</p>
            )}
            {suggestError && <ErrorBanner message={suggestError} />}

            {/* 이미 입력된 칸에 대한 추천 — 사용자가 직접 "적용"을 누를 때만
                기존 입력을 바꾼다. */}
            {pendingSuggestion && (pendingSuggestion.name || pendingSuggestion.description) && (
              <Card className="flex flex-col gap-3 p-4">
                <p className="text-caption text-text-muted">
                  이미 입력하신 내용이 있어 그대로 두었습니다. 아래 추천으로 바꾸려면 적용을 누르세요.
                </p>
                {pendingSuggestion.name && (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-caption text-text-muted">추천 지식 이름</div>
                      <div className="break-words text-body">{pendingSuggestion.name}</div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        setName(pendingSuggestion.name ?? "");
                        setPendingSuggestion((prev) => (prev ? { ...prev, name: null } : prev));
                      }}
                    >
                      이름에 적용
                    </Button>
                  </div>
                )}
                {pendingSuggestion.description && (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-caption text-text-muted">추천 설명</div>
                      <div className="break-words text-body">{pendingSuggestion.description}</div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        setDescription(pendingSuggestion.description ?? "");
                        setPendingSuggestion((prev) =>
                          prev ? { ...prev, description: null } : prev
                        );
                      }}
                    >
                      설명에 적용
                    </Button>
                  </div>
                )}
              </Card>
            )}

            <FormField label="지식 이름" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: HR 정책 Knowledge"
                className={inputClass}
              />
            </FormField>

            <FormField label="설명">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="이 지식 패키지가 다루는 내용을 간략히 설명하세요."
                className={`${inputClass} resize-y`}
              />
            </FormField>

            <FormField label="보안 등급">
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
                className={`${inputClass} w-auto`}
              >
                <option value="PUBLIC_INTERNAL">PUBLIC_INTERNAL — 사내 공개</option>
                <option value="INTERNAL">INTERNAL — 사내 한정</option>
                <option value="CONFIDENTIAL">CONFIDENTIAL — 기밀</option>
              </select>
            </FormField>

            <div className="grid gap-5 border-y border-border py-5 sm:grid-cols-2">
              <FormField label="문서를 나누는 방법" required>
                <select
                  value={indexingStrategy}
                  onChange={(event) => setIndexingStrategy(event.target.value as keyof typeof INDEXING_PRESETS)}
                  className={inputClass}
                >
                  {Object.entries(INDEXING_PRESETS).map(([value, preset]) => (
                    <option key={value} value={value}>{preset.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-caption text-text-muted">{INDEXING_PRESETS[indexingStrategy].description}</p>
              </FormField>
              <FormField label="검색 방법" required>
                <select
                  value={retrievalStrategy}
                  onChange={(event) => setRetrievalStrategy(event.target.value as keyof typeof RETRIEVAL_PRESETS)}
                  className={inputClass}
                >
                  {Object.entries(RETRIEVAL_PRESETS).map(([value, preset]) => (
                    <option key={value} value={value}>{preset.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-caption text-text-muted">{RETRIEVAL_PRESETS[retrievalStrategy].description}</p>
              </FormField>
            </div>

            {error && (
              <div className="space-y-1">
                {error.permission ? (
                  <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body text-warning">
                    {error.message}
                  </div>
                ) : (
                  <ErrorBanner message={error.message} />
                )}
                {error.schemaErrors && error.schemaErrors.length > 0 && (
                  <ul className="ml-4 list-disc text-caption text-danger">
                    {error.schemaErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {error.traceId && <p className="text-caption text-text-muted">Trace ID: {error.traceId}</p>}
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={submitting || fileViolations.length > 0}
              className="self-start"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? "등록 중..." : "지식 등록 시작"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
