# packages/schemas (M06)

Manifest/Profile/Service/Knowledge Package/Evaluation/MCP Audit Context용 JSON Schema 정의와,
그 Schema로 검증하는 Python Validator(`ai_asset_schemas`)를 제공한다. 다른 모든 모듈이
계약을 확인할 때 참조하는 단일 진실원(source of truth)이다.

## 먼저 읽을 것

- `docs/implementation-spec/03-package-standards.md` — Manifest/Profile/Package 구조 전체.
  §11 Validator CLI, §12 M06 인수 기준.
- `docs/implementation-spec/07-data-api-contracts.md` — Entity/API 계약, §8 오류코드 분류.
- `docs/implementation-spec/04-knowledge-platform.md` §4.1/§4.2/§4.3 — Knowledge
  Package/Source Manifest/Evaluation Dataset 필드가 여기 스키마와 대응한다.

## 코드 배치

- `manifests/*.schema.json` — Asset/Knowledge/Agent/Prompt/MCP Tool/Service Definition.
- `profiles/*.schema.json` — Indexing/Retrieval/Office Profile.
- `knowledge/*.schema.json` — Knowledge Package Manifest, Source Manifest.
- `evaluation/*.schema.json` — Evaluation Dataset, Evaluation Result.
- `policies/*.schema.json` — Bundle Install Policy(+ 그 자체의 인스턴스 `bundle-install-policy.json`).
- `api/*.yaml`/`*.schema.json` — Portal OpenAPI, Local Runtime API, Hosted Chat API,
  Knowledge Search 요청/응답, MCP Audit Context.
- `src/ai_asset_schemas/validator.py` — 공개 검증 API. `cli.py` — `validate-manifest` CLI.
- 새 Schema 파일을 추가하면 반드시 `validator.py`의 `SchemaType`과 `_SCHEMA_PATHS`에도
  등록한다 — 파일만 두고 등록을 빠뜨리면 `validate()`/`infer_schema_type()`이 그 타입을
  영원히 모른다.

## 공개 API (실제 시그니처)

```python
from ai_asset_schemas import validate, SchemaType, ValidationError
# 또는 ai_asset_schemas.validator에서: validate_file, infer_schema_type
```

- `SchemaType` (`StrEnum`): `ASSET`, `KNOWLEDGE`, `AGENT`, `PROMPT`, `MCP_TOOL`, `SERVICE`,
  `INDEXING_PROFILE`, `RETRIEVAL_PROFILE`, `OFFICE_PROFILE`, `EVALUATION_DATASET`,
  `EVALUATION_RESULT`, `KNOWLEDGE_PACKAGE`, `SOURCE_MANIFEST`, `BUNDLE_INSTALL_POLICY`.
- `validate(manifest: dict, schema_type: SchemaType) -> None` — 실패 시 `ValidationError` raise
  (`.errors: list[str]`에 전체 메시지 목록).
- `infer_schema_type(manifest: dict) -> SchemaType` — `type` 필드 우선, 없으면 구조적 휴리스틱
  (`chunking_strategy`→INDEXING_PROFILE, `top_k`+`hybrid_alpha`→RETRIEVAL_PROFILE,
  `model_aliases`→OFFICE_PROFILE, `archive_extensions`+`size_caps`→BUNDLE_INSTALL_POLICY).
- `validate_file(path: Path, schema_type: SchemaType | None = None) -> None` — JSON 파일을
  읽고, `schema_type` 생략 시 `infer_schema_type`으로 추론 후 검증.
- CLI: `validate-manifest <path> [--type TYPE] [--all]` (`cli.py`).

## 이 모듈의 경계

- `dependencies`(`pyproject.toml`): `jsonschema`, `referencing`, `click`, `pyyaml`,
  `openapi-spec-validator`. 다른 워크스페이스 패키지에 의존하지 않는다 — 모든 모듈이
  이 패키지에 의존하는 방향만 존재해야 한다(역방향 의존 금지).
  실제로 `packages/knowledge-packager`, `packages/evaluation-runner`, `tests`가
  `ai-asset-schemas`(workspace source)를 의존한다.
  Draft 2020-12(`jsonschema.Draft202012Validator`) 고정.
- 다른 모듈의 내부 `src/`를 import하지 않는다(루트 원칙 2). 이 패키지는 순수 계약 계층이라
  애초에 그럴 이유도 없다.

## 실행

이 모듈 자체에 실행할 서버는 없다. `uv run validate-manifest <path>` 로 단일 파일/디렉터리 검증.

## 테스트

- 이 모듈 자체의 단위 테스트 디렉터리는 없다 — Schema는 `tests/contract/`가 검증한다:
  `tests/contract/test_valid_fixtures.py`(`fixtures/valid/**`는 전부 통과해야 함),
  `tests/contract/test_invalid_fixtures.py`(`fixtures/invalid/**`는 전부 실패해야 함),
  `tests/contract/test_openapi_spec.py`, `tests/contract/test_bundle_install_policy.py`,
  `tests/contract/test_wizard_examples.py`.
- 실행: `make contract-test` 또는 `uv run pytest tests/contract/ -v`.
- `make validate-schemas` — `fixtures/valid/`를 `validate-manifest --all`로 일괄 검증.

## 이 모듈에서 반복해서 틀렸던 것

- **계약을 코드보다 먼저 작성한다(루트 구현 원칙 1)가 실제로 걸리는 지점이 여기다.**
  Schema 필드를 하나 바꾸면 최소 세 곳이 동시에 바뀌어야 한다: (1) 이 Schema 파일,
  (2) 그 필드를 쓰는 `fixtures/valid/**`(그리고 필요하면 `fixtures/invalid/**`에
  실패 케이스 추가), (3) `tests/contract/`. 셋 중 하나만 바꾸면 `test_valid_fixtures.py`나
  `test_invalid_fixtures.py`가 곧바로 깨진다 — 이것이 의도된 안전장치이지 우회 대상이 아니다.
  Schema를 바꾸고 나면 반드시 `make validate-schemas`와 `make contract-test`를 둘 다 돌린다.
  이 저장소는 DB 마이그레이션이 없으므로(사용자 메모리 참고) Schema 변경이 하위 호환을
  깨면 그 여파가 fixture/contract test 실패로 즉시 드러난다 — 조용히 넘어가지 않는다.

## 완료 전 확인

- 새/변경 Schema가 `validator.py`의 `SchemaType`·`_SCHEMA_PATHS`·`infer_schema_type`에
  반영되었는가.
- `fixtures/valid/`와 `fixtures/invalid/`가 변경된 필드를 반영하는가(양쪽 다).
- `make validate-schemas`와 `make contract-test`(또는 `uv run pytest tests/contract/ -v`)가
  통과하는가.
- Schema를 소비하는 모듈(knowledge-packager, evaluation-runner, portal-api, agent-runtime 등)의
  런타임 코드가 필드명을 그대로 쓰는지 — API/Schema Field는 명세 이름을 그대로 쓴다(루트 코드 규칙).
