// D06 대화 — "프롬프트" 고르기 패널의 순수 로직.
//
// 이 파일에 DOM/React/IPC가 없는 이유는 이 저장소의 vitest가
// `environment: "node"`라 화면 자체는 자동 테스트로 증명되지 않기 때문이다
// (`apps/desktop-client/CLAUDE.md`). 그래서 "무엇이 입력창에 들어가는가",
// "무엇이 최근 항목인가"처럼 틀리면 조용히 잘못된 문구를 보내게 되는 판단은
// 전부 여기 순수 함수로 내려 두고 `promptPickerTypes.test.ts`가 고정한다.
//
// 이 패널이 하는 일은 **입력창에 문구를 넣는 것뿐**이다 — 프롬프트를
// agent-runtime의 system prompt/템플릿으로 적용하는 경로(D-034 해석 경로
// 2/4)와는 다른 기능이다. 사용자가 보낸 것은 언제나 사용자가 입력창에서 눈으로
// 확인한 텍스트이며, 이 파일은 그 텍스트를 만들 뿐 전송하지 않는다.

/** 설치된 Prompt 자산 한 건 — 목록에 필요한 것만. */
export interface PromptAssetEntry {
  assetId: string;
  version: string;
  name: string;
  installedAt: string;
}

/** 최근 사용 기록 한 건. `key`는 `promptUseKey()`가 만든다. */
export interface PromptUseRecord {
  key: string;
  usedAt: string;
}

/** 목록/기록에서 자산 한 건을 가리키는 키. 같은 자산의 다른 버전은 다른
 * 프롬프트다 — 버전을 키에 넣지 않으면 v1을 쓰던 기록이 v2를 최근 항목으로
 * 끌어올린다. */
export function promptUseKey(entry: Pick<PromptAssetEntry, "assetId" | "version">): string {
  return `${entry.assetId}@${entry.version}`;
}

export interface SortedPromptEntry extends PromptAssetEntry {
  key: string;
  /** 최근 사용 기록이 있으면 그 시각, 없으면 `null`. */
  lastUsedAt: string | null;
}

/** 최근에 적용한 것을 위로, 나머지는 이름순.
 *
 * 최근 목록에만 있고 설치 목록에는 없는 키(자산을 지웠거나 다른 버전만 남은
 * 경우)는 **조용히 버린다** — 없는 것을 목록에 만들어 보여주면 눌렀을 때만
 * 실패한다. */
export function sortPromptsByRecentUse(
  prompts: PromptAssetEntry[],
  recentUses: PromptUseRecord[],
): SortedPromptEntry[] {
  const usedAtByKey = new Map<string, string>();
  for (const use of recentUses) {
    // 같은 키가 여러 번 있으면 먼저 나온 것(더 최근)을 남긴다.
    if (!usedAtByKey.has(use.key)) usedAtByKey.set(use.key, use.usedAt);
  }
  const recentOrder = new Map<string, number>();
  recentUses.forEach((use, index) => {
    if (!recentOrder.has(use.key)) recentOrder.set(use.key, index);
  });

  return prompts
    .map((prompt) => {
      const key = promptUseKey(prompt);
      return { ...prompt, key, lastUsedAt: usedAtByKey.get(key) ?? null };
    })
    .sort((a, b) => {
      const aRank = recentOrder.get(a.key);
      const bRank = recentOrder.get(b.key);
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a.name.localeCompare(b.name, "ko");
    });
}

/** 본문에 남아 있는 `{{name}}` 자리 이름들(중복 제거, 등장 순서 유지). */
export function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(text);
  }
  return found;
}

export interface ComposedPrompt {
  /** 입력창에 넣을 최종 텍스트. */
  text: string;
  /** 입력창에 있던 기존 텍스트를 `{{question}}` 자리에 넣었는가. */
  questionFilled: boolean;
  /** 아직 사람이 채워야 하는 자리 이름들. 비어 있지 않으면 화면이 그대로
   * 보내지 말라고 알려야 한다 — 이 텍스트는 엔진이 채워 주지 않는다. */
  remainingPlaceholders: string[];
}

