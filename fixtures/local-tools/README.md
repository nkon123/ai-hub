# 로컬 Tool 샘플 (D-084)

Desktop Client의 **로컬 Tool**(D-084)로 바로 등록해 쓸 수 있는 Python 파일 모음이다.
자산 허브에서 설치하는 **MCP Tool 자산**(D-080)과는 다른 기능이다 — 이쪽은 사용자가
자기 PC의 `.py` 파일을 직접 골라 로컬에서 실행한다.

## 쓰는 법

Desktop → 자산 허브 → 로컬 Tool → 파일 추가 → 이 폴더의 `.py` 파일 선택.

추가 시 Desktop이 파일을 **실행하지 않고** 정적 분석만 해서 함수 시그니처를 읽는다.
실행은 매번 사용자가 네이티브 확인 대화상자에서 승인해야 일어난다(D-084).

## 파일

| 파일 | 등록되는 Tool | 하는 일 |
|---|---|---|
| `add_numbers.py` | `add_numbers` | 두 수 더하기 — **채팅 자동 Tool 선택 데모**("1 + 3333") |
| `extract_error_lines.py` | `extract_error_lines` | 로그 텍스트에서 ERROR/WARN/FATAL 줄 추출·집계 |
| `markdown_table.py` | `markdown_table` | 행 데이터를 Markdown 표로 — **스케줄 이력 팝업 데모** |
| `disk_space_report.py` | `disk_space_report` | 디스크 여유 공간 Markdown 보고서 — **스케줄 데모**(매일 9시) |
| `text_toolkit.py` | `slugify_title`, `count_words`, `mask_digits` | **한 파일 = 여러 Tool** (`@tool` 다중 등록 데모) |
| `business_days_between.py` | `business_days_between` | 두 날짜 사이 영업일 수 (주말 제외) |
| `format_korean_amount.py` | `format_korean_amount` | 금액을 쉼표·억/만 단위 표기로 |
| `text_stats.py` | `text_stats` | 글자·단어·줄·문단 수와 예상 쪽수 |
| `percent_change.py` | `percent_change` | 증감폭과 증감률(%) |

## `@tool` 다중 등록 (`text_toolkit.py`)

파일에 함수가 여럿이면 무엇을 등록할지 알 수 없어 거절된다. `@tool`(또는 `@mcp.tool`)을 붙이면 붙은 것들만 골라 **각각 별개 Tool 로** 등록된다. `text_toolkit.py`는 3개가 등록되고 도우미 함수 `_slugify`는 데코레이터가 없어 제외된다.

그 파일의 `tool` 데코레이터는 **샘플이 외부 의존성 없이 돌게 하려고 직접 정의한 최소 구현**이다. 실제로는 LangChain(`from langchain_core.tools import tool`)이나 MCP SDK 의 `@mcp.tool` 을 쓴다. 원본 함수를 `.func` 에 보관하는 것까지 같은 모양으로 맞췄다 — Desktop 실행기가 래핑된 Tool 을 언랩할 때 보는 곳이 거기다.

**외부 라이브러리를 쓰는 Tool** 은 그 라이브러리가 **설정에 지정한 Python 인터프리터**에 설치돼 있어야 한다(설정 > 일반 > Python 인터프리터 경로). venv 를 쓴다면 그 venv 의 `python.exe` 를 직접 가리켜야 한다 — Desktop 은 셸을 거치지 않고 그 실행 파일을 spawn 하므로 `activate` 는 소용없다.

## 이 샘플들이 지키는 것

- **표준 라이브러리만** 쓴다. 폐쇄망에서 추가 설치 없이 동작한다(루트 코드 규칙: 새 의존성은 폐쇄망 설치 방법을 문서화해야 한다 — 아예 만들지 않는 쪽을 택했다).
- **네트워크에 접근하지 않는다.** 파일시스템도 `disk_space_report.py` 하나만 읽고(용량 조회, 읽기 전용) 나머지는 넘겨받은 인자만 계산한다. 로그 분석 Tool 이 파일 경로가 아니라 **로그 텍스트**를 받는 것도 같은 이유다 — 사용자가 준 경로로 파일을 여는 Tool 을 샘플로 두지 않는다.
- **모든 매개변수에 타입 어노테이션.** 없으면 `parameter_annotation_missing`으로 거절된다.
- **함수가 여럿이면 `@tool` 로 명시**한다(`text_toolkit.py`). 데코레이터 없이 함수가 여럿이면 무엇을 등록할지 알 수 없어 `multiple_functions_found`로 거절된다 — 분석기가 추측하지 않는다.
  (`apps/desktop-client/electron/local-tool-signature.ts`)
- **신원 매개변수를 받지 않는다.** `user`/`role`/`roles`/`org`/`organization_id`는 분석기가
  `identity_parameter_forbidden`으로 거절한다 — 호출자가 자기 신원을 주장하게 두지 않는다.
- **모르는 것을 아는 척하지 않는다.** `business_days_between`은 공휴일을 반영하지 않으며 그
  사실을 반환값에 적는다. `percent_change`는 기준값이 0일 때 0을 돌려주지 않고 `null`과
  이유를 함께 돌려준다 — 0은 "변화 없음"으로 잘못 읽힌다.

## 새 Tool을 만들 때

반환값은 **JSON 직렬화 가능**해야 한다(`local-tool-runner.ts`가 `json.dumps`로 직렬화한다).
지원되는 어노테이션은 `str`/`int`/`float`/`bool`/`None`과 `list[...]`/`dict[str, ...]`/
`Optional[...]`/`Union[...]`/`Literal[...]`/`Annotated[...]` 조합이다. 분석기가 확신할 수 없는
것은 추측하지 않고 거절한다.
