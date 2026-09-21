# MCP 서버 개발 프롬프트

ai-hub의 **자산 > MCP > MCP 서버 등록**에 통과하는 서버를 AI 코딩 도구로 만들기 위한 지시문이다.

아래 `복사 시작` ~ `복사 끝` 사이를 통째로 복사해 Claude Code, Cursor, ChatGPT 등에 붙여넣고,
맨 앞의 **「아이디어」** 항목만 채운다. 뒤쪽 제약사항은 손대지 않는다.

> 이 문서의 제약은 추측이 아니라 실제 코드에서 가져온 것이다. 출처는 문서 끝의
> [근거](#근거)에 파일·줄 단위로 적었다. 스키마나 정책이 바뀌면 이 문서도 같이 고쳐야 한다.

---

## 복사 시작

당신은 사내 폐쇄망 플랫폼 **ai-hub**에 등록할 MCP(Model Context Protocol) 서버를 작성한다.

**아래 「아이디어」를 「제약사항」에 맞춰 개발해 주세요.**

---

# 아이디어

## 목적

<!-- 이 서버가 무엇을 해결하는가. 누가, 어떤 상황에서 아쉬워서 만드는가.
     예: 사내 위키에서 규정 문서를 찾을 때마다 검색창을 여러 번 오가야 한다. -->

## 흐름

<!-- 사용자가 챗봇에서 이 서버를 쓰는 과정을 순서대로. 말로 써도 된다.
     예:
       1. 사용자가 "연차 이월 규정 알려줘" 라고 묻는다
       2. 모델이 규정 검색 Tool 을 고른다
       3. 서버가 제목·요약·문서 링크를 돌려준다
       4. 모델이 그 내용으로 답한다 -->

## 제공할 기능

<!-- Tool 하나씩. 이름은 영문, 설명은 한국어로.
     예:
       - policy.search  — 규정을 키워드로 찾는다.  입력: keyword(필수), limit(선택)
                          출력: 제목, 요약, 문서 id
       - policy.get     — 문서 id 로 본문을 가져온다. 입력: doc_id(필수) -->

## 연결 대상과 데이터

<!-- 무엇에서 데이터를 가져오는가. 없으면 "없음 — 서버가 스스로 계산한다" 라고 쓴다.
     실제 접속 정보(주소·계정)는 여기 적지 말고, 무엇이 필요한지만 적는다.
     예: 사내 위키 읽기 전용 API. 인덱스는 이미 만들어져 있다. -->

## 기타

<!-- 소유 조직 / 작성자 / 그 밖에 알아야 할 것.
     예:
       - 소유 조직: miracom
       - 작성자: dev-user@miracom.com
       - 읽기 전용으로만 만든다. 쓰기 기능은 이번 범위가 아니다. -->

---

위 아이디어를 **아래 제약사항을 지켜** 개발해 주세요.

제약사항은 등록 API와 실행 런타임이 **실제로 검사**하는 것이다. 하나라도 어기면 등록이 거부되거나,
등록은 되고 실행만 조용히 실패한다. **아이디어와 제약사항이 충돌하면 제약사항이 우선이고,
무엇을 어떻게 바꿨는지 마지막에 한 줄로 알려 준다.**

아이디어에 빠진 것이 있으면 임의로 정하지 말고 **무엇이 필요한지 먼저 묻는다.** 다만 소유 조직이나
작성자처럼 사소한 값은 자리표시자(`<조직>`)로 두고 진행해도 된다.

# 제약사항

## 산출물

파일 두 개만 만든다.

1. `server.py` (또는 `server.js`) — MCP 서버 구현 **+ 터미널 점검 모드**(아래 참고)
2. `mcp-server-manifest.json` — 등록용 매니페스트

README나 설정 파일은 요청받지 않았다면 만들지 않는다. 점검 모드는 별도 파일이 아니라
진입점 파일 안에 둔다 — 파일이 늘면 업로드 목록과 검토 대상이 같이 늘어난다.

## 절대 하면 안 되는 것

| 금지 | 이유 | 어길 때 |
| --- | --- | --- |
| 런타임에 패키지 설치 (`pip install`, `npm install`, `npx`, `uvx`) | 폐쇄망이라 불가능하고, 실행 시점 코드 반입은 금지다 | 실행 실패 |
| 환경변수 읽기 (`os.environ`, `process.env`) | 서버 프로세스는 **`env={}`** 로 뜬다. 부모 환경을 물려받지 않는다 | 등록은 통과, 실행만 실패 |
| `PATH`에서 인터프리터 찾기 (`python`, `python3`, `node`) | 인터프리터 절대경로는 배포 설정에서 온다 | `interpreter_not_configured` |
| 셸 실행 (`shell=True`, `os.system`, `subprocess` 로 셸 문자열) | argv 배열만 쓴다. 셸 인용 규칙이 개입할 여지를 만들지 않는다 | 검토 반려 |
| 압축 파일로 제출 (`.zip`, `.tar`, `.gz` 등) | 중첩 압축은 검토자가 봐야 할 것을 가린다 | 업로드 거부 |
| `.pyc`, `.sh`, `.bat`, `.ps1`, `.exe`, `.dll` 포함 | 검토자가 읽을 수 없거나 진입점이 될 수 없다 | 업로드 거부 |
| 하드코딩된 비밀값·토큰·내부주소·개인정보 | 코드와 매니페스트 모두 검토 대상이다 | 검토 반려 |
| 매니페스트에 스키마에 없는 필드 추가 | 모든 객체가 `additionalProperties: false` 다 | `VALIDATION_ERROR` |

## 코드 제약 (STDIO 서버)

- 사용 가능한 것: **표준 라이브러리 + `mcp` SDK**. 그 외 의존성이 꼭 필요하면 번들 안에 함께
  넣어야 하고(vendoring), 매니페스트 `transport.vendored_dependencies`는 반드시 `true`다.
- 파일 개수 최대 **20개**, 파일당 최대 **50MB**, 전체 최대 **150MB**.
- 코드 파일 확장자는 **`.py` / `.js` / `.cjs` / `.mjs`** 만 허용된다.
- 진입점 파일은 **반드시 업로드 목록에 포함**되어야 한다. 매니페스트 `transport.entrypoint`와
  실제 파일명이 다르면 거부된다.
- 진입점 경로는 번들 루트 기준 **상대경로**다. 절대경로, `..`, 역슬래시, 드라이브 문자를 쓸 수 없다.
- 표준출력(stdout)은 JSON-RPC 채널이다. **`print()` 로 아무것도 찍지 않는다.** 로그가 필요하면
  stderr로 보낸다.

## 터미널 점검 인터페이스 (필수)

ai-hub 화면에서만 확인할 수 있는 서버는 만들지 않는다. **등록하기 전에, 그리고 문제가 생겼을 때
터미널에서 바로 확인할 수 있어야 한다.** 진입점 파일에 인자로 동작하는 점검 모드를 함께 구현한다.

최소 네 가지:

| 명령 | 하는 일 | 종료 코드 |
| --- | --- | --- |
| `<진입점> --check` | 매니페스트와 실제 `tools/list`가 일치하는지, 각 Tool 의 `input_schema` 가 올바른 JSON Schema 인지 검사하고 결과를 사람이 읽을 수 있게 출력 | 문제 없으면 `0`, 있으면 `1` |
| `<진입점> --list-tools` | Tool 이름·설명·입력 스키마를 표 또는 JSON 으로 출력 | `0` |
| `<진입점> --call <tool_name> --args '<JSON>'` | Tool 하나를 실제로 한 번 호출하고 결과를 출력 | 성공 `0`, 실패 `1` |
| `<진입점> --help` | 위 사용법 | `0` |

지켜야 할 것:

- **인자가 없을 때만 stdio 서버로 뜬다.** 점검 모드에서는 JSON-RPC 세션을 열지 않는다.
  이 구분이 없으면 stdout 에 섞인 점검 출력이 프로토콜을 깨뜨린다.
- 매니페스트 경로는 기본값을 **진입점과 같은 폴더의 `mcp-server-manifest.json`** 으로 하고,
  `--manifest <경로>` 로 바꿀 수 있게 한다.
- **`transport.args` 에는 점검용 플래그를 절대 넣지 않는다.** 거기 들어간 인자는 런타임이 서버를
  띄울 때 그대로 전달되므로, 서버가 뜨지 않고 점검만 하고 끝난다.
- 표준 라이브러리만 쓴다(`argparse`, `json`). 점검 기능 때문에 의존성을 늘리지 않는다.
- `--call` 은 매니페스트에 `risk_level: READ_ONLY` 로 선언된 Tool만 인자 없이 호출할 수 있게 한다.
  `WRITE` Tool 은 `--yes` 를 추가로 요구한다 — 터미널에서도 부작용은 확인을 거친다.
- 출력에 비밀값·내부 주소·개인정보를 넣지 않는다. 오류는 무엇을 고쳐야 하는지까지 말한다.
- **점검 모드 시작에서 출력 인코딩을 UTF-8 로 고정한다.** 배포 대상이 사내 Windows PC 라
  콘솔·파이프 기본 인코딩이 `cp949` 이고, 한국어를 그냥 `print` 하면 `UnicodeEncodeError` 로
  점검이 죽는다(예제에서 실제로 겪었다). 서버 모드는 건드리지 않는다 — 거기 stdout 은 SDK 것이다.

  ```python
  for stream in (sys.stdout, sys.stderr):
      try:
          stream.reconfigure(encoding="utf-8", errors="replace")
      except (AttributeError, ValueError):
          pass
  ```

`--check` 가 반드시 잡아야 하는 것(등록·실행에서 실제로 막히는 항목이다):

- `tools/list` 의 Tool 이름 집합이 매니페스트 `declared_tools` 와 다름 → `tools_snapshot_mismatch`
- `input_schema` 가 서로 다름 (같은 이름인데 스키마가 갈라진 경우)
- `transport.entrypoint` 가 실제 파일명과 다름
- `permissions.allowed_roles` 또는 `allowed_orgs` 가 비어 있음 (Default Deny 라 아무도 못 씀)
- `risk_level: WRITE` 인데 `confirmation_policy: NEVER`

## 매니페스트 규격

최상위 필수 필드 11개. 순서는 아래대로 쓴다.

```json
{
  "schema_version": "1.0",
  "id": "<새 UUID v4>",
  "type": "mcp_server",
  "name": "<128자 이내, 업무 목적이 드러나는 한국어 이름>",
  "version": "1.0.0",
  "owner": { "org": "<조직>", "team": "<팀>", "creator_id": "<이메일>" },
  "classification": "PUBLIC_INTERNAL",
  "description": "<1024자 이내. 이 서버가 무엇을 하는지, 무엇을 건드리지 않는지>",
  "tags": ["<선택>"],
  "server_alias": "<소문자-케밥-케이스>",
  "provenance": "INTERNAL",
  "protocol_version": "2025-06-18",
  "transport": {
    "kind": "STDIO",
    "interpreter": "python",
    "entrypoint": "server.py",
    "args": [],
    "vendored_dependencies": true
  },
  "declared_tools": [ ... ]
}
```

값 규칙:

| 필드 | 규칙 |
| --- | --- |
| `schema_version` | `"1.0"` 고정 |
| `type` | `"mcp_server"` 고정 |
| `version` | Semver `^\d+\.\d+\.\d+$` (선행 0 불가) |
| `classification` | `PUBLIC_INTERNAL` \| `INTERNAL` \| `CONFIDENTIAL` \| `RESTRICTED` |
| `server_alias` | `^[a-z][a-z0-9-]{0,62}[a-z0-9]$` — 소문자·숫자·하이픈. 로그 키와 화면 라벨로 그대로 쓰이므로 이스케이프가 필요 없어야 한다 |
| `provenance` | `INTERNAL`(사내 제작) \| `THIRD_PARTY`(외부 입수) |
| `protocol_version` | `YYYY-MM-DD`. `initialize` 핸드셰이크가 돌려준 값을 그대로 |
| `transport.interpreter` | `node` \| `python` 만 |
| `transport.args` | 최대 32개, 각 512자. **셸 문자열이 아니라 argv 배열** |

## Tool 정의 규격

`declared_tools`는 1~256개. 각 항목의 필수 필드는 `tool_name`, `risk_level`, `permissions`다.

```json
{
  "tool_name": "namespace.action",
  "label": "<확인 창에 뜰 짧은 설명, 200자 이내>",
  "input_schema": { "type": "object", "additionalProperties": false, "properties": {} },
  "risk_level": "READ_ONLY",
  "permissions": {
    "allowed_roles": ["USER", "CREATOR", "ADMIN"],
    "allowed_orgs": ["<조직>"]
  },
  "data_classification": "PUBLIC_INTERNAL",
  "confirmation_policy": "NEVER",
  "execution_guards": {
    "timeout_seconds": 10,
    "max_bytes": 4096,
    "rate_limit_per_minute": 30
  }
}
```

규칙:

- `tool_name` — `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,4}$`, 128자 이내.
  점으로 네임스페이스를 나눌 수 있다(최대 5단). 경로 구분자·선행 숫자 불가.
- `risk_level` — `READ_ONLY`(부작용 없음) \| `WRITE`(부작용 있음).
  **특별한 이유가 없으면 `READ_ONLY`로 만든다.** WRITE Tool은 모델이 자동으로 고를 수 없고
  항상 사용자 확인을 거친다.
- `permissions` — **Default Deny**다. 빈 배열은 "제한 없음"이 아니라 "아무도 못 씀"이다.
  `allowed_roles`와 `allowed_orgs` 둘 다 반드시 채운다. 역할 값은 `USER` / `CREATOR` / `ADMIN`.
  최종 권한은 검토자가 조정하므로, 여기 쓰는 값은 **요청**이지 확정이 아니다.
- `confirmation_policy` — `NEVER` \| `ON_PARAMETER` \| `ALWAYS` (기본 `ALWAYS`).
  `risk_level: WRITE`인 Tool은 `NEVER`를 쓸 수 없다(스키마가 거부한다).
- `execution_guards.timeout_seconds` — 1~60. 나머지 한도는 1 이상.
- `input_schema` — `tools/list`가 돌려주는 것과 **같아야 한다**. 입력 검증에 실패하는 Tool은
  호출되지 않는다.

## 코드와 매니페스트의 일치

`declared_tools`는 서버의 `tools/list` 응답을 승인 시점에 찍어 둔 스냅샷이다.
**Tool 이름과 `input_schema`가 실제 응답과 다르면 연결 시점에 `tools_snapshot_mismatch`로 막힌다.**

- `tools/list`가 돌려주는 Tool의 개수·이름·입력 스키마를 매니페스트와 정확히 맞춘다.
- 실행 중에 Tool 목록을 바꾸지 않는다.
- 읽기 전용 Tool에는 `read_only_hint=True` 어노테이션을 붙인다.

## 출력 형식

다음 순서로만 출력한다. 설명은 각 파일 앞에 한두 문장이면 충분하다.

1. `server.py` 전체 코드 (파일 하나로 끝나게)
2. `mcp-server-manifest.json` 전체
3. **자체 점검표** — 아래 항목에 각각 `OK` 또는 무엇이 문제인지 한 줄:
   - 환경변수를 읽지 않는다
   - stdout에 JSON-RPC 외의 출력이 없다
   - 런타임 패키지 설치가 없다
   - 표준 라이브러리 + `mcp` 외 의존성이 없다 (있다면 무엇인지)
   - `transport.entrypoint`가 실제 파일명과 같다
   - `declared_tools`의 이름·입력 스키마가 `tools/list`와 일치한다
   - 모든 Tool에 `permissions.allowed_roles`와 `allowed_orgs`가 비어 있지 않다
   - `WRITE` Tool에 `confirmation_policy: NEVER`가 없다
   - 비밀값·내부주소·개인정보가 없다
   - 인자 없이 실행하면 stdio 서버로 뜨고, 점검 플래그를 주면 서버를 띄우지 않는다
   - `--check` / `--list-tools` / `--call` / `--help` 가 모두 동작하고 종료 코드가 규격대로다
   - `transport.args` 에 점검용 플래그가 들어 있지 않다
4. **아이디어에서 바꾼 것** — 제약사항 때문에 아이디어와 다르게 만든 부분이 있으면 한 줄씩.
   없으면 "없음".

## 참고할 최소 예제

저장소의 `samples/mcp-servers/hello-mcp/` 가 이 규격을 통과하는 가장 작은 예제다.
서버 구조, 매니페스트, **터미널 점검 모드까지** 그대로 들어 있으니 애매하면 그것을 따른다.

    uv run python samples/mcp-servers/hello-mcp/server.py --check

## 복사 끝

---

## 등록 절차

1. 위 프롬프트로 `server.py` + `mcp-server-manifest.json` 을 받는다.
2. `id`를 **새 UUID**로 바꾼다. 예제의 UUID를 그대로 쓰면 기존 자산과 충돌한다.
3. **터미널에서 먼저 확인한다** — 화면에 올리기 전에 여기서 걸러진다.

   ```bash
   <인터프리터> server.py --check        # 매니페스트 ↔ tools/list 일치 검사
   <인터프리터> server.py --list-tools   # 어떤 Tool 이 노출되는지
   <인터프리터> server.py --call hello.now --args '{}'
   ```

   `--check` 가 `0` 이 아니면 등록해도 거부되거나 연결 시점에 막힌다. 먼저 고친다.
4. ai-hub → **자산 > MCP > MCP 서버 등록**.
5. Manifest 칸에 JSON을 붙여넣고, 코드 파일을 **개별 파일로** 올린다(압축 금지).
6. 등록 후 검토자가 `permissions`와 `risk_level`을 조정하고 승인한다.

새 버전을 올릴 때는 자산 상세 → **버전 관리 → 새 버전 만들기**를 쓴다.
`id` / `type` / `server_alias`는 버전이 바뀌어도 **변경할 수 없다**.

## 자주 걸리는 오류

| 메시지 / 코드 | 원인 | 조치 |
| --- | --- | --- |
| `ASSET_SOURCE_NOT_EXECUTED_BY_THIS_TRANSPORT` | HTTP 서버인데 코드 파일을 같이 올렸다 | 코드를 빼거나 `transport.kind`를 `STDIO`로 |
| `ASSET_SOURCE_ENTRYPOINT_MISSING` | `entrypoint`로 선언한 파일이 업로드에 없다 | 파일명을 맞추거나 그 파일을 올린다 |
| `VALIDATION_ERROR` + `immutable_fields_changed` | 새 버전에서 `id`/`type`/`server_alias`를 바꿨다 | 원래 값으로 되돌린다 |
| 업로드 거부 (확장자) | `.zip`/`.pyc`/`.sh`/`.exe` 등이 섞였다 | `.py`/`.js`/`.cjs`/`.mjs` 만 남긴다 |
| `stdio_not_allowed_in_hosted_mode` | STDIO 서버를 hosted 런타임에 연결하려 했다 | Desktop(local 모드)에서 쓴다 |
| `interpreter_not_configured` | 배포 설정에 해당 인터프리터 절대경로가 없다 | 관리자에게 설정 요청 |
| `entrypoint_not_found` / `entrypoint_outside_bundle` | 설치 폴더에 진입점이 없거나 번들 밖을 가리킨다 | 상대경로와 파일 위치 확인 |
| `tools_snapshot_mismatch` | 실제 `tools/list`가 매니페스트와 다르다 | 둘을 일치시키고 새 버전 등록 |
| `handshake_failed` | 서버가 뜨지 못했거나 `initialize`에 실패 | stdout 오염, import 실패, 환경변수 의존 여부 확인 |
| `MCP_PERMISSION_DENIED` | 호출자의 역할이 `allowed_roles`에 없다 | 매니페스트 권한 확인 (Desktop 대화 사용자는 기본 `USER`) |

## HTTP 서버일 때의 차이

이미 어딘가에서 돌고 있는 서버를 **등록만** 하는 경우다. 코드를 올리지 않는다.

```json
"transport": { "kind": "HTTP", "endpoint": "https://내부주소/mcp" }
```

- `interpreter`, `entrypoint`, `args`, `vendored_dependencies`를 **쓰지 않는다**(스키마가 거부).
- 코드 파일을 함께 올리면 거부된다 — 이 플랫폼이 실행하지 않을 코드이기 때문이다.
- hosted 런타임에서 쓸 수 있는 유일한 전송 방식이다.
- 그 외 매니페스트 규격(Tool 정의, 권한, 실행 통제)은 STDIO와 같다.

## 검증

등록 전에 로컬에서 확인할 수 있다.

```bash
node scripts/agent/verify-change.mjs --suites contract
```

서버를 손으로 띄워 보려면:

```bash
uv run python samples/mcp-servers/hello-mcp/server.py
```

stdin을 열고 기다리면 정상이다(JSON-RPC 대기 상태).

## 근거

이 문서의 제약이 어디서 오는지. 값이 바뀌면 여기부터 확인한다.

| 내용 | 출처 |
| --- | --- |
| 매니페스트 전체 규격 | `packages/schemas/manifests/mcp-server-manifest.schema.json` |
| 확장자·파일 크기·개수 제한 | `packages/schemas/policies/asset-upload-policy.json` |
| 코드 업로드 게이트 (D-096) | `apps/portal-api/src/portal_api/routers/assets.py` `_mcp_source_violation` |
| 실행 시 환경변수 미전달 (`env={}`) | `services/agent-runtime/src/agent_runtime/mcp_client/client.py` `_build_sdk_target` |
| 등록 실패 사유 목록 | `services/agent-runtime/src/agent_runtime/mcp_client/errors.py` `MCPRegistrationReason` |
| 권한·실행 통제 정책 | `docs/implementation-spec/05-mcp-security-governance.md` §7, §8 |
| 패키지 표준 | `docs/implementation-spec/03-package-standards.md` |
| 런타임 설치 금지 | `CLAUDE.md` 구현 원칙 7 |
| 읽기 전용 원칙과 D-094의 완화 | `CLAUDE.md` 구현 원칙 8, `docs/implementation-spec/open-decisions.md` D-094 |
| 최소 예제 | `samples/mcp-servers/hello-mcp/` |
