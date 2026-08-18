---
name: architecture-design-patterns
description: >
  Apply maintainable software architecture and design patterns when implementing,
  modifying, or refactoring code. Use this skill when adding features, introducing
  integrations, changing business logic, or when code structure is becoming complex.
---

# Architecture & Design Patterns

Design code so that future changes can be made locally without breaking unrelated behavior.

The goal is NOT to use as many design patterns as possible.

Prefer the simplest architecture that provides:
- clear responsibility boundaries
- low coupling
- high cohesion
- replaceable implementations
- testability
- predictable dependency direction

## Core Principle

Before modifying code:

1. Understand the existing architecture.
2. Identify the responsibility being changed.
3. Identify the smallest reasonable change boundary.
4. Check whether an existing abstraction already owns that responsibility.
5. Introduce a design pattern only when it solves an actual structural problem.
6. Avoid unnecessary abstraction.

Never introduce a pattern merely because it is listed in this skill.

---

# Preferred Architecture

For application code, prefer separation such as:

UI / API
    ↓
Application / Service
    ↓
Domain
    ↓
Repository / Adapter
    ↓
Infrastructure

Dependencies should generally point toward business logic.

Avoid:

UI → Database

Controller → LLM SDK

Business Logic → Vendor SDK

Domain → Framework-specific implementation

---

# Pattern Selection

## Strategy

Use when multiple algorithms or policies implement the same responsibility.

Examples:

ChunkingStrategy
├── FixedChunking
├── RecursiveChunking
└── SemanticChunking

RetrieverStrategy
├── VectorRetriever
├── HybridRetriever
└── MultiQueryRetriever

Prefer Strategy when you expect implementations to be selectable or replaceable.

---

## Adapter

Use when integrating external systems or vendor-specific APIs.

Examples:

LLMProvider
├── OllamaAdapter
├── OpenAIAdapter
└── ClaudeAdapter

DatabaseClient
├── OracleAdapter
└── PostgreSQLAdapter

External SDK objects should not leak unnecessarily into domain logic.

---

## Repository

Use when business logic needs persistence but should not depend on storage technology.

Examples:

DocumentRepository
VectorRepository
AssetRepository

Implementations may use:

Oracle
PostgreSQL
Chroma
OpenSearch
Filesystem

Business logic should depend on repository interfaces rather than storage implementations.

---

## Facade / Application Service

Use when callers would otherwise need to understand several internal components.

Example:

RAGService.answer()

internally coordinates:

QueryRewriter
Retriever
Reranker
PromptBuilder
LLMProvider

Expose a small, stable API while keeping orchestration internal.

---

## Factory

Use when object construction depends on configuration or runtime selection.

Example:

create_retriever(config)

may construct:

VectorRetriever
HybridRetriever
AgenticRetriever

Do not scatter implementation-selection logic across the codebase.

---

## State / State Machine

Use when behavior depends on explicit workflow state.

Especially useful for:

agents
LangGraph workflows
approval processes
document pipelines
multi-step processing

Example:

RECEIVED
→ ANALYZING
→ TOOL_EXECUTION
→ VALIDATING
→ COMPLETED

Make transitions explicit.

---

## Dependency Injection

Prefer injecting dependencies instead of constructing infrastructure deep inside business logic.

Avoid:

class RagService:
    def __init__(self):
        self.llm = Ollama(...)

Prefer:

class RagService:
    def __init__(self, llm: LLMProvider):
        self.llm = llm

This makes implementations replaceable and testable.

---

# SOLID Guidance

Apply SOLID pragmatically.

## Single Responsibility

A module should have one primary reason to change.

Avoid classes that simultaneously:

- access databases
- call LLMs
- parse files
- construct prompts
- implement business rules

Split responsibilities when they evolve independently.

## Open/Closed

Prefer adding implementations rather than repeatedly modifying large conditional blocks.

Avoid:

if strategy == "vector":
...
elif strategy == "hybrid":
...
elif strategy == "agentic":
...

Prefer a common strategy interface.

## Dependency Inversion

High-level business logic should depend on abstractions.

Prefer:

Service → LLMProvider → OllamaAdapter

instead of:

Service → Ollama SDK

---

# Feature Implementation Workflow

Whenever implementing a feature:

## Step 1 — Inspect

Determine:

- affected modules
- existing abstractions
- dependency direction
- current conventions
- tests covering the behavior

Do not start coding before understanding the relevant structure.

