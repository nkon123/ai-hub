// D06 대화 — 허브에서 받은 프롬프트를 골라 질문 입력창에 넣는다.
//
// "지식 연결"(보유 Knowledge에서 찾기)이 **런타임 동작**을 바꾸는 토글이라면,
// 이 버튼은 **입력창 텍스트**만 바꾼다. 둘을 나란히 두되 성격이 다르다는 것을
// 흐리지 않는다: 여기서 고른 프롬프트는 agent-runtime의 system prompt로
// 적용되지 않고(그 경로는 D-034 해석 경로 2/4의 Agent+Prompt 짝이다), 사용자가
// 입력창에서 눈으로 확인한 뒤 직접 보낸다. 패널 문구도 그렇게 말한다 — "적용"과
// "넣기"를 섞어 쓰면 사용자는 보내지도 않은 지침이 이미 걸린 줄 안다.
//
// `LocalToolInvokePanel`과 같은 자리(입력창 아래 버튼 줄)에 같은 모양으로 둔다.
// 목록 판단(최근 순서)과 텍스트 조립은 전부 `promptPickerTypes.ts`의 순수
// 함수이며 이 컴포넌트는 그 결과를 그리기만 한다 — 이 저장소에는 렌더링
// 테스트가 없으므로(vitest `environment: "node"`) 틀리면 조용한 것은 전부
// 그쪽에 두고 테스트로 고정한다.

import { useCallback, useEffect, useState } from "react";
import { FileText, History, Loader2 } from "lucide-react";
import type { DesktopBridge, PromptTemplateResult } from "../../electron/types";
import { Button, ErrorBanner, LoadingState, Modal } from "../ui";
import { formatDateTime } from "../format";
import {
  composePromptForComposer,
  describeRemainingPlaceholders,
  promptUseKey,
  readRecentPromptUses,
  recordPromptUse,
  sortPromptsByRecentUse,
  type PromptAssetEntry,
  type PromptUseRecord,
  type SortedPromptEntry,
} from "./promptPickerTypes";

/** `window.localStorage` — 없거나(SSR/제한 환경) 접근 자체가 던지는 경우가
 * 있어 읽기 시점에 감싼다. 최근 목록은 편의일 뿐이라 없으면 그냥 비어 있다. */
