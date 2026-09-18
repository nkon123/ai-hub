"use client";

/**
 * 유형별 자산 목록 화면의 공통 본체 (`/assets/knowledge`, `/assets/prompts`,
 * `/assets/mcp`).
 *
 * 세 화면의 차이는 "어떤 type 을 보여주는가"와 "우상단 등록 버튼이 어디로
 * 가는가" 뿐이라서, 목록·검색·상태 처리는 여기 한 번만 둔다. 화면을 하나 더
 * 늘릴 때 복사할 것은 이 파일이 아니라 `app/assets/<유형>/page.tsx` 의 10줄짜리
 * 설정이다.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, Plus, Search, SearchX } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  inputClass,
} from "./ui";
import { useRole } from "./role-context";
import { AssetList, assetDetailHref, type Asset } from "./asset-list";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// GET /assets 는 type 을 정확히 하나만 받는다(portal_api routers/assets.py
// ::list_assets — `Asset.type == type`). MCP 처럼 두 유형을 한 화면에 모으는
// 경우는 유형마다 한 번씩 조회해 합친다. 서버 계약을 "type 여러 개"로 넓히는
// 것은 별도 Contract PR 사안이다(루트 CLAUDE.md §모듈 소유권).
const FETCH_PAGE_SIZE = 100;

// 검색어를 칠 때마다 유형 수만큼 요청이 나가지 않도록 하는 최소 지연.
const SEARCH_DEBOUNCE_MS = 250;

type LoadState = "loading" | "ok" | "error" | "forbidden";

/** 유형 하나에 대한 조회 결과. `forbidden` 을 판별자로 둔다. */
type TypeQueryResult =
  | { forbidden: true }
  | { forbidden: false; items: Asset[]; total: number };

export interface AssetTypePageProps {
  title: string;
  description: string;
  /** 이 화면이 보여줄 자산 type 들(`knowledge`, `prompt`, `mcp_server` …). */
  types: string[];
  registerHref: string;
  registerLabel: string;
  /** 등록 버튼 옆에 함께 둘 보조 액션(선택). */
  secondaryAction?: React.ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  searchPlaceholder?: string;
}

export function AssetTypePage({
  title,
  description,
  types,
  registerHref,
  registerLabel,
  secondaryAction,
  emptyTitle,
  emptyDescription,
  searchPlaceholder = "자산 이름 검색...",
}: AssetTypePageProps) {
  const router = useRouter();
  const { role } = useRole();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // types 는 호출부에서 리터럴 배열로 오므로 렌더마다 참조가 바뀐다 — 의존성에
  // 배열 자체를 넣으면 무한 루프가 된다. 내용으로 비교한다.
  const typeKey = types.join(",");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setErrorMessage(null);
      try {
        const responses = await Promise.all(
          typeKey.split(",").map(async (type): Promise<TypeQueryResult> => {
            const params = new URLSearchParams({
              type,
              page: "1",
              page_size: String(FETCH_PAGE_SIZE),
            });
            if (appliedQuery) params.set("q", appliedQuery);
            const res = await fetch(`${API_BASE}/api/v1/assets?${params}`, {
              headers: { Authorization: `Bearer ${role.token}` },
            });
            if (res.status === 403) return { forbidden: true };
            if (!res.ok) {
              const body = await res.json().catch(() => null);
              const traceId = body?.error?.trace_id ?? body?.trace_id;
              throw new Error(
                `${body?.error?.message ?? `HTTP ${res.status}`}${traceId ? ` (trace_id: ${traceId})` : ""}`
              );
            }
            const data = await res.json();
            return {
              forbidden: false,
              items: (data.items ?? []) as Asset[],
              total: (data.total ?? 0) as number,
            };
          })
        );

        if (cancelled) return;

        if (responses.some((r) => r.forbidden)) {
          setState("forbidden");
          return;
        }

        const ok = responses.filter(
          (r): r is Extract<TypeQueryResult, { forbidden: false }> => !r.forbidden
        );
        const merged = ok
          .flatMap((r) => r.items)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        setAssets(merged);
        setTotal(ok.reduce((sum, r) => sum + r.total, 0));
        setState("ok");
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [typeKey, appliedQuery, role.token]);

  const truncated = state === "ok" && total > assets.length;

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {secondaryAction}
            <Button href={registerHref}>
              <Plus size={16} /> {registerLabel}
            </Button>
          </>
        }
      />

      <div className="mb-6 flex gap-3">
        <div className="relative w-60">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} pl-9`}
          />
        </div>
      </div>

      {state === "loading" && <LoadingState label="자산 목록을 불러오는 중..." />}

      {state === "forbidden" && <ErrorBanner message="이 목록을 조회할 권한이 없습니다." />}

      {state === "error" && (
        <ErrorBanner message={`자산 목록을 불러오지 못했습니다: ${errorMessage}`} />
      )}

      {state === "ok" && assets.length === 0 && appliedQuery && (
        <EmptyState
          icon={<SearchX size={40} strokeWidth={1.5} />}
          title={`"${appliedQuery}"와 일치하는 자산이 없습니다.`}
          description="검색어를 지우면 전체 목록을 볼 수 있습니다."
        />
      )}

      {state === "ok" && assets.length === 0 && !appliedQuery && (
        <EmptyState
          icon={<Inbox size={40} strokeWidth={1.5} />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            <Button href={registerHref} size="sm">
              {registerLabel}
            </Button>
          }
        />
      )}

      {state === "ok" && assets.length > 0 && (
        <>
          <AssetList assets={assets} onSelect={(asset) => router.push(assetDetailHref(asset))} />
          {truncated && (
            <p className="mt-4 text-caption text-text-muted">
              전체 {total}건 중 최근 {assets.length}건만 표시했습니다. 검색으로 범위를 좁히세요.
            </p>
          )}
        </>
      )}
    </div>
  );
}
