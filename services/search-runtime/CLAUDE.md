# search-runtime (M08)

Knowledge 자산에 대한 Hybrid 검색(Chroma 벡터 + `rank_bm25` BM25, RRF 융합)과 ACL/분류
필터링을 담당한다. FastAPI 서비스, 포트 8300. `/search/v1/query`가 유일한 검색 엔드포인트다.

## 먼저 읽을 것

- `docs/implementation-spec/04-knowledge-platform.md` §3 전체(§3.5 Vector Search, §3.6 BM25
  Search, §3.7 Hybrid와 RRF, §3.8 Filter와 ACL, §3.9 Parent Expansion)
- `docs/implementation-spec/open-decisions.md` D-046(관련도 임계값), D-054(BM25 pickle→json,
  캐시), D-062(fail-closed Classification ACL), D-067(Chroma Client 캐시), D-075(Embedding
  Model 정합성)
- `packages/schemas/api/knowledge-search.schema.json`

## 코드 배치

`src/search_runtime/`: `main.py`(FastAPI, `/search/v1/query`), `hybrid.py`(벡터+BM25+RRF 융합
본체), `access_control.py`(§3.8 ACL 5단계 그대로 구현), `bm25_cache.py`(재구축 BM25Okapi 캐시),
`bm25_store.py`, `chroma_client_cache.py`, `settings.py`, `errors.py`. indexing-runtime(M07)과
겹치는 `bm25_store.py`/`chroma_client_cache.py`는 의도적으로 각 서비스에 복제되어 있다(M07/M08
내부 폴더 상호 import 금지 — 각 파일 docstring에 이유 기록).

## 이 모듈의 경계

`pyproject.toml` dependencies: `chromadb`, `rank-bm25`, `ai-asset-schemas`, `observability`,
`security-policy`(Classification/`clearance_covers` 중앙 정의 — 공개 패키지 API로 소비, M07
내부 폴더 직접 import 아님). indexing-runtime(M07)의 `src/indexing_runtime/`를 직접 import하지
않는다. `access_control.py`가 명시하듯 이 서비스에는 인증 계층이 없다 — `access_context.clearance`는
호출자(agent-runtime 등)가 주장하는 값을 그대로 신뢰하며, 실제 신원 검증은 상위 계층(agent-runtime
이전)의 몫이다(D-062/D-015).

## 실행

`make dev-search-runtime` (`cd services/search-runtime && uv run uvicorn
search_runtime.main:app --reload --port 8300`)

## 테스트

`tests/unit/search_runtime/` — `uv run pytest tests/unit/search_runtime/ -v`.
`test_access_control.py`/`test_acl_filtering.py`(§3.8), `test_bm25_cache.py`/`test_bm25_store.py`,
`test_chroma_client_cache.py`, `test_embed_model_resolution.py`, `test_embed_query.py`,
`test_relevance_filter.py`(D-046)로 나뉜다.

## 이 모듈에서 반복해서 틀렸던 것

- **`hybrid.py`의 `INDEX_BASE` 기본값이 아직 개발자 개인 절대경로로 하드코딩되어 있다**
  (`os.environ.get("INDEX_BASE", "/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/data/indexes")`).
  indexing-runtime의 `main.py`는 동일한 문제를 저장소 루트 기준 상대경로 계산으로 이미 고쳤지만,
  이 서비스의 `INDEX_BASE`는 아직 그 패턴을 따르지 않는다. `INDEX_BASE` env var 없이 다른 머신에서
  실행하면(특히 Windows 대상 PC) 조용히 잘못된 경로를 보게 된다 — 이 서비스를 만질 때는
  `INDEX_BASE`를 항상 명시적으로 설정하거나, 고칠 때는 indexing-runtime의 `_REPO_ROOT` 계산
  패턴을 그대로 따른다.
- **ACL은 fail-closed다** — `classification` 메타데이터가 없거나 미인식 값이면
  `Classification.UNKNOWN`으로 파싱되고, `settings.ALLOW_UNKNOWN_CLASSIFICATION`(기본 `False`)이
  꺼져 있는 한 어떤 clearance로도 보이지 않는다(`access_control.forced_allowed_classifications`).
  이 기본값을 "귀찮으니 허용"으로 바꾸는 변경은 D-062가 명시적으로 막으려던 조용한 정보 노출을
  재도입하는 것이다 — 절대 하드코딩 리터럴로 우회하지 말고 `SEARCH_ALLOW_UNKNOWN_CLASSIFICATION`
  env를 통해서만, 배포자가 명시적으로 선택하게 한다.

## 완료 전 확인

- `metadata_filters`/`retrieval_profile.metadata_filters`를 다루는 코드를 추가했다면
  `access_control.reject_acl_override`를 거치는가(요청 Body로 ACL 필드를 덮어쓰는 경로가
  새로 생기지 않았는가)
- ACL/relevance 필터링을 top_k 후보로 자르기 *전에* 적용했는가(BM25/Vector 각각의
  `top_k*2` 후보 truncation보다 먼저 — 이미 잘린 뒤에 걸러내면 허용된 낮은 순위 결과가
  금지된 상위 순위 결과에 밀려난다)
- BM25/Chroma 아티팩트를 다시 읽는 코드를 추가했다면 `bm25_cache.get_cached_bm25`/
  `chroma_client_cache.get_chroma_client`를 거치는가(직접 파일을 읽거나
  `chromadb.PersistentClient()`를 새로 여는 코드 금지 — D-054/D-067 재발 방지)
- **Ollama 임베딩은 같은 입력이라도 호출마다 결과가 미세하게 다르다(비결정적)** — 관련도 점수나
  RRF 순위를 테스트/평가 게이트에서 정확히 재현 가능하다고 가정하지 않는다. 임계값 기반 assertion은
  여유(margin)를 두고, 회귀 테스트는 가능하면 저장된 임베딩 벡터를 fixture로 고정한다.
- `bm25.pkl`(legacy)을 다루는 경로를 건드렸다면 `ALLOW_LEGACY_PICKLE_BM25` 기본값과
  `LegacyPickleBm25Refused`가 여전히 조용한 빈 결과가 아니라 명시적 오류로 이어지는가
