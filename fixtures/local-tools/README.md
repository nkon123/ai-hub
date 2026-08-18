# 로컬 Tool 샘플 (D-084)

Desktop Client의 **로컬 Tool**(D-084)로 바로 등록해 쓸 수 있는 Python 파일 모음이다.
자산 허브에서 설치하는 **MCP Tool 자산**(D-080)과는 다른 기능이다 — 이쪽은 사용자가
자기 PC의 `.py` 파일을 직접 골라 로컬에서 실행한다.

## 쓰는 법

Desktop → 자산 허브 → 로컬 Tool → 파일 추가 → 이 폴더의 `.py` 파일 선택.

추가 시 Desktop이 파일을 **실행하지 않고** 정적 분석만 해서 함수 시그니처를 읽는다.
실행은 매번 사용자가 네이티브 확인 대화상자에서 승인해야 일어난다(D-084).

## 파일

| 파일 | 함수 | 하는 일 |
|---|---|---|
| `business_days_between.py` | `business_days_between(start_date, end_date, include_end=True)` | 두 날짜 사이 영업일 수 (주말 제외) |
| `format_korean_amount.py` | `format_korean_amount(amount, unit="원")` | 금액을 쉼표 표기와 억/만 단위 표기로 |
| `text_stats.py` | `text_stats(text, chars_per_page=1800)` | 글자·단어·줄·문단 수와 예상 쪽수 |
| `percent_change.py` | `percent_change(before, after, decimals=2)` | 증감폭과 증감률(%) |

## 이 샘플들이 지키는 것

- **표준 라이브러리만** 쓴다. 폐쇄망에서 추가 설치 없이 동작한다(루트 코드 규칙: 새 의존성은 폐쇄망 설치 방법을 문서화해야 한다 — 아예 만들지 않는 쪽을 택했다).
- **파일·네트워크에 접근하지 않는다.** 읽기 전용 계산만 한다.
- **파일당 함수 하나**, 모든 매개변수에 타입 어노테이션. D-084 정적 분석기의 요구사항이다
  (`apps/desktop-client/electron/local-tool-signature.ts` — 함수가 여러 개면
  `multiple_functions_found`로, 어노테이션이 없으면 `parameter_annotation_missing`으로 거절된다).
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