## Step 2 — Classify the Change

Determine whether the change is primarily:

- new business behavior
- new algorithm
- new external integration
- new persistence mechanism
- new workflow/state
- orchestration
- UI/API behavior

## Step 3 — Select Architecture

Consider:

Algorithm variation
→ Strategy

External system
→ Adapter

Persistence
→ Repository

Complex subsystem
→ Facade

Object creation
→ Factory

Workflow lifecycle
→ State

Dependency replacement/testing
→ Dependency Injection

If none are needed, implement the feature directly.

## Step 4 — Minimize Change Surface

Prefer:

new implementation
+ registration/configuration

over:

large modification of existing stable code.

Avoid unrelated refactoring while implementing a feature.

## Step 5 — Implement

Follow existing project conventions.

Preserve public interfaces unless changing them is necessary.

Keep domain logic independent from frameworks where practical.

## Step 6 — Verify

Check:

- Did coupling increase?
- Did responsibilities become mixed?
- Did vendor-specific code leak into domain logic?
- Is implementation selection duplicated?
- Are conditionals growing because an abstraction is missing?
- Can the new component be tested independently?
- Can the implementation be replaced without rewriting callers?

---

# Vibe Coding Guardrails

AI-generated code tends to accumulate structural debt quickly.

Therefore:

DO NOT create large god classes.

DO NOT place all logic in controllers or API handlers.

DO NOT mix infrastructure and business logic without a clear reason.

DO NOT introduce duplicate implementations.

DO NOT create abstractions with only hypothetical future value.

DO NOT rewrite working modules unnecessarily.

DO NOT introduce a new framework when a small module is sufficient.

DO NOT create interfaces for every class.

DO NOT force design patterns where simple functions are clearer.

Prefer small, composable modules.

---

# Refactoring Signals

Consider refactoring when:

- a file becomes responsible for unrelated concerns
- the same conditional logic appears repeatedly
- external SDK calls appear throughout business logic
- testing requires excessive mocking
- adding one feature requires editing many unrelated files
- implementation-specific details leak across layers
- constructors create many infrastructure dependencies
- workflows contain deeply nested conditionals

Explain the structural problem before performing a significant refactor.

---

# Architecture Decision Output

For meaningful architectural changes, briefly report:

Architecture decision:
<what was chosen>

Pattern:
<pattern or "none">

Reason:
<why this is the simplest appropriate structure>

Files affected:
<important files>

Tradeoff:
<main cost or limitation>

Do not produce a long architecture essay unless requested.

---

# Final Rule

Optimize for:

CHANGEABILITY

A good architecture allows the next feature to be implemented by changing the smallest possible part of the system.

---

# 이 저장소에서의 적용 (Enterprise AI Asset Hub)

위 원칙은 일반론이다. 이 저장소에서는 아래가 이미 그 원칙의 **구체적 구현**이므로,
새로 만들지 말고 그것을 사용한다. 충돌하면 루트 `CLAUDE.md`와 각 모듈
`CLAUDE.md`가 우선한다.

## 계층 대응

| 위 문서의 계층 | 이 저장소 |
|---|---|
| UI / API | `apps/portal-web`(M01), `apps/desktop-client` 렌더러(M04), 각 FastAPI `main.py`/`routers/` |
| Application / Service | `agent_runtime.workflow.run_knowledge_chat`, `portal_api.routers.*`가 호출하는 서비스 계층 |
| Domain | Python Domain Model (API Model과 분리 — 루트 `CLAUDE.md` 코드 규칙) |
| Repository / Adapter | `agent_runtime/adapters/*`, `search_runtime/local_index_registry.py`, `installed-assets-store.ts` 류의 Store |
| Infrastructure | Chroma, Ollama, SQLite/Alembic, 파일시스템 |

## 이미 존재하는 추상화 — 새로 만들지 말 것

- **Adapter**: `services/agent-runtime/src/agent_runtime/adapters/__init__.py`의 ABC 6종
  (`LLMAdapter`, `KnowledgeAdapter`, `HubSearchAdapter`, `MCPAdapter`,
  `DeploymentResolver`, `AssetRegistryResolver`). 외부 시스템 호출을 추가한다면
  거의 항상 여기에 구현체를 하나 더 붙이는 일이지, 새 추상화를 만드는 일이 아니다.
  루트 `CLAUDE.md`가 요구하는 "Provider/Vector Store/MCP Connector는 Adapter
  Interface 뒤에 둔다"가 바로 이것이다.
