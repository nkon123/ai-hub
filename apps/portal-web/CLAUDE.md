# Portal Web (M01)

Portal UI. Next.js 14.2.3 App Router, 포트 3000(`next dev --port 3000`). 자산 카탈로그, 등록·검토·수명주기 화면, Service Composer, Knowledge 챗봇 Quick Create/Preview/게시, Hosted Chat 화면을 담당한다. 권한 판정·파일 저장·Manifest 검증은 하지 않고 portal-api(M02)/agent-runtime(M05) 응답을 그대로 그린다.

## 먼저 읽을 것

- `docs/implementation-spec/01-portal-and-distribution.md` §1(M01 책임), §1.2(화면 공통 규칙), §1.3(P00~P23 화면 목록), §2(화면별 기능 정의)
- `docs/implementation-spec/08-service-composer.md` — `/services/new` Wizard 전 구간
- `docs/implementation-spec/10-hosted-chatbot-publication.md` — `/chatbots/new`, `/chat/[slug]`
- `packages/schemas/api/portal-openapi.yaml`

## 코드 배치

- 라우트는 `app/` 아래 App Router 디렉터리 하나당 화면 하나: `assets`(P02~P06), `assets/new/[type]`(P05 Wizard), `my/assets`(P07), `reviews`/`reviews/[id]`(P08/P09), `downloads`(P13), `knowledge/new`·`knowledge/[assetId]/quality`(P12), `chatbots/new`(P20~P22 Quick Create, `_components`에 Step*.tsx), `chat/[slug]`(P23 게시된 Hosted Chat), `services`/`services/new`(P17/P18, `_components`에 Step*.tsx)/`services/[versionId]`(P19), `deployments`/`deployments/[id]`, `distributions`/`distributions/new`/`distributions/[id]`(P10/P11), `audit`(P14), `admin/lifecycle`(P16), `admin/settings`(P15).
- 좌측 Nav는 `app/_components/nav-links.tsx`가 소유한다. `TOP_LEVEL_LINKS`(Home/자산 카탈로그/자산 등록/내 자산)와 `NAV_SECTIONS`(지식/에이전트/서비스/거버넌스) 배열만 수정한다 — 실제 화면이 없는 예정 항목은 추가하지 않는다(기존 주석 참고).
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

## 이 모듈에서 반복해서 틀렸던 것

- live dev 서버(포트 3000)가 떠 있는 상태에서 `next build`를 돌리면 `.next` 캐시가 깨진다 — dev 서버를 껐다 다시 켜야 한다. 작업 중에는 `next build`를 실행하지 말고 `typecheck`로 대체한다.

## 완료 전 확인

- 새 화면이 `ui.tsx`의 기존 프리미티브만 쓰고 새 버튼/카드/배지 스타일을 만들지 않았는가.
- API 호출이 `NEXT_PUBLIC_API_BASE`/`NEXT_PUBLIC_AGENT_RUNTIME_BASE` 패턴을 따르는가(상대경로 `/api/...` 신규 사용 금지).
- Nav에 항목을 추가했다면 그 라우트에 실제 화면이 존재하는가(예정 항목을 비활성 표시 없이 추가하지 않았는가).
- Loading/Empty/Error/Permission/Cancellation 상태를 `ui.tsx`의 `LoadingState`/`EmptyState`/`ErrorBanner`로 구현했는가, 오류 배너에 `trace_id`를 노출하는가.
- 승인·반려·중단·폐기 액션에 `ReasonDialog`(사유 필수)를 사용했는가.
