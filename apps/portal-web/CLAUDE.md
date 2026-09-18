# Portal Web (M01)

Portal UI. Next.js 14.2.3 App Router, 포트 3000(`next dev --port 3000`). 자산 카탈로그, 등록·검토·수명주기 화면, Service Composer, Knowledge 챗봇 Quick Create/Preview/게시, Hosted Chat 화면을 담당한다. 권한 판정·파일 저장·Manifest 검증은 하지 않고 portal-api(M02)/agent-runtime(M05) 응답을 그대로 그린다.

## 먼저 읽을 것

- `docs/implementation-spec/01-portal-and-distribution.md` §1(M01 책임), §1.2(화면 공통 규칙), §1.3(P00~P23 화면 목록), §2(화면별 기능 정의)
- `docs/implementation-spec/08-service-composer.md` — `/services/new` Wizard 전 구간
- `docs/implementation-spec/10-hosted-chatbot-publication.md` — `/chatbots/new`, `/chat/[slug]`
- `packages/schemas/api/portal-openapi.yaml`

## 코드 배치

- 라우트는 `app/` 아래 App Router 디렉터리 하나당 화면 하나: `assets`(P02~P06, 전체 카탈로그), `assets/knowledge`·`assets/prompts`·`assets/mcp`(유형별 목록 — 좌측 "자산" 섹션. `assets/[id]` 와 같은 단계의 **정적** 세그먼트라 같은 이름의 자산 id 를 가린다), `assets/new/[type]`(P05 Wizard), `my/assets`(P07), `reviews`/`reviews/[id]`(P08/P09), `downloads`(P13), `knowledge/new`·`knowledge/[assetId]/quality`(P12), `chatbots/new`(P20~P22 Quick Create, `_components`에 Step*.tsx), `chat/[slug]`(P23 게시된 Hosted Chat), `services`/`services/new`(P17/P18, `_components`에 Step*.tsx)/`services/[versionId]`(P19), `deployments`/`deployments/[id]`, `distributions`/`distributions/new`/`distributions/[id]`(P10/P11), `audit`(P14), `admin/lifecycle`(P16), `admin/settings`(P15).
- 좌측 Nav는 `app/_components/nav-links.tsx`가 소유한다. `NAV_SECTIONS`(자산/운영/거버넌스) 배열만 수정한다(최상위 항목은 없다 — 모든 항목이 섹션에 속한다) — 실제 화면이 없는 예정 항목은 추가하지 않는다(기존 주석 참고). 홈(`/`)·전체 카탈로그(`/assets`)·자산 유형 선택(`/assets/new`)은 **의도적으로** Nav에 없다(각각 좌상단 타이틀 링크, 유형별 목록, 유형별 등록 버튼이 대신한다 — 화면은 모두 살아 있다). 이유는 `nav-links.tsx` 주석에 있다.
- 메뉴는 "무엇이 있는가"(목록)만 가리키고 "무엇을 만드는가"(등록·생성)는 각 목록 화면 **우상단 버튼**에 둔다 — 같은 등록 화면을 메뉴와 화면 양쪽에 두지 않는다("지식 등록"·"챗봇 만들기" 단독 섹션을 없앤 이유). `/services`(자산 > 서비스)가 챗봇 만들기·에이전트 만들기·AI Service 만들기 셋을 함께 갖는 것도 같은 규칙이다.
- 유형별 자산 목록 3개 화면의 본체는 `app/_components/asset-type-page.tsx`(조회·검색·Loading/Empty/Error/Permission) 하나이고, 각 `app/assets/<유형>/page.tsx` 는 제목·type 목록·등록 버튼만 넘기는 10줄짜리 설정이다. 자산 카드와 유형 메타(아이콘/라벨/색, 상세 이동 경로)는 `app/_components/asset-list.tsx` 가 단독 소유한다 — 전체 카탈로그도 이것을 쓴다. 유형을 하나 더 노출할 때 복사할 것은 `page.tsx` 쪽이다.
- Knowledge 색인·검색 전략 Preset은 `app/_components/knowledge-profiles.ts` 가 단독 소유한다 — `/knowledge/new`(신규 등록)와 지식 자산 상세의 "새 버전 만들기"(`app/assets/[id]/_components/new-version-form.tsx`, 재색인)가 같은 선택지·같은 숫자를 쓴다. 화면에 복사하지 않는다: 한쪽 숫자만 바뀌어도 이름은 그대로라 고른 전략과 실제 색인된 전략이 조용히 갈라진다.
- 공통 UI는 `app/_components/ui.tsx`(Button/Badge/StatusBadge/Card/PageHeader/EmptyState/LoadingState/ErrorBanner/FormField/Tabs/ReasonDialog/`inputClass`) 하나뿐이다. **새 화면에서 버튼·카드·배지·폼필드를 새로 만들지 말고 이 파일의 프리미티브를 재사용한다.** 승인/반려/중단/폐기 확인 Dialog는 `ReasonDialog`를 그대로 쓴다(사유 필수 입력이 내장돼 있음).
- 색상·타이포·radius 등 디자인 토큰은 `app/globals.css`의 Tailwind v4 `@theme` 블록 하나에서 정의한다. 별도 `tailwind.config.*` 파일은 없다 — 토큰 추가/변경은 여기서 한다.
- 인증은 실 로그인이 아니라 `app/_components/role-context.tsx`의 Test Identity Adapter(`ROLES` 배열, `dev-*-token`)다. portal-api의 `apps/portal-api/src/portal_api/auth.py`와 `userId`가 정확히 일치해야 한다.