function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function PromptPickerPanel({
  bridge,
  disabled,
  currentQuestion,
  onApply,
  externalOpen = false,
  onExternalOpenChange,
  showTrigger = true,
}: {
  /** `null`이면(브라우저 개발 모드) 설치된 자산 폴더가 없다 — 버튼은 보이되
   * 비활성 + 사유(Permission 상태). */
  bridge: DesktopBridge | null;
  disabled?: boolean;
  /** 입력창에 지금 들어 있는 텍스트 — `{{question}}` 자리에 넣는다. */
  currentQuestion: string;
  /** 완성된 텍스트를 입력창에 넣는다. 보내지는 않는다. */
  onApply: (text: string) => void;
  /** 입력창 "+" 메뉴에서 열 때 — 트리거 버튼은 그 메뉴가 갖고 있다. */
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<SortedPromptEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [recentUses, setRecentUses] = useState<PromptUseRecord[]>([]);
  const [selected, setSelected] = useState<SortedPromptEntry | null>(null);
  const [template, setTemplate] = useState<PromptTemplateResult | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);

  const load = useCallback(async () => {
    if (!bridge) return;
    setPrompts(null);
    setListError(null);
    const uses = readRecentPromptUses(safeLocalStorage());
    setRecentUses(uses);
    try {
      const installed = await bridge.listInstalledAssets();
      const entries: PromptAssetEntry[] = installed
        .filter((asset) => asset.assetType === "prompt")
        .map((asset) => ({
          assetId: asset.assetId,
          version: asset.version,
          name: asset.name,
          installedAt: asset.installedAt,
        }));
      setPrompts(sortPromptsByRecentUse(entries, uses));
    } catch (err) {
      // 오류를 조용히 삼키지 않는다 — 빈 목록으로 두면 "받은 프롬프트가
      // 없다"와 "못 읽었다"가 같은 화면이 된다.
      setListError(err instanceof Error ? err.message : "설치된 프롬프트 목록을 불러오지 못했습니다.");
      setPrompts([]);
    }
  }, [bridge]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // "+" 메뉴에서 연 경우. 내부 상태를 그대로 쓰므로 여는 방법만 둘이 되고
  // 닫는 경로(취소/적용/바깥 클릭)는 하나로 남는다.
  useEffect(() => {
    if (externalOpen) setOpen(true);
  }, [externalOpen]);

  function close() {
    setOpen(false);
    onExternalOpenChange?.(false);
    setSelected(null);
    setTemplate(null);
    setTemplateLoading(false);
  }

  async function select(entry: SortedPromptEntry) {
    setSelected(entry);
    setTemplate(null);
    setTemplateLoading(true);
    try {
      if (!bridge) throw new Error("Desktop 런타임이 필요합니다.");
      setTemplate(await bridge.getPromptTemplate(entry.assetId, entry.version));
    } catch (err) {
      setTemplate({
        available: false,
        reason: err instanceof Error ? err.message : "프롬프트 본문을 읽지 못했습니다.",
        system: null,
        body: null,
        variables: [],
      });
    } finally {
      setTemplateLoading(false);
    }
  }

  function apply() {
    if (!selected || !template?.available || !template.body) return;
    const composed = composePromptForComposer(currentQuestion, template.body);
    onApply(composed.text);
    setRecentUses(recordPromptUse(safeLocalStorage(), promptUseKey(selected), new Date().toISOString()));
    close();
  }

  const preview = template?.available && template.body
    ? composePromptForComposer(currentQuestion, template.body)
    : null;
  const placeholderNotice = preview ? describeRemainingPlaceholders(preview.remainingPlaceholders) : null;

  return (
    <>
      {showTrigger && (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !bridge}
        title={
          !bridge
            ? "허브에서 받은 프롬프트는 Desktop 앱에서만 사용할 수 있습니다."
            : disabled
              ? "이미 실행 중입니다."
              : "허브에서 받은 프롬프트를 골라 질문 입력창에 넣습니다."
        }
        aria-label="프롬프트 고르기"
        className="flex h-8 items-center justify-center gap-1.5 rounded-full border border-transparent bg-slate-100 px-2.5 text-caption font-medium text-text-secondary transition-colors hover:bg-slate-200 hover:text-text-primary disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-muted"
      >
        <FileText size={15} aria-hidden="true" />
        프롬프트
      </button>
      )}

      <Modal
        open={open}
        title={selected ? `프롬프트 미리보기 — ${selected.name}` : "프롬프트 고르기"}
        onClose={close}
      >
        {!selected && (
          <div className="space-y-3">
            <p className="text-caption text-text-secondary">
              고른 프롬프트의 본문이 <strong>질문 입력창에 들어갑니다</strong>. 내용을 확인하고 고친 뒤
              직접 보내세요 — 고르는 것만으로는 아무것도 전송되지 않습니다.
            </p>

            {prompts === null && !listError && <LoadingState label="설치된 프롬프트를 불러오는 중..." />}
            {listError && <ErrorBanner message={listError} />}

            {prompts !== null && prompts.length === 0 && !listError && (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-caption text-text-secondary">
                <p>허브에서 받은 프롬프트가 없습니다.</p>
                <p className="mt-1 text-text-muted">
                  자산 허브 &gt; Prompt에서 필요한 프롬프트를 설치하면 여기에 나타납니다.
                </p>
              </div>
            )}

            {prompts !== null && prompts.length > 0 && (
              <ul className="space-y-1.5">
                {prompts.map((entry, index) => {
                  const isFirstOther = entry.lastUsedAt === null && index > 0 && prompts[index - 1].lastUsedAt !== null;
                  return (
                    <li key={entry.key}>
                      {index === 0 && entry.lastUsedAt !== null && (
                        <p className="mb-1 text-caption font-semibold text-text-muted">최근에 쓴 프롬프트</p>
                      )}
                      {isFirstOther && (
                        <p className="mt-3 mb-1 text-caption font-semibold text-text-muted">허브에서 받은 프롬프트</p>
                      )}
                      <button
                        type="button"
                        onClick={() => void select(entry)}
                        className="w-full rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
                      >
                        <span className="flex items-center gap-1.5 text-body font-semibold text-text-primary">
                          <FileText size={13} className="shrink-0" aria-hidden="true" /> {entry.name}
                          <span className="text-caption font-normal text-text-muted">v{entry.version}</span>
                        </span>
                        <span className="mt-0.5 block text-caption text-text-secondary">
                          {entry.lastUsedAt ? (
                            <span className="inline-flex items-center gap-1">
                              <History size={11} aria-hidden="true" /> 최근 사용 {formatDateTime(entry.lastUsedAt)}
                            </span>
                          ) : (
                            <>설치됨 {formatDateTime(entry.installedAt)}</>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex justify-end">
              <Button variant="secondary" onClick={close}>
                취소
              </Button>
            </div>
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            {templateLoading && <LoadingState label="프롬프트 본문을 읽는 중..." />}

            {template && !template.available && (
              <ErrorBanner message={template.reason ?? "프롬프트 본문을 읽지 못했습니다."} />
            )}

            {template?.available && (
              <>
                {template.system && (
                  <div>
                    <p className="mb-1 text-caption font-semibold text-text-muted">역할 지침 (참고)</p>
                    <p className="rounded-lg bg-background px-3 py-2 text-caption text-text-secondary">
                      {template.system}
                    </p>
                    <p className="mt-1 text-caption text-text-muted">
                      이 지침은 자산에 적힌 설명입니다 — 입력창에는 아래 본문만 들어갑니다.
                    </p>
                  </div>
                )}

                <div>
                  <p className="mb-1 text-caption font-semibold text-text-muted">입력창에 들어갈 내용</p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-background px-3 py-2 text-caption text-text-primary">
                    {preview?.text}
                  </pre>
                </div>

                {preview?.questionFilled && (
                  <p className="text-caption text-text-secondary">
                    입력창에 쓰던 글을 {"{{question}}"} 자리에 넣었습니다.
                  </p>
                )}

                {placeholderNotice && (
                  <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning">
                    {placeholderNotice}
                  </p>
                )}

                {template.variables.length > 0 && (
                  <p className="text-caption text-text-muted">
                    이 프롬프트가 선언한 값:{" "}
                    {template.variables
                      .map((v) => `${v.name}${v.required ? "(필수)" : ""}`)
                      .join(", ")}
                  </p>
                )}
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setSelected(null); setTemplate(null); }}>
                목록으로
              </Button>
              <Button onClick={apply} disabled={!template?.available || templateLoading}>
                {templateLoading && <Loader2 size={14} className="animate-spin" />}
                입력창에 넣기
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
