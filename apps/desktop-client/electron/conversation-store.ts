// D06 대화 보존 — Desktop 대화 고도화(멀티턴)의 Main Process 저장소.
//
// `ActiveVersionStore`/`DesktopSettingsStore`와 동일한 관례(단일 JSON 파일,
// `state/` 아래, Main Process 전용, PoC 규모)를 따르되 별개 파일로 분리한다
// — 대화 기록은 그 두 저장소와 전혀 다른 수명주기(사용자가 직접 생성·삭제)를
// 가진다.
//
// 이 파일이 저장하는 값(질문·답변 원문)은 CLAUDE.md가 명시적으로 민감하다고
// 지정한 종류의 데이터다: "Log에 Prompt 원문, 문서 전체, DB 결과, Secret을
// 기본 저장하지 않는다"와 같은 원칙이 대화 내용에도 그대로 적용된다. 따라서:
// - 이 저장소를 다루는 코드는 질문/답변 "원문"을 `getLogger()`로 절대 넘기지
//   않는다 — 구조적 이벤트(대화 생성/삭제, 턴 추가)만 길이·개수로 로깅한다
//   (삭제 "사유"는 예외 — `assets:remove`가 이미 확립한 선례대로 사유는
//   운영자가 직접 입력한 짧은 정당화 텍스트이지 문서/Prompt 내용이 아니므로
//   로깅해도 안전하다).
// - `electron/diagnostic-bundle.ts`는 이 파일을 아예 import하지 않는다 —
//   Allow-list 원칙(그 파일 모듈 docstring)상 진단 Bundle에 대화 내용이
//   들어올 유일한 방법은 누군가 그 파일에 새 필드를 "추가"하는 것뿐이며,
//   `electron/__tests__/conversation-diagnostic-leak.test.ts`가 그런 회귀를
//   실제로 잡아낸다.
//
// Citation 등 Run의 나머지 상세 정보(D07)는 의도적으로 저장하지 않는다 —
// 이 저장소의 목적은 (1) 재시작 후 대화를 이어갈 수 있게 하는 것과 (2)
// agent-runtime에 넘길 후속 질문용 `history`(질문+답변 쌍)를 제공하는 것
// 두 가지뿐이며, 둘 다 citation 원문 저장을 요구하지 않는다 — 저장 표면을
// 필요한 만큼만 유지한다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ConversationTurnStatus = "succeeded" | "insufficient_evidence" | "failed" | "cancelled";

export interface ConversationTurnRecord {
  id: string;
  question: string;
  answer: string;
  status: ConversationTurnStatus;
  citationCount: number;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  knowledgeId: string;
  knowledgeLabel: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurnRecord[];
}

