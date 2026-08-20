---
name: verify-change
description: >
  Verify a code change in this repository before reporting it done, and report
  honestly what was and was not verified. Use when finishing an implementation,
  before committing, when asked "is it done / does it pass", when comparing test
  counts against a baseline, or when a regression test needs to be proven to
  actually catch the bug it claims to catch.
---

# 변경 검증

목표는 "테스트가 초록불인가"가 아니라 **"제품이 사용자에게 거짓을 말하지 않는가"** 다.
이 저장소의 반복 실패는 전부 같은 모양이었다 — 크래시도 타입 오류도 아니고,
초록불인데 화면이 거짓말을 하는 것.

## 1. 시작 전에 기준선을 찍는다

```bash
node scripts/agent/verify-change.mjs --suites <a,b> --save-baseline .agent-baseline.json
```

**이걸 빼먹으면 나중에 증가분이 내 것인지 알 수 없다.** 이 저장소에는 다른
세션의 미커밋 변경이 상시 존재해 왔다(`packages/evaluation-runner` 등). 루트
`pytest` 절대값은 내 변경에 대해 아무것도 증명하지 못한다.

스위트: `python` `desktop` `ruff` `contract` `typecheck-desktop` `typecheck-portal-web` `all`

## 2. 작업 후 같은 스위트를 기준선과 비교한다

```bash
node scripts/agent/verify-change.mjs --suites <a,b> --baseline .agent-baseline.json
```

압축 JSON 한 줄이 나온다. 읽는 법:

- **`d`(delta)가 내가 추가한 테스트 수와 정확히 일치하는가.** 크면 다른 변경이
  섞였다는 뜻이다. "대충 늘었으니 됐다"로 넘어가지 마라.
- **종료 코드 3은 파싱 실패다.** 명령이 아예 안 돌았거나 출력 형식이 바뀐 것이다.
  숫자를 못 찾았는데 "통과"라고 보고하지 마라.
- `failed` / `parseFailed` 키는 압축 출력에서도 절대 생략되지 않는다.

## 3. 커밋 범위를 눈으로 확인한다

```bash
git status --short
```

`git add -A` 를 쓰지 마라. **경로를 명시적으로 지정한다**(`git add apps/desktop-client/`).
다른 세션의 미완성 작업이 섞여 `main` 으로 올라가는 사고가 실제로 가능하다.

## 4. 버그를 고쳤다면, 테스트가 정말 무는지 확인한다

수정을 임시로 되돌리고 그 테스트가 **실패하는지** 본 뒤 복원한다.

이 세션에서 실제로 무효한 테스트를 한 번 잡았다: `sys.modules` 등록 누락을
`get_type_hints(함수)`로 재현하려 했는데 그건 `func.__globals__`를 쓰므로
**수정 없이도 통과**했다. 클래스 + `from __future__ import annotations` 조합으로
바꾸고 나서야 물었다. 통과하는 회귀 테스트가 반드시 유효한 것은 아니다.

## 5. 검증하지 못한 것을 명시적으로 보고한다

통과한 것과 **하지 않은 것**을 나눠 쓴다. 이 저장소에서 테스트가 증명하지 **못하는** 것:

- **화면**. `vitest.config.ts` 가 `environment: "node"` 라 렌더링 테스트가 아예 없다.
  Electron 셸을 띄우지 않았으면 UI 는 미검증이다 — "테스트 통과"로 대신하지 마라.
- **빌드 산출물**. `preload.ts` → `dist/electron/preload.js` 처럼 빌드 단계가 있으면
  재빌드하고 산출물에 실제로 들어갔는지 확인한다(가정하지 말고 grep).
- **돌고 있는 프로세스**. 오래 뜬 서비스는 내 새 코드가 아닐 수 있다.
  `/health` 의 `build_version`/`commit_sha` 가 그 확인용이다.
- **문구의 진실성**. 기능을 추가하면 **그 기능의 부재를 설명하던 기존 문구가 거짓이 된다.**
  이 세션에서만 5번 발생했다(P15 "업로드 제한 없음", 내보내기 화면 "Portal 로 전송하지
  않습니다", 자동 라우팅 "매번 승인을 거칩니다", `conversation-store` "같은 상한 240자",
  README "파일당 함수 하나"). 바꾼 동작을 설명하던 주석·UI 문구·문서를 함께 찾아라.

## 하지 말 것

- 숫자를 추정해서 보고하지 마라. 실측값만 쓴다.
- 통과하지 못한 것을 통과했다고 쓰지 마라. 못 한 것은 "미검증"으로 남긴다.
- 다른 세션의 변경을 stash/revert 하지 마라.
