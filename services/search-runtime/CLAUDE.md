# search-runtime (M08)

Knowledge 자산에 대한 Hybrid 검색(Chroma 벡터 + `rank_bm25` BM25, RRF 융합)과 ACL/분류
필터링을 담당한다. FastAPI 서비스, 포트 8300. `/search/v1/query`가 유일한 검색 엔드포인트이고,
`/search/v1/local-indexes`(POST/GET/DELETE)는 검색이 아니라 **어떤 색인 디렉터리를 검색 대상으로
삼을지 등록·해제하는** 관리 계약이다(D-079).

## 먼저 읽을 것

- `docs/implementation-spec/04-knowledge-platform.md` §3 전체(§3.5 Vector Search, §3.6 BM25
  Search, §3.7 Hybrid와 RRF, §3.8 Filter와 ACL, §3.9 Parent Expansion)
- `docs/implementation-spec/open-decisions.md` D-046(관련도 임계값), D-054(BM25 pickle→json,
  캐시), D-062(fail-closed Classification ACL), D-067(Chroma Client 캐시), D-075(Embedding
  Model 정합성), D-079(설치된 Knowledge 색인 등록)
- `packages/schemas/api/knowledge-search.schema.json`,
  `packages/schemas/api/knowledge-local-index.schema.json`

## 코드 배치

`src/search_runtime/`: `main.py`(FastAPI, `/search/v1/query` + `/search/v1/local-indexes`),
`hybrid.py`(벡터+BM25+RRF 융합 본체, 색인 경로 해석 `resolve_index_dir`),
`local_index_registry.py`(D-079 외부 설치 색인 등록표),
`access_control.py`(§3.8 ACL 5단계 그대로 구현), `bm25_cache.py`(재구축 BM25Okapi 캐시),
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

- **`INDEX_BASE` 기본값이 아직 개발자 개인 절대경로로 하드코딩되어 있다**
  (`settings.py`로 옮겨졌고 `hybrid.py`가 그대로 re-export한다 — D-079에서
  `local_index_registry.py`가 순환 import 없이 읽을 수 있게 하려고 위치만 바꿨을 뿐,
  값·env 이름·기본값은 동일하다).
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

- **CORS `allow_origins`는 반드시 `settings.CORS_ORIGINS`를 거친다** — `main.py`에 리터럴을
  박지 않는다. agent-runtime이 정확히 그 실수를 한 적이 있고 증상이 지독하다(서버 로그는 200인데
  브라우저가 응답을 통째로 버린다). 이 서비스에 CORS가 필요한 이유는 Desktop 채팅 화면이
  **렌더러에서** search-runtime을 health-check하기 때문이다(D-079) — 없으면 정상인데도 영구
  "연결 끊김"으로 표시된다. 두 서비스의 기본 Origin 목록이 갈라지면
  `tests/unit/search_runtime/test_cors.py`가 깨진다. CORS가 관리용 엔드포인트를 보호하는 장치가
  **아니라는** 점은 그 설정의 docstring에 기록되어 있다(이 서비스에는 인증 계층이 없다).
- **색인 경로를 새로 만들지 않는다.** `Path(INDEX_BASE) / knowledge_id`를 직접 조립하는 코드를
  추가하면 D-079로 등록된 외부 색인이 그 경로에서만 조용히 누락된다 — 반드시
  `hybrid.resolve_index_dir(index_base, knowledge_id)`를 거친다(`resolve_embed_model`도 이미
  이 함수를 쓴다). 등록된 색인은 배포 채널로 들어온 콘텐츠이므로 그 경로에서는
  `allow_legacy_pickle`이 무조건 `False`로 강제된다.
- **등록 거절은 조용할 수 없다.** `local_index_registry`의 모든 거절은 `details.reason`을 가진
  Error Envelope로 나가고, 그 목록은 `packages/schemas/api/knowledge-local-index.schema.json`에
  전부 문서화되어 있다(계약과 코드가 갈라지면
  `tests/contract/test_knowledge_local_index_contract.py`가 깨진다). 새 거절 사유를 추가하면
  스키마 설명과 Desktop 쪽 분기까지 함께 갱신한다.

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