export interface ConversationSummary {
  id: string;
  knowledgeId: string;
  knowledgeLabel: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

const TITLE_PLACEHOLDER = "새 대화";
const TITLE_MAX_LENGTH = 40;

/** Derives a short list-view title from a turn's question — never stores a
 * second, hand-maintained summary; always the literal (truncated) question
 * text, so nothing here can drift from what the user actually asked. */
function titleFromQuestion(question: string): string {
  const trimmed = question.trim();
  if (!trimmed) return TITLE_PLACEHOLDER;
  return trimmed.length > TITLE_MAX_LENGTH ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}…` : trimmed;
}

function toSummary(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    knowledgeId: record.knowledgeId,
    knowledgeLabel: record.knowledgeLabel,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turnCount: record.turns.length,
  };
}

export class ConversationStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "conversations.json");
  }

  private readAll(): ConversationRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return Array.isArray(parsed) ? (parsed as ConversationRecord[]) : [];
    } catch {
      // 손상된 파일은 "대화 없음"으로 취급한다 — Desktop은 상태 파일 손상
      // 시에도 종료되지 않는다(CLAUDE.md). 손상 자체를 자동으로 덮어써
      // 복구를 더 어렵게 만들지 않도록, 이 메서드는 읽기 전용이며 쓰지
      // 않는다 — 다음 `save()` 호출 전까지는 원본 파일이 그대로 남는다.
      return [];
    }
  }

  private save(records: ConversationRecord[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }

  /** 최신 순(`updatedAt` 내림차순) — 목록 UI가 가장 최근 대화를 위에
   * 보여준다. 턴 원문 없이 요약만 반환한다(목록 렌더링에는 필요 없다).
   * 동일 밀리초에 여러 대화가 갱신될 수 있으므로(빠른 연속 호출), 시각이
   * 같으면 파일 내 위치(나중에 쓰인 것이 더 뒤)로 동점을 깨서 결과가
   * `Date.now()`의 밀리초 해상도에 좌우되지 않게 한다. */
  list(): ConversationSummary[] {
    return this.readAll()
      .map((record, index) => ({ record, index }))
      .sort((a, b) => {
        const byTime = b.record.updatedAt.localeCompare(a.record.updatedAt);
        return byTime !== 0 ? byTime : b.index - a.index;
      })
      .map(({ record }) => toSummary(record));
  }

  get(id: string): ConversationRecord | null {
    return this.readAll().find((r) => r.id === id) ?? null;
  }

  /** "새 대화 시작" — 첫 턴이 추가되기 전까지는 제목이 Placeholder다. 빈
   * 대화(턴이 하나도 없는)가 재시작 후에도 목록에 남는 것을 피하기 위해,
   * 실제로는 ChatScreen이 첫 턴 완료 시점에만 이 메서드를 호출한다(빈
   * 시도를 기록하지 않는다) — 이 메서드 자체는 그 제약을 강제하지 않고
   * 호출자를 신뢰한다(순수 저장소 계층).
   */
  create(knowledgeId: string, knowledgeLabel: string): ConversationRecord {
    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id: crypto.randomUUID(),
      knowledgeId,
      knowledgeLabel,
      title: TITLE_PLACEHOLDER,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    const all = this.readAll();
    all.push(record);
    this.save(all);
    return record;
  }

  /** `null` 반환 = 대상 대화가 이미 삭제되었거나 존재한 적 없음(호출자가
   * 오래된 conversationId를 들고 있는 경쟁 상황) — 조용히 무시할 신호이지,
   * 예외를 던질 오류가 아니다. */
  appendTurn(
    id: string,
    turn: { question: string; answer: string; status: ConversationTurnStatus; citationCount: number },
  ): ConversationRecord | null {
    const all = this.readAll();
    const index = all.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const now = new Date().toISOString();
    const record = all[index];
    const turnRecord: ConversationTurnRecord = {
      id: crypto.randomUUID(),
      question: turn.question,
      answer: turn.answer,
      status: turn.status,
      citationCount: turn.citationCount,
      createdAt: now,
    };
    const updated: ConversationRecord = {
      ...record,
      title: record.turns.length === 0 ? titleFromQuestion(turn.question) : record.title,
      updatedAt: now,
      turns: [...record.turns, turnRecord],
    };
    all[index] = updated;
    this.save(all);
    return updated;
  }

  /** CLAUDE.md: 폐기(삭제)는 확인과 사유를 요구한다 — `reason`이 비어 있으면
   * 저장하지 않고 실패를 반환한다(렌더러의 `ReasonConfirmDialog`가 이미
   * 빈 사유를 막지만, `assets:remove`와 동일하게 여기서도 다시 검증하는
   * 방어적 이중 검사). */
  remove(id: string, reason: string): { ok: boolean; error: string | null } {
    if (!reason || !reason.trim()) {
      return { ok: false, error: "삭제 사유를 입력해야 합니다." };
    }
    const all = this.readAll();
    const exists = all.some((r) => r.id === id);
    if (!exists) {
      return { ok: false, error: "대화를 찾을 수 없습니다." };
    }
    this.save(all.filter((r) => r.id !== id));
    return { ok: true, error: null };
  }
}
