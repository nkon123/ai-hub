"use client";

import { useEffect, useState } from "react";
import {
  INDEXING_PRESETS,
  RETRIEVAL_PRESETS,
} from "../../_components/knowledge-profiles";
import {
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  Package,
  RefreshCw,
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

/** RUNNING 인 Job 에만 붙는다. portal-api 가 indexing-runtime 메모리에서 읽어
 *  얹어 주는 값이라, 조회에 실패하면 없을 수 있다(그때는 단계 표시 없이
 *  "진행 중"만 보여 준다 — 모르는 것을 지어내지 않는다). */
interface IndexingProgress {
  stage: string;
  stage_label: string;
  stage_index: number;
  stage_total: number;
  done: number;
  total: number;
  percent: number | null;
  elapsed_seconds: number;
  eta_seconds: number | null;
}

interface IndexingJob {
  id: string;
  status: string;
  chunk_count: number | null;
  error_message: string | null;
  progress?: IndexingProgress | null;
  /** FAILED 인데 디스크에는 완성된 색인이 있는 경우 true. indexing-runtime 이
   *  색인을 끝냈는데 그 응답이 portal-api 에 닿지 못하면(타임아웃/재시작) 생기는
   *  상태로, 다시 등록하지 않고 상태만 실제에 맞추면 된다. */
  index_recoverable?: boolean | null;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/**
 * 등록은 색인이 끝나기를 기다리지 않는다. 등록이 성공한 순간 화면은 이미
 * "등록됨 + 색인은 백그라운드 진행 중"이고, 페이지를 떠나도 된다. 화면을 열어
 * 둔 동안에는 상태를 따라가다가 끝나면 완료/실패로 바뀐다.
 *
 * 이전 구현은 `60회 * 3초 = 180초`를 기다린 뒤 **아무 표시 없이** 루프를
 * 끝냈다. 그런데 portal-api가 색인 실패를 확정하는 예산은 그보다 길다
 * (`Settings.indexing_runtime_timeout_seconds`). 감시 예산이 서버의 실패 예산보다
 * 짧으면 타임아웃으로 실패하는 작업의 결과를 이 화면은 **절대** 표시할 수 없고,
 * 스피너와 "RUNNING..."만 영원히 남는다 — 실제로 2026-09-17에 21MB 문서를
 * 등록하다 그 상태에 빠졌고, 등록자는 다른 창을 띄워서야 FAILED를 알았다.
 *
 * 그래서 감시 예산은 서버 예산(현재 1800초)보다 **길게** 잡는다. 두 값은 각자의
 * 저장소에 있어 코드로 묶을 수 없으니, 서버 쪽을 바꿀 때 이 상수도 같이 본다
 * — `apps/portal-api/src/portal_api/config.py`의 같은 설명이 짝이다.
 * 예산이 끝나도 스피너가 아니라 "확인을 멈췄다 + 어디서 보면 된다"를 명시한다.
 *
 * 간격에 backoff를 두는 이유: 35분을 3초로 나누면 700회 요청인데, 대부분의 색인은
 * 처음 1분 안에 끝난다. 짧은 작업은 빠르게 반영하고 긴 작업은 조용히 기다리게 한다.
 */
const INDEXING_POLL_FAST_INTERVAL_MS = 3000;
const INDEXING_POLL_SLOW_INTERVAL_MS = 10000;
const INDEXING_POLL_FAST_WINDOW_MS = 60 * 1000;
const INDEXING_WATCH_BUDGET_MS = 35 * 60 * 1000;
const INDEXING_POLL_FAILURE_TOLERANCE = 3;

type IndexingWatch =
  | { phase: "queued" }
  | { phase: "running"; job: IndexingJob }
  | { phase: "completed"; job: IndexingJob }
  | { phase: "failed"; job: IndexingJob }
  | { phase: "unwatched"; reason: "budget_exhausted" | "unreachable" };

export default function NewKnowledgePage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [classification, setClassification] = useState("INTERNAL");
  const [indexingStrategy, setIndexingStrategy] = useState<keyof typeof INDEXING_PRESETS>("parent_child");
  const [retrievalStrategy, setRetrievalStrategy] = useState<keyof typeof RETRIEVAL_PRESETS>("balanced_hybrid");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ assetVersionId: string; assetId: string } | null>(null);
  const [watch, setWatch] = useState<IndexingWatch>({ phase: "queued" });
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);

  /** 디스크에 완성된 색인이 있으면 Job 상태를 실제에 맞춘다. 성공하면 화면도
   *  완료로 바뀐다 — 다시 등록하지 않고 몇 분치 임베딩을 지킨다. */
  async function reconcileIndexing(assetId: string, jobId: string) {
    setReconciling(true);
    setReconcileMessage(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/indexing-jobs/${jobId}/reconcile`,
        { method: "POST", headers: { Authorization: "Bearer dev-user-token" } }
      );
      const body = await safeJson(res);
      if (!res.ok) {
        setReconcileMessage(
          body?.error?.message ?? `상태를 확인하지 못했습니다. (HTTP ${res.status})`
        );
        return;
      }
      setReconcileMessage(body?.message ?? null);
      if (body?.changed && body?.status === "COMPLETED") {
        setWatch({
          phase: "completed",
          job: { id: jobId, status: "COMPLETED", chunk_count: body.chunk_count ?? null, error_message: null },
        });
      }
    } catch (e: unknown) {
      setReconcileMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(false);
    }
  }
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
      // 등록은 여기서 끝난다. 색인 감시는 아래 useEffect가 이어받고,
      // 사용자는 기다릴 의무가 없다.
      setResult({ assetVersionId: version.id, assetId: version.asset_id });
    } catch (e: unknown) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  // 등록된 자산의 색인 상태를 화면이 열려 있는 동안만 따라간다. 언마운트하면
  // 즉시 멈춘다(예전 루프는 페이지를 떠난 뒤에도 계속 돌며 사라진 컴포넌트에
  // setState를 호출했다). 이 감시가 멈추는 것과 색인이 멈추는 것은 무관하다 —
  // 색인은 서버에서 계속 진행된다.
  const assetId = result?.assetId;
  useEffect(() => {
    if (!assetId) return;

    let cancelled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();
    const deadline = startedAt + INDEXING_WATCH_BUDGET_MS;

    async function tick() {
      while (!cancelled) {
        if (Date.now() > deadline) {
          if (!cancelled) setWatch({ phase: "unwatched", reason: "budget_exhausted" });
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/indexing-jobs`, {
            headers: { Authorization: "Bearer dev-user-token" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const jobs: IndexingJob[] = await res.json();
          if (cancelled) return;
          consecutiveFailures = 0;
          const job = jobs[0];
          if (job) {
            if (job.status === "COMPLETED") {
              setWatch({ phase: "completed", job });
              return;
            }
            if (job.status === "FAILED") {
              setWatch({ phase: "failed", job });
              return;
            }
            setWatch({ phase: "running", job });
          }
        } catch {
          // 조회 실패는 색인 실패가 **아니다** — 서버는 멀쩡히 색인하는 중인데
          // 브라우저 쪽이 잠깐 끊긴 것일 수 있으므로 실패로 단정하지 않는다.
          // 한 번의 딸꾹질로 감시를 포기하지도 않는다(수 분짜리 작업에서
          // 일시적 실패는 흔하다). 연속으로 실패할 때만 확인을 멈춘다.
          if (cancelled) return;
          consecutiveFailures += 1;
          if (consecutiveFailures >= INDEXING_POLL_FAILURE_TOLERANCE) {
            setWatch({ phase: "unwatched", reason: "unreachable" });
            return;
          }
        }
        const interval =
          Date.now() - startedAt < INDEXING_POLL_FAST_WINDOW_MS
            ? INDEXING_POLL_FAST_INTERVAL_MS
            : INDEXING_POLL_SLOW_INTERVAL_MS;
        await new Promise((r) => setTimeout(r, interval));
      }
    }

    tick();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

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

            {watch.phase === "completed" ? (
              <div>
                <div className="flex items-center gap-2 font-semibold text-success">
                  <CheckCircle2 size={16} />
                  인덱싱 완료
                </div>
                <div className="mt-1 text-caption text-text-secondary">
                  청크 수: {watch.job.chunk_count ?? "-"}
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
            ) : watch.phase === "failed" ? (
              <div>
                <div className="flex items-start gap-2 text-danger">
                  <XCircle size={16} className="mt-0.5 shrink-0" />
                  <span>
                    인덱싱 실패: {watch.job.error_message ?? "인덱싱 서버를 확인하세요."}
                  </span>
                </div>
                {/* 색인이 실제로는 끝나 있는 경우가 있다 — indexing-runtime 이
                    다 만들었는데 그 응답이 portal-api 에 닿지 못하면(타임아웃,
                    프록시, 재시작) Job 만 FAILED 로 남는다. 그때는 다시 등록해
                    몇 분치 임베딩을 버릴 이유가 없으므로, 복구 가능할 때만
                    이 안내를 보여 준다(가능하지 않을 때 권하지 않는다). */}
                {watch.job.index_recoverable ? (
                  <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                    <p className="text-caption text-text-secondary">
                      다만 <strong className="text-text-primary">색인 자체는 완료되어 있습니다.</strong>{" "}
                      색인 서버가 끝냈지만 결과가 허브에 전달되지 못한 경우로, 다시 등록할 필요 없이
                      상태만 맞추면 됩니다.
                    </p>
                    <div className="mt-3">
                      <Button
                        onClick={() => void reconcileIndexing(result.assetId, watch.job.id)}
                        disabled={reconciling}
                      >
                        {reconciling ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <RefreshCw size={16} />
                        )}
                        색인 상태 다시 확인
                      </Button>
                    </div>
                    {reconcileMessage && (
                      <p className="mt-2 text-caption text-text-secondary">{reconcileMessage}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-caption text-text-secondary">
                    문서는 등록되어 있지만 이 버전은 검색에 사용할 수 없습니다. 원인을 해결한 뒤
                    문서를 다시 등록해 주세요.
                  </p>
                )}
                <div className="mt-4 flex gap-3">
                  <Button href={`/assets/${result.assetId}`} variant="secondary">
                    <Package size={16} />
                    자산 상세 보기
                  </Button>
                  {/* 같은 라우트로의 링크는 화면을 초기화하지 못한다
                      (Next.js가 같은 페이지를 다시 마운트하지 않는다).
                      입력값은 남겨 둔 채 결과 화면만 되돌린다. */}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setResult(null);
                      setWatch({ phase: "queued" });
                      setError(null);
                    }}
                  >
                    다시 등록
                  </Button>
                </div>
              </div>
            ) : (
              /* 진행 중 또는 감시 종료. 어느 쪽이든 "기다리세요"가 아니라
                 "나중에 확인하세요"다 — 큰 문서는 색인에 수 분이 걸리고,
                 사용자가 이 화면을 붙잡고 있을 이유가 없다. */
              <div>
                <div className="flex items-center gap-2 text-body text-text-secondary">
                  {watch.phase === "unwatched" ? (
                    <Clock size={15} className="shrink-0 text-text-muted" />
                  ) : (
                    <Loader2 size={15} className="shrink-0 animate-spin text-warning" />
                  )}
                  {watch.phase === "unwatched"
                    ? "이 화면에서의 상태 확인을 멈췄습니다."
                    : "색인이 백그라운드에서 진행 중입니다."}
                </div>

                {/* 실제 진행 상황. 이것이 없으면 "진행 중"과 "멈춤"이 화면에서
                    구분되지 않는다 — 큰 문서는 몇 분씩 걸리므로 등록자가 멈춘
                    것으로 읽게 된다. 진행률이 안 넘어오면 이 블록은 통째로
                    빠지고 위의 "진행 중"만 남는다(모르는 것을 꾸며내지 않는다). */}
                {watch.phase === "running" && watch.job.progress && (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3 text-caption">
                      <span className="text-text-primary">
                        {watch.job.progress.stage_index}/{watch.job.progress.stage_total}단계 ·{" "}
                        {watch.job.progress.stage_label}
                        {watch.job.progress.total > 0 && (
                          <span className="text-text-secondary">
                            {" "}
                            ({watch.job.progress.done.toLocaleString()} /{" "}
                            {watch.job.progress.total.toLocaleString()})
                          </span>
                        )}
                      </span>
                      {watch.job.progress.percent !== null && (
                        <span className="shrink-0 font-semibold text-text-primary">
                          {watch.job.progress.percent}%
                        </span>
                      )}
                    </div>

                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all duration-500"
                        style={{ width: `${watch.job.progress.percent ?? 0}%` }}
                      />
                    </div>

                    <div className="mt-1.5 text-caption text-text-muted">
                      경과 {formatDuration(watch.job.progress.elapsed_seconds)}
                      {watch.job.progress.eta_seconds !== null &&
                        ` · 남은 시간 약 ${formatDuration(watch.job.progress.eta_seconds)}`}
                    </div>
                  </div>
                )}

                <p className="mt-2 text-caption text-text-secondary">
                  {watch.phase === "unwatched" && watch.reason === "unreachable"
                    ? "상태를 조회하지 못했습니다. 색인은 계속 진행 중일 수 있습니다 — 아래에서 현재 상태를 확인하세요."
                    : "이 페이지를 닫아도 됩니다. 문서가 크면 수 분이 걸릴 수 있으며, 완료 여부는 아래에서 다시 확인할 수 있습니다."}
                </p>

                <div className="mt-4 flex gap-3">
                  <Button href={`/assets/${result.assetId}`}>
                    <Package size={16} />
                    자산 상세에서 확인
                  </Button>
                  <Button href="/my/assets" variant="secondary">
                    내 자산 목록
                  </Button>
                </div>
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
                    <option key={value} value={value}>{preset.label} — {preset.tech}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-caption text-text-muted">{INDEXING_PRESETS[indexingStrategy].description}</p>
                <p className="mt-1 text-caption text-text-secondary">
                  {INDEXING_PRESETS[indexingStrategy].tech}
                  <span className="text-text-muted"> · {INDEXING_PRESETS[indexingStrategy].params}</span>
                </p>
              </FormField>
              <FormField label="검색 방법" required>
                <select
                  value={retrievalStrategy}
                  onChange={(event) => setRetrievalStrategy(event.target.value as keyof typeof RETRIEVAL_PRESETS)}
                  className={inputClass}
                >
                  {Object.entries(RETRIEVAL_PRESETS).map(([value, preset]) => (
                    <option key={value} value={value}>{preset.label} — {preset.tech}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-caption text-text-muted">{RETRIEVAL_PRESETS[retrievalStrategy].description}</p>
                <p className="mt-1 text-caption text-text-secondary">
                  {RETRIEVAL_PRESETS[retrievalStrategy].tech}
                  <span className="text-text-muted"> · {RETRIEVAL_PRESETS[retrievalStrategy].params}</span>
                </p>
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