/** 프롬프트 본문을 입력창 텍스트로 만든다.
 *
 * 규칙(테스트가 고정한다):
 * 1. 본문에 `{{question}}`이 있고 입력창에 이미 쓰던 글이 있으면 그 자리에
 *    넣는다 — 질문을 두 번 쓰게 하지 않는다.
 * 2. `{{question}}`이 있는데 입력창이 비어 있으면 자리를 **그대로 남긴다**.
 *    빈 문자열로 지우면 어디에 질문을 써야 하는지 사라진다.
 * 3. `{{question}}`이 없고 입력창에 쓰던 글이 있으면 본문 **뒤에** 빈 줄을
 *    두고 붙인다 — 사용자가 쓴 글을 버리지 않는다.
 * 4. 남은 자리는 지우지 않고 목록으로 돌려준다. 프롬프트 일부를 말없이
 *    삭제하는 것이 자리를 남기는 것보다 나쁘다(무엇이 사라졌는지 모른다).
 */
export function composePromptForComposer(currentText: string, body: string): ComposedPrompt {
  const existing = currentText.trim();
  const hasQuestionSlot = findPlaceholders(body).includes("question");

  let text: string;
  let questionFilled = false;
  if (hasQuestionSlot && existing) {
    text = body.replace(/\{\{\s*question\s*\}\}/g, existing);
    questionFilled = true;
  } else if (!hasQuestionSlot && existing) {
    text = `${body.trimEnd()}\n\n${existing}`;
  } else {
    text = body;
  }

  return { text, questionFilled, remainingPlaceholders: findPlaceholders(text) };
}

/** 남은 자리를 사람이 읽는 한 문장으로. 없으면 `null`. */
export function describeRemainingPlaceholders(names: string[]): string | null {
  if (names.length === 0) return null;
  const listed = names.map((name) => `{{${name}}}`).join(", ");
  return `아직 채워지지 않은 자리가 있습니다: ${listed} — 보내기 전에 직접 채우거나 지우세요. 이 값은 자동으로 채워지지 않습니다.`;
}

// --- 최근 사용 기록 -----------------------------------------------------------
//
// 설정(D10)이 아니라 이 화면의 기억이다 — 사용자가 고르는 값이 아니라 사용
// 흔적이라 `desktop-settings.ts`에 넣지 않는다. 저장은 브라우저/Electron
// 렌더러의 `localStorage`를 쓰되, **읽기·쓰기 실패가 기능을 막지 않는다**
// (사생활 모드, 저장소 가득 참, 값 손상 — 전부 "최근 목록이 없다"로 degrade).

const STORAGE_KEY = "desktop.chat.recentPrompts.v1";
const MAX_RECENT = 10;

/** `window.localStorage`와 같은 최소 인터페이스. 테스트가 가짜를 넣는다. */
export interface RecentPromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readRecentPromptUses(storage: RecentPromptStorage | null): PromptUseRecord[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.key !== "string" || typeof record.usedAt !== "string") return [];
      return [{ key: record.key, usedAt: record.usedAt }];
    });
  } catch {
    return [];
  }
}

/** 방금 쓴 프롬프트를 맨 앞으로. 같은 키는 하나만 남기고, 최대 10건만 둔다.
 * 저장에 실패해도 던지지 않고 "이번 기록만 남지 않은" 상태로 끝낸다 — 프롬프트는
 * 이미 입력창에 들어갔고, 기록을 못 남겼다고 그 행동을 되돌릴 이유는 없다. */
export function recordPromptUse(
  storage: RecentPromptStorage | null,
  key: string,
  usedAt: string,
): PromptUseRecord[] {
  const next = [
    { key, usedAt },
    ...readRecentPromptUses(storage).filter((use) => use.key !== key),
  ].slice(0, MAX_RECENT);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 위 주석 참고 — 무시한다.
    }
  }
  return next;
}