- **Dependency Injection**: agent-runtime은 FastAPI `app.dependency_overrides`로
  Adapter를 주입한다(`tests/integration/agent_runtime/conftest.py`가 Fake 6종을
  이 경로로 넣기 때문에 실 서비스 없이 테스트가 돈다). 새 외부 의존성을
  Workflow 안에서 직접 생성하면 이 테스트 구조가 깨진다.
- **State Machine**: `agent_runtime/workflow.py`의
  INPUT_VALIDATE → PREPARE → ANALYZE → KNOWLEDGE_SEARCH → (Hub 조회)
  → TOOL_CONFIRM → MCP_TOOL_CALL → ANSWER_GENERATE → OUTPUT_VALIDATE → COMPLETE.
  새 단계/상태를 넣으면 `run_store.TERMINAL_STATUSES`와
  `routers/chat.py`의 `_INTERNAL_TO_HOSTED_EVENT`를 함께 갱신한다.
- **Store(=Repository)**: Desktop의 `installed-assets-store.ts`,
  `active-version-store.ts`, `conversation-store.ts`, `portal-settings.ts`.
  파일 레이아웃을 아는 코드는 Store 안에만 둔다 — 화면이 JSON 구조를 직접 읽지 않는다.

## 이 저장소에서 "의존성 방향"은 모듈 경계로 강제된다

루트 `CLAUDE.md` 구현 원칙 2·3이 이 문서의 Dependency Inversion보다 강하다:

- **모듈 간 내부 폴더 직접 Import 금지.** M04가 M05/M08의 파일을 읽거나 쓰는
  "빠른 해결"은 이 저장소에서는 아키텍처 위반이다.
- 다른 모듈의 기능이 필요하면 **공개 계약(HTTP API 또는 `packages/schemas`)을
  먼저 만든다.** 계약이 코드보다 먼저다(구현 원칙 1).
- 같은 이유로 의도적 코드 중복이 존재한다 — 예: `bm25_store.py`/
  `chroma_client_cache.py`가 M07과 M08에 각각 복제되어 있다. 이것을 "중복
  제거"로 합치는 리팩터링은 모듈 경계를 깨는 일이므로 하지 않는다.

**적용 예 (D-079, 2026-08-13)**: Desktop이 설치한 Knowledge를 search-runtime이
검색하게 만들어야 했다. 가장 짧은 코드는 M04가 M08의 `INDEX_BASE` 트리에
직접 파일을 쓰는 것이지만, 그것은 경계 위반이다. 대신
`packages/schemas/api/knowledge-local-index.schema.json`으로 계약을 먼저 쓰고,
M08에 `local_index_registry.py`(Repository)와 `POST/DELETE /search/v1/local-indexes`
(공개 API)를 두고, M04는 그 API만 호출한다. 등록을 받아들일지는 M08이 자기
정책으로 판단한다.

## 패턴보다 먼저 지켜야 하는 이 저장소의 규칙

1. **거절은 조용할 수 없다.** 검색 결과 0건과 "이 색인은 검색할 수 없음"은
   반드시 구분되어야 한다(D-036/D-054/D-079). 실패를 빈 결과로 흡수하는 설계는
   아무리 단순해도 이 저장소에서는 틀린 설계다.
2. **근거 없는 상태를 만들지 않는다(fail-closed).** 값이 없으면 추측하지 말고
   "확인 불가"로 남긴다 — `assetVersionId`가 없을 때 `assetId`로 대체하지 않는
   D-060, 분류 메타데이터가 없으면 아무에게도 보이지 않는 D-062가 그 예다.
3. **수치·정책은 설정으로 둔다.** 타임아웃·임계값·허용 Origin을 코드 리터럴로
   박지 않는다(`config.py`/`settings.py`). 한 번 CORS를 하드코딩해 설정이
   무시된 사고가 있었다.
4. **5가지 상태를 함께 구현한다** — Loading, Empty, Error, Permission,
   Cancellation. 정상 흐름만 있는 화면은 미완성이다.
5. **테스트 증거 없는 기능은 완료가 아니다.** 그리고 Desktop에는 React 렌더링
   테스트가 없으므로(vitest `environment: "node"`) 화면 변경은 통과한 테스트로
   증명되지 않는다 — 직접 띄워 확인한 것과 확인하지 못한 것을 구분해 보고한다.
