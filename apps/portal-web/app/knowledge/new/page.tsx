"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, MessageSquare, Package, Upload, XCircle } from "lucide-react";
import { Button, ErrorBanner, FormField, PageHeader, inputClass } from "../../_components/ui";

interface IndexingJob {
  id: string;
  status: string;
  chunk_count: number | null;
  error_message: string | null;
}

export default function NewKnowledgePage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [classification, setClassification] = useState("INTERNAL");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ assetVersionId: string; assetId: string } | null>(null);
  const [jobStatus, setJobStatus] = useState<IndexingJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("이름을 입력하세요."); return; }
    if (files.length === 0) { setError("문서 파일을 선택하세요."); return; }

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
      indexing_profile_ref: { name: "default-korean-parent-child", version: "1.0.0" },
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
        const err = await res.json();
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const version = await res.json();
      setResult({ assetVersionId: version.id, assetId: version.asset_id });

      // Poll indexing job status
      pollJobStatus(version.asset_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
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

            <FormField label="문서 업로드" required>
              <div
                className="cursor-pointer rounded-card border-2 border-dashed border-border bg-slate-50 px-5 py-8 text-center transition-colors hover:border-brand-400"
                onClick={() => document.getElementById("file-input")?.click()}
              >
                <Upload size={28} className="mx-auto mb-2 text-text-muted" strokeWidth={1.5} />
                <div className="text-body text-text-secondary">Markdown(.md) 파일을 선택하세요</div>
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
                accept=".md,.markdown,.txt"
                onChange={handleFileChange}
                className="hidden"
              />
            </FormField>

            {error && <ErrorBanner message={error} />}

            <Button type="submit" size="lg" disabled={submitting} className="self-start">
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? "등록 중..." : "지식 등록 시작"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