## 이 모듈의 경계

- portal-api 호출은 두 패턴이 혼재한다: (a) 대다수 페이지는 `const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000"`로 직접 fetch, (b) `knowledge/new`, `chatbots/new/_components/StepKnowledge.tsx`, `assets/page.tsx`, `assets/new/[type]/page.tsx` 등 일부는 상대경로 `fetch("/api/v1/...")`를 쓰고 `next.config.mjs`의 `rewrites()`가 이를 **하드코딩된** `http://localhost:8000`으로 프록시한다. `NEXT_PUBLIC_API_BASE`를 바꿔도 (b) 패턴 호출은 여전히 localhost:8000으로 간다 — 새 코드는 (a) 패턴(`NEXT_PUBLIC_API_BASE` 사용)을 따른다.
- agent-runtime 직접 호출(Preview 실행, Hosted Chat)은 `NEXT_PUBLIC_AGENT_RUNTIME_BASE ?? "http://localhost:8100"`를 쓴다(`chat/[slug]/page.tsx`, `chatbots/new/_components/StepPreview.tsx`, `services/new/_components/StepPreview.tsx`). Portal API는 모델을 직접 호출하지 않는다는 루트 원칙이 이 두 Base 분리로 나타난다.
- `apps/desktop-client`, `apps/portal-api`의 내부 소스를 직접 import하지 않는다. 스키마 이름/필드는 `packages/schemas/api/portal-openapi.yaml`을 근거로 맞춘다(공유 타입 패키지는 아직 없음 — TS 타입은 각 페이지 파일에 로컬 정의).

## 실행

- `pnpm --filter portal-web dev` (= `make dev-portal-web`) — 포트 3000.
- portal-api(8000)가 먼저 떠 있어야 대부분 화면이 정상 동작한다. Preview/Hosted Chat 관련 화면은 agent-runtime(8100)도 필요하다.

## 테스트

