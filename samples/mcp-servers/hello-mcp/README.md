# 연결 확인용 예제 MCP 서버 (stdio)

D-094 의 stdio 등록 경로를 **끝까지** 돌려 보기 위한 최소 예제입니다. 파일도
네트워크도 건드리지 않고, 보낸 문장(`hello.echo`)과 현재 시각(`hello.now`)만
돌려줍니다.

운영용이 아닙니다. 등록이 되는지 확인한 뒤에는 해제하세요.

## 준비 — 설정 네 개

stdio 는 이 PC 에서 **실제로 프로세스를 띄우는** 경로라 기본적으로 꺼져 있습니다.
`services/agent-runtime/.env` 에 아래를 넣고 재시작합니다 — 같은 폴더의
`.env.example` 을 복사해 쓰면 됩니다(`.env` 는 커밋되지 않습니다).

```
AGENT_RUNTIME_MCP_SERVER_REGISTRATION_ENABLED=true
AGENT_RUNTIME_RUNTIME_MODE=local
AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS=["C:/Dev/ai-hub/samples/mcp-servers"]
AGENT_RUNTIME_MCP_PYTHON_INTERPRETER_PATH=C:/Dev/ai-hub/.venv/Scripts/python.exe
```

**설치 루트는 JSON 배열입니다.** 경로를 그냥 적으면 기동할 때
`error parsing value for field "mcp_server_install_roots"` 로 죽습니다 —
이 문서를 처음 쓸 때 그렇게 적어 두었다가 실제로 막혔습니다. Windows 경로는
슬래시를 쓰거나 역슬래시를 두 번(`C:\\Dev\\...`) 씁니다.

각각이 무엇을 막는지:

| 설정 | 없으면 |
|---|---|
| `..._REGISTRATION_ENABLED` | 등록 자체가 거부됩니다(`mcp_server_registration_disabled`) |
| `..._RUNTIME_MODE=local` | stdio 가 거부됩니다(`stdio_not_allowed_in_hosted_mode`) — 공유 서버에서 서드파티 코드를 띄우지 않기 위한 것이라 설정으로 뚫을 수 없습니다 |
| `..._INSTALL_ROOTS` | 설치 폴더가 허용 범위 밖이라 거부됩니다 |
| `..._PYTHON_INTERPRETER_PATH` | 실행할 프로그램이 없어 거부됩니다(`interpreter_not_configured`) |

**실행 명령은 매니페스트가 정하지 못합니다.** 매니페스트는 `"interpreter": "python"`
이라고만 말하고, 그 python 이 어느 것인지는 위 설정만 정합니다.

## 등록

```
curl -X POST http://localhost:8100/local/v1/mcp-servers ^
  -H "Content-Type: application/json" ^
  -d "{\"manifest\": <mcp-server-manifest.json 내용>, \"install_path\": \"C:\\Dev\\ai-hub\\samples\\mcp-servers\\hello-mcp\", \"source\": \"DESKTOP_INSTALL\"}"
```

Portal 위저드(`/assets/new/mcp_server`)에서는 2단계 맨 위 예시 중
**"내 PC에서 직접 실행 (예제 서버)"** 의 `이걸로 채우기` 를 누르면 됩니다 —
그 예시가 바로 이 폴더의 `mcp-server-manifest.json` 이라 붙여넣을 것이 없습니다
(`fixtures/wizard-examples-index.json` 이 이 파일을 직접 가리킵니다).

단, Portal 등록은 **카탈로그에 자산을 만드는 것**이고 이 서버가 뜨는 것과는
별개입니다. `server.py` 는 업로드할 수 없습니다(`.py` 는 거부됩니다) — 코드를
허브가 나르는 문제는 D-096 의 열린 항목입니다.

## 확인

Desktop **자산 허브 → MCP 서버** 탭, 또는:

```
curl http://localhost:8100/local/v1/mcp-servers
```

정상이면 이렇게 나옵니다(실측):

```json
{
  "server_alias": "hello-mcp",
  "transport_kind": "STDIO",
  "state": "ACTIVE",
  "tool_names": ["hello.echo", "hello.now"]
}
```

## 알아 두면 좋은 것

- **프로세스는 호출할 때마다 새로 뜹니다.** 등록 시점에 한 번(`tools/list`),
  이후 호출마다 한 번입니다. 서버가 상태를 들고 있어야 한다면 지금 구조로는
  맞지 않습니다(D-094 열린 항목: stdio 프로세스 수명 정책).
- **환경변수를 물려주지 않습니다**(`env={}`). 부모 프로세스에는 이 서버가 알
  필요 없는 토큰·내부 주소가 있습니다. 그래서 `server.py` 는 표준 라이브러리와
  `mcp` 만 씁니다.
- **선언한 Tool 만 쓰입니다.** 이 서버가 나중에 Tool 을 늘려도 매니페스트의
  `declared_tools` 에 없으면 등록되지 않습니다(교집합).
- **누가 부를 수 있는가**: 두 Tool 모두 역할 `USER`/`CREATOR`/`ADMIN`, 조직
  `miracom` 을 허용합니다(1.0.1). 1.0.0 은 `CREATOR`/`ADMIN` 만 허용해서,
  역할이 `USER` 로 고정된 Desktop 대화에서는 Tool 이 제안돼도
  `MCP_PERMISSION_DENIED` 로 거부됐습니다. 이미 1.0.0 을 설치했다면 1.0.1 로
  다시 등록·설치하거나, agent-runtime 에
  `AGENT_RUNTIME_POC_MCP_USER_ROLES=USER,CREATOR` 를 주세요(D-100).
- `provenance` 가 `INTERNAL` 이라 호출자 신원이 `_meta` 로 전달됩니다.
  `THIRD_PARTY` 로 바꾸면 전달하지 않습니다(D-095).

## 해제

```
curl -X DELETE http://localhost:8100/local/v1/mcp-servers/hello-mcp
```
