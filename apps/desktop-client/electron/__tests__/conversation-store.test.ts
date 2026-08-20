import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../conversation-store";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-conversation-"));
  stateDir = path.join(tmpRoot, "state");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ConversationStore", () => {
  it("returns an empty list when nothing has been saved yet", () => {
    const store = new ConversationStore(stateDir);
    expect(store.list()).toEqual([]);
  });

  it("creates a conversation with a placeholder title until the first turn lands", () => {
    const store = new ConversationStore(stateDir);
    const record = store.create("know-1", "재택근무 정책 v1.0.0");
    expect(record.title).toBe("새 대화");
    expect(record.turns).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("derives the list title from the first turn's question, truncated", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "재택근무 정책 v1.0.0");
    store.appendTurn(created.id, {
      question: "재택근무는 주 며칠까지 가능한가요? 그리고 신청 절차는 어떻게 되는지 자세히 알려주세요",
      answer: "주 최대 2일까지 가능합니다.",
      status: "succeeded",
      citationCount: 2,
    });
    const summary = store.list()[0];
    expect(summary.title.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(summary.title.endsWith("…")).toBe(true);
    expect(summary.title.startsWith("재택근무는 주 며칠까지 가능한가요?")).toBe(true);
  });

  it("keeps the title fixed after the first turn even as more turns are appended", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "label");
    store.appendTurn(created.id, {
      question: "첫 질문",
      answer: "첫 답변",
      status: "succeeded",
      citationCount: 1,
    });
    store.appendTurn(created.id, {
      question: "두 번째, 완전히 다른 질문",
      answer: "두 번째 답변",
      status: "succeeded",
      citationCount: 1,
    });
    expect(store.get(created.id)?.title).toBe("첫 질문");
    expect(store.get(created.id)?.turns).toHaveLength(2);
  });

  it("appendTurn on an unknown conversation id returns null rather than throwing", () => {
    const store = new ConversationStore(stateDir);
    expect(store.appendTurn("does-not-exist", { question: "q", answer: "a", status: "succeeded", citationCount: 0 })).toBeNull();
  });

  it("persists turns across a fresh instance reading the same state dir", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "label");
    store.appendTurn(created.id, { question: "q1", answer: "a1", status: "succeeded", citationCount: 1 });

    const reopened = new ConversationStore(stateDir);
    const record = reopened.get(created.id);
    expect(record?.turns).toHaveLength(1);
    expect(record?.turns[0].question).toBe("q1");
    expect(record?.turns[0].answer).toBe("a1");
  });

  it("list() sorts by most recently updated first (ties broken by write order, not clock resolution)", () => {
    const store = new ConversationStore(stateDir);
    const older = store.create("know-1", "label");
    store.appendTurn(older.id, { question: "q", answer: "a", status: "succeeded", citationCount: 0 });
    const newer = store.create("know-1", "label");
    store.appendTurn(newer.id, { question: "q2", answer: "a2", status: "succeeded", citationCount: 0 });

    const ids = store.list().map((c) => c.id);
    expect(ids[0]).toBe(newer.id);
    expect(ids[1]).toBe(older.id);
  });

  it("remove() requires a non-empty reason (CLAUDE.md: 폐기는 확인과 사유를 요구한다)", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "label");
    expect(store.remove(created.id, "")).toEqual({ ok: false, error: "삭제 사유를 입력해야 합니다." });
    expect(store.remove(created.id, "   ")).toEqual({ ok: false, error: "삭제 사유를 입력해야 합니다." });
    expect(store.get(created.id)).not.toBeNull(); // not deleted
  });

  it("remove() deletes the conversation when given a reason", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "label");
    const result = store.remove(created.id, "더 이상 필요하지 않음");
    expect(result).toEqual({ ok: true, error: null });
    expect(store.get(created.id)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("remove() on an unknown id fails without touching other conversations", () => {
    const store = new ConversationStore(stateDir);
    const created = store.create("know-1", "label");
    const result = store.remove("does-not-exist", "사유");
    expect(result).toEqual({ ok: false, error: "대화를 찾을 수 없습니다." });
    expect(store.get(created.id)).not.toBeNull();
  });

  it("treats a corrupted state file as 'no conversations' rather than crashing", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "conversations.json"), "{ not valid json");
    const store = new ConversationStore(stateDir);
    expect(store.list()).toEqual([]);
    expect(store.get("anything")).toBeNull();
  });

  it("keeps distinct conversations for the same Knowledge independent", () => {
    const store = new ConversationStore(stateDir);
    const a = store.create("know-1", "label");
    const b = store.create("know-1", "label");
    store.appendTurn(a.id, { question: "a-question", answer: "a-answer", status: "succeeded", citationCount: 1 });
    expect(store.get(a.id)?.turns).toHaveLength(1);
    expect(store.get(b.id)?.turns).toHaveLength(0);
  });

  // 실사용 제보(2026-08-19) 요구 1 — Tool 실행 기록.
  describe("toolExecutions (실사용 제보 요구 1)", () => {
    it("a turn with no toolExecutions argument persists as an empty array", () => {
      const store = new ConversationStore(stateDir);
      const created = store.create("know-1", "label");
      store.appendTurn(created.id, { question: "q", answer: "a", status: "succeeded", citationCount: 0 });
      expect(store.get(created.id)?.turns[0].toolExecutions).toEqual([]);
    });

    it("persists Tool name/args/result and route, and restores them from a fresh instance", () => {
      const store = new ConversationStore(stateDir);
      const created = store.create("know-1", "label");
      store.appendTurn(created.id, {
        question: "q",
        answer: "a",
        status: "succeeded",
        citationCount: 0,
        toolExecutions: [
          {
            toolName: "list_files",
            args: { path: "/tmp" },
            resultSummary: "파일 3개",
            failureReason: null,
            route: "user_selected",
          },
        ],
      });
      const reopened = new ConversationStore(stateDir);
      const turn = reopened.get(created.id)?.turns[0];
      expect(turn?.toolExecutions).toEqual([
        { toolName: "list_files", args: { path: "/tmp" }, resultSummary: "파일 3개", failureReason: null, route: "user_selected" },
      ]);
    });

    it("truncates an overly long resultSummary/failureReason rather than storing the full text", () => {
      const store = new ConversationStore(stateDir);
      const created = store.create("know-1", "label");
      const longText = "x".repeat(500);
      store.appendTurn(created.id, {
        question: "q",
        answer: "a",
        status: "failed",
        citationCount: 0,
        toolExecutions: [
          { toolName: "t", args: null, resultSummary: null, failureReason: longText, route: "mcp_tool" },
        ],
      });
      const stored = store.get(created.id)!.turns[0].toolExecutions[0];
      expect(stored.failureReason!.length).toBeLessThanOrEqual(241); // 240 chars + ellipsis
      expect(stored.failureReason!.endsWith("…")).toBe(true);
    });

    it("a legacy conversation file written before this field existed normalizes to an empty array, not a crash", () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const legacy = [
        {
          id: "conv-1",
          knowledgeId: "know-1",
          knowledgeLabel: "label",
          title: "새 대화",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          turns: [
            {
              id: "turn-1",
              question: "q",
              answer: "a",
              status: "succeeded",
              citationCount: 0,
              createdAt: "2026-08-01T00:00:00.000Z",
              // toolExecutions 필드 자체가 없다(이 필드 도입 이전 파일).
            },
          ],
        },
      ];
      fs.writeFileSync(path.join(stateDir, "conversations.json"), JSON.stringify(legacy));
      const store = new ConversationStore(stateDir);
      expect(store.get("conv-1")?.turns[0].toolExecutions).toEqual([]);
      expect(store.list()).toHaveLength(1);
    });
  });

  // 실사용 제보(2026-08-19, 2026-08-20 후속) — "로컬 Tool 자동 라우팅이
  // 생기면서 기존 대화가 없어진다": 자동 라우팅으로 보낸 질문 중 어떤
  // Tool도 실행되지 않은 턴("no_action")도 저장소가 그대로 받아들이고,
  // 재시작(새 인스턴스)에서도 질문과 사유가 남아야 한다.
  describe("no_action status (실사용 제보 2026-08-20 — 자동 라우팅이 아무 Tool도 실행하지 않은 턴)", () => {
    it("persists a no_action turn with an empty toolExecutions and restores it from a fresh instance", () => {
      const store = new ConversationStore(stateDir);
      const created = store.create("know-1", "label");
      store.appendTurn(created.id, {
        question: "오늘 날씨 어때?",
        answer: "이 질문에는 등록된 로컬 Tool 중 어느 것도 필요하지 않다고 판단해 아무것도 실행하지 않았습니다.",
        status: "no_action",
        citationCount: 0,
        toolExecutions: [],
      });
      const reopened = new ConversationStore(stateDir);
      const turn = reopened.get(created.id)?.turns[0];
      expect(turn?.question).toBe("오늘 날씨 어때?");
      expect(turn?.status).toBe("no_action");
      expect(turn?.answer).toContain("필요하지 않다고 판단");
      expect(turn?.toolExecutions).toEqual([]);
    });

    it("a no_action turn still becomes the conversation's list title (the question is never dropped)", () => {
      const store = new ConversationStore(stateDir);
      const created = store.create("know-1", "label");
      store.appendTurn(created.id, {
        question: "오늘 날씨 어때?",
        answer: "아무것도 실행하지 않았습니다.",
        status: "no_action",
        citationCount: 0,
        toolExecutions: [],
      });
      expect(store.list()[0].title).toBe("오늘 날씨 어때?");
    });
  });
});