- 이 모듈에는 유닛 테스트가 없다(`package.json`에 `test` 스크립트 없음, `.test.ts(x)` 파일 없음). 검증은 `pnpm --filter portal-web typecheck`와 `pnpm --filter portal-web lint`, 그리고 M12가 소유한 `tests/e2e/`(살아있는 스택 필요, 기본 실행에서 skip)로 이뤄진다.
- `pnpm --filter portal-web lint`는 `.eslintrc.json`(`next/core-web-vitals` 확장)이 있어야 대화형 설정 프롬프트 없이 끝까지 돈다. 2026-08-20 기준 이 명령은 종료 코드 0으로 통과하되 경고 8건을 남긴다: `react/no-unescaped-entities`(따옴표 미이스케이프, 3개 파일 6건 — `assets/new/[type]`·`knowledge/[assetId]/quality`·`services/[versionId]`. 여러 파일에 걸쳐 있어 규칙을 error에서 warn으로 낮췄다)와 `react-hooks/exhaustive-deps`(기존 코드의 의도적 의존성 생략으로 보이는 2건, `versions/page.tsx`·`distributions/[id]/page.tsx`). 새 코드가 이 경고를 늘리지 않는지 확인한다.

## 이 모듈에서 반복해서 틀렸던 것

- live dev 서버(포트 3000)가 떠 있는 상태에서 `next build`를 돌리면 `.next` 캐시가 깨진다 — dev 서버를 껐다 다시 켜야 한다. 작업 중에는 `next build`를 실행하지 말고 `typecheck`로 대체한다.

- **폴링 예산이 서버의 판정 예산보다 짧으면 그 화면은 결과를 표시할 수 없다(2026-09-17, `knowledge/new`).** 등록 화면의 색인 폴링은 `60회 × 3초 = 180초`였는데 portal-api가 색인 실패를 확정하는 예산은 300초였다. 즉 타임아웃으로 실패하는 작업은 **구조적으로** 이 화면에 절대 나타날 수 없었고, 루프가 끝나도 아무 상태를 바꾸지 않아 스피너와 "RUNNING..."이 영원히 남았다. 등록자는 다른 창을 띄워서야 FAILED를 알았다. 긴 Job의 상태를 폴링하는 화면을 만들 때: (1) 감시 예산을 서버 쪽 예산보다 **길게** 잡고 그 서버 설정 이름을 주석에 적는다(두 값은 저장소가 달라 코드로 묶이지 않는다), (2) 감시를 멈출 때 반드시 **멈췄다고 표시**한다 — 진행 중 표시를 남긴 채 조용히 끝내지 않는다, (3) 조회 실패를 Job 실패로 단정하지 않는다, (4) `useEffect`의 cleanup으로 취소한다(예전 루프는 페이지를 떠난 뒤에도 돌며 사라진 컴포넌트에 setState를 호출했다). 지금 `knowledge/new`는 이 네 가지를 `IndexingWatch` 상태 기계로 처리한다.

- **긴 작업을 화면이 붙잡고 기다리게 만들지 않는다.** 같은 변경에서 등록 화면은 "색인이 끝날 때까지 대기"에서 "등록됨 + 나중에 확인"으로 바뀌었다. 큰 문서는 색인에 수 분이 걸리고(실측 534초), 사용자가 탭을 붙잡고 있을 이유가 없다. 화면을 열어 둔 동안에는 상태를 따라가 완료/실패로 바뀌지만, 그것은 편의이지 전제가 아니다.

## 완료 전 확인

- 새 화면이 `ui.tsx`의 기존 프리미티브만 쓰고 새 버튼/카드/배지 스타일을 만들지 않았는가.
- API 호출이 `NEXT_PUBLIC_API_BASE`/`NEXT_PUBLIC_AGENT_RUNTIME_BASE` 패턴을 따르는가(상대경로 `/api/...` 신규 사용 금지).
- Nav에 항목을 추가했다면 그 라우트에 실제 화면이 존재하는가(예정 항목을 비활성 표시 없이 추가하지 않았는가).
- Loading/Empty/Error/Permission/Cancellation 상태를 `ui.tsx`의 `LoadingState`/`EmptyState`/`ErrorBanner`로 구현했는가, 오류 배너에 `trace_id`를 노출하는가.
- 승인·반려·중단·폐기 액션에 `ReasonDialog`(사유 필수)를 사용했는가.
