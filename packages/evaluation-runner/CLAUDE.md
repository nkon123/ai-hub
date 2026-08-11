# packages/evaluation-runner (M09)

Knowledge 검색 품질을 평가한다 — Dataset을 `search-runtime`(HTTP)에 돌려 Recall@K/MRR/지연시간을
집계하고, Quality Gate 정책과 비교해 PASS/FAIL을 낸다. 버전 간 비교(`compare_versions`)와
Data Card 생성도 이 모듈의 범위다. `evaluate-knowledge` CLI를 제공한다.

## 먼저 읽을 것

- `docs/implementation-spec/04-knowledge-platform.md` §4.4(검색 평가), §4.6(버전 비교),
  §4.7(Quality Gate), §4.8(Data Card).
- `packages/schemas/evaluation/evaluation-dataset.schema.json`,
  `packages/schemas/evaluation/evaluation-result.schema.json`.
- `docs/implementation-spec/open-decisions.md` D-045 — 문서 id 매칭 규칙(`document_path`
  파일명 stem으로 조작적 정의)과 Quality Gate 범위(6개 기준 중 수치화 가능한 4개만 다룸,
  ACL Test/Package Smoke Test는 범위 밖).

## 코드 배치

- `runner.py` — `run_evaluation()`(오케스트레이션), `load_dataset()`.
- `metrics.py` — `evaluate_case()`/`aggregate_metrics()` (Recall@K, MRR 등).
- `matching.py` — D-045의 문서 id 매칭 규칙 구현.
- `quality_gate.py` — `load_policy()`/`evaluate_gate()`, `QualityGatePolicy`/`GateResult`/`GateCheck`.
- `comparison.py` — `compare_versions()`, `ComparisonReport`.
- `search_client.py` — `SearchClient` 인터페이스 + `HttpSearchClient`(search-runtime 호출).
- `result.py`/`models.py` — `EvaluationResult`/`EvaluationDataset`/`EvaluationCase` 등 도메인 모델.
- `data_card.py`, `settings.py`, `cli.py`.
- `config/quality-gate.yaml` — 임계값. 코드에 하드코딩하지 않는다(§4.7 요구사항).

## 공개 API

`__init__.py`가 노출하는 것이 곧 이 모듈의 공개 계약이다:
`run_evaluation`, `load_dataset`, `load_policy`, `compare_versions`,
`evaluate_case`, `aggregate_metrics`, `evaluate_gate`,
`SearchClient`/`HttpSearchClient`, `EvaluationDataset`/`EvaluationCase`/`EvaluationResult`,
`QualityGatePolicy`/`GateResult`/`GateCheck`, `ComparisonReport`,
예외 `DatasetLoadError`/`DatasetMismatchError`/`QualityGatePolicyError`/`SearchClientError`.

`apps/portal-api`의 평가 Job(`routers/evaluations.py`)은 **이 공개 API만** 사용한다 —
`run_evaluation`/`load_dataset`/`load_policy`/`compare_versions`를 호출하고 내부의
`HttpSearchClient`로 search-runtime을 부른다. `evaluation_runner.metrics`/`matching` 등
내부 모듈을 portal-api가 직접 import하지 않는다.

```python
async def run_evaluation(
    *, search_client: SearchClient, dataset: EvaluationDataset, knowledge_id: str,
    knowledge_version: str = "latest", top_k: int = 5, alpha: float = 0.5,
    policy: QualityGatePolicy, baseline_recall_at_5: float | None = None,
) -> EvaluationResult: ...
```

## quality-gate.yaml 임계값 (하드코딩 아님, 파일에서 조정)

- `recall_at_5_min: 0.80`
- `recall_at_5_max_regression_pp: 0.05` — `baseline_recall_at_5`가 주어질 때만 검사, 없으면
  스킵(실패 아님).
- `p95_latency_ms_max: 2000`
- `forbidden_hit_rate_max: 0.0`

## 이 모듈의 경계

- `dependencies`(`pyproject.toml`): `ai-asset-schemas`(workspace), `httpx`,
  `pydantic-settings`, `pyyaml`, `click`. `services/search-runtime`/`services/indexing-runtime`을
  Python 패키지로 import하지 않는다(루트 원칙 2, 모듈 docstring 명시) — search-runtime과는
  `SearchClient`를 통해 HTTP로만 통신하고, indexing-runtime과는 그 서비스가 남긴
  `index-meta.json` 파일(Data Card용)만 읽는다.
- `httpx`는 `search_client.py` 밖으로 노출하지 않는다(Adapter Interface 뒤, 루트 코드 규칙).
- `run_id`(실행 전체)와 `trace_id`(케이스별)를 모든 search-runtime 호출에 부여한다
  (루트 구현 원칙 9).

## 실행

```
uv run evaluate-knowledge run --dataset <path> --knowledge-id <id> --policy config/quality-gate.yaml
```

## 테스트

`tests/unit/evaluation_runner/` — `test_runner.py`, `test_metrics.py`, `test_matching.py`,
`test_quality_gate.py`, `test_comparison.py`, `test_data_card.py`, `test_models.py`,
`test_search_client.py`. `conftest.py`에 공유 fixture. 실행:
`uv run pytest tests/unit/evaluation_runner/ -v` (기본 `uv run pytest tests/ -q`에 포함).
실제 search-runtime을 상대로 한 평가 실행은 `tests/e2e/test_e2e_07_knowledge_regression.py`
(라이브 스택 필요, `tests/CLAUDE.md` 참고).

## 완료 전 확인

- Quality Gate 임계값을 바꿨다면 코드가 아니라 `config/quality-gate.yaml`을 바꿨는가.
- portal-api가 쓰는 공개 API(`run_evaluation`/`load_dataset`/`load_policy`/`compare_versions`)의
  시그니처를 바꿨다면 `apps/portal-api`의 호출부도 함께 바꿨는가(별도 PR로 Contract 변경 제안,
  루트 "다른 모듈의 변경이 필요하면 먼저 Contract 변경을 별도 PR로 제안한다").
- 새 지표/체크를 추가했다면 `EvaluationResult`가 `evaluation-result.schema.json`과 계속
  맞는가(`validate(..., SchemaType.EVALUATION_RESULT)`).
- D-045의 문서 id 매칭 규칙(파일명 stem)을 벗어나는 가정을 넣지 않았는가 — search-runtime이
  아직 `document_id`를 반환하지 않는 한 이 조작적 정의가 유일한 매칭 기준이다.
