# indexing-runtime (M07)

Knowledge 자산(문서)을 Load → Chunk → Embed → Store 순으로 색인한다. FastAPI 서비스, 포트 8200.
`/indexing/v1/jobs`는 파이프라인을 동기 실행해 결과를 바로 반환한다(PoC 단순화 — §2.2의 11단계
상태 머신을 실제로 거치지 않고 `{status: COMPLETED|FAILED, ...}`만 반환한다).

## 먼저 읽을 것

- `docs/implementation-spec/04-knowledge-platform.md` §2 전체(§2.2 Job 상태, §2.3 Loader,
  §2.5 Chunking Strategy, §2.7 Metadata, §2.8 Embedding, §2.9 Vector Index, §2.10 BM25 Index)
- `docs/implementation-spec/open-decisions.md` D-053(Profile 해석), D-062(Classification Stamp),
  D-067(Chroma Client 누수), D-073(PDF/Word Loader), D-075(Embedding Model 정합성)

## 코드 배치

실제 코드는 `src/indexing_runtime/` 아래에 있다: `main.py`(FastAPI+CLI), `pipeline.py`(파이프라인),
`profile.py`(Indexing Profile 해석), `settings.py`, `errors.py`, `bm25_store.py`,
`chroma_client_cache.py`, `stamp_classification.py`(기존 인덱스 재-Stamp CLI),
`convert_bm25_format.py`(pickle→json 변환 CLI), 그리고 하위 패키지 `chunkers/`
(`recursive.py`/`markdown.py`/`parent_child.py`/`heading.py`/`ids.py`), `embedders/`(Ollama
Adapter), `loaders/`(`docx_loader.py`/`pdf_loader.py`/`errors.py`).

**함정**: `src/` 바로 아래(`src/chunkers/`, `src/embedders/`, `src/loaders/`)에도 같은 이름의
디렉터리가 있으나 **비어 있는 부트스트랩 잔재**다. 새 코드를 여기 쓰지 않는다 — 반드시
`src/indexing_runtime/chunkers/` 등 패키지 안쪽에 쓴다. `pyproject.toml`의
`[tool.hatch.build.targets.wheel] packages = ["src/indexing_runtime"]`만 배포되므로 바깥
디렉터리는 애초에 패키징도 안 된다.

Chunking 전략은 `chunkers/__init__.py::chunk_documents`가 profile의 `chunking_strategy`
(`recursive`/`markdown`/`parent_child`)로 dispatch한다. 기본 전략은 `parent_child`
(`profile.py::DEFAULT_PROFILE`). Loader는 MVP(Markdown/Plain Text)와 확장(PDF: `pypdf`, Word:
`.docx`만 — `python-docx`, 레거시 `.doc`은 미지원)로 나뉘며 `LOADED_SUFFIXES`가 지원 확장자 전체다.

## 이 모듈의 경계

`pyproject.toml` dependencies: `ai-asset-schemas`, `observability`, `security-policy`(Classification
중앙 정의 — 공개 패키지 API로 소비, M08 내부 폴더 직접 import 아님), `chromadb`, `rank-bm25`,
`pypdf`, `python-docx`. search-runtime(M08)의 `src/search_runtime/`를 직접 import하지 않는다 —
`chroma_client_cache.py`/`bm25_store.py`처럼 겹치는 모듈은 의도적으로 M07/M08에 각각 복제되어
있다(공유 패키지로 승격하지 않은 이유는 각 파일 docstring 참고).

## 실행

`make dev-indexing-runtime` (`cd services/indexing-runtime && uv run uvicorn
indexing_runtime.main:app --reload --port 8200`)

## 테스트

`tests/unit/indexing_runtime/` — `uv run pytest tests/unit/indexing_runtime/ -v`.
청커별(`test_recursive.py`/`test_markdown.py`/`test_parent_child.py`/`test_heading.py`),
Loader(`test_loaders.py`/`test_pdf_docx_loaders.py`), `test_profile.py`, `test_bm25_store.py`,
`test_convert_bm25_format.py`, `test_chroma_client_cache.py`, `test_classification_stamp.py`,
`test_stamp_classification.py`, `test_main_index_base.py`, `test_models_endpoint.py`,
`test_embed_model_setting.py`, `test_pipeline_heading_metadata.py`, `test_ids.py`로 나뉜다.

## 이 모듈에서 반복해서 틀렸던 것

- **Chroma는 메타데이터에 빈 리스트를 거부한다** — `collection.add()`에 `title_path: []`를 넣으면
  `Expected metadata list value for key 'title_path' to be non empty`로 실패한다. 첫 제목 앞의
  본문(또는 제목이 아예 없는 문서)은 `title_path`가 빈 리스트가 되므로, `chunkers/parent_child.py`는
  `if title_path:`일 때만 그 키를 넣는다 — 빈 문자열/None은 Chroma가 허용하므로 `section`/`anchor`는
  그대로 두고 `title_path`만 이 처리가 필요하다. 메타데이터에 리스트 값을 새로 추가할 때는 반드시
  "비어 있으면 키 자체를 생략"하는 동일 패턴을 따른다.
- **인덱스 기본 경로를 개발자 개인 절대경로로 하드코딩한 적이 있다.** 지금 `main.py`는
  `Path(__file__).resolve().parent.parent.parent.parent.parent`로 저장소 루트를 계산해
  `data/indexes`를 리포 루트 기준 상대경로로 해석한다(`INDEX_BASE` env로 override 가능). 이
  경로 계산 방식을 바꾸거나 새 진입점을 추가할 때는 `_REPO_ROOT` 계산의 `parent` 개수가
  실제 파일 위치(`services/indexing-runtime/src/indexing_runtime/main.py`)와 여전히 맞는지
  확인한다 — 다른 머신(특히 Windows 대상 PC)에서 개발자 개인 경로가 남아있으면 그대로 깨진다.
  **주의**: 같은 종류의 하드코딩이 search-runtime의 `hybrid.py::INDEX_BASE` 기본값에는 아직
  남아 있다(이 모듈은 아님, search-runtime/CLAUDE.md 참고).

## 완료 전 확인

- Chunking 전략을 바꾸거나 추가했다면 `profile.py::_STRATEGIES`/`_MERGEABLE_KEYS`와
  `chunkers/__init__.py::chunk_documents`의 dispatch를 함께 갱신했는가
- 새 Loader(파일 형식)를 추가했다면 `LOADED_SUFFIXES`와 `MissingLoaderDependencyError`
  처리(의존성 미설치 시 명확한 한국어 오류)를 갖췄는가
- 메타데이터에 리스트 타입 필드를 추가했다면 빈 리스트 케이스를 Chroma에 넣기 전에 처리했는가
- Chroma 클라이언트를 새로 열 때 `chroma_client_cache.get_chroma_client()`를 거치는가(직접
  `chromadb.PersistentClient()` 호출 금지 — D-067 스레드/fd 누수 재발 방지)
- `classification`을 다루는 코드가 `None`/미인식 값을 실제 등급으로 추측하지 않고
  `Classification.UNKNOWN`으로 정직하게 남기는가(D-062)
