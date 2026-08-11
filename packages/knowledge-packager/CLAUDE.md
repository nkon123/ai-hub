# packages/knowledge-packager (M09)

`services/indexing-runtime`가 쓴 `data/indexes/{AssetVersion id}/` 디렉터리로부터 Knowledge
Package 디렉터리(ZIP 아님)를 조립하고, §4.1의 7개 검증 체크를 실행한다. `package-knowledge
build`/`package-knowledge verify` 두 CLI 커맨드를 제공한다. ZIP 조립(zip-slip 방어, 권한 수정)은
`services/distribution-service`의 몫이며 이 모듈은 하지 않는다(builder.py 모듈 docstring).

## 먼저 읽을 것

- `docs/implementation-spec/04-knowledge-platform.md` §4.1(Package Assembler),
  §4.2(Source Manifest).
- `packages/schemas/knowledge/knowledge-package.schema.json`,
  `packages/schemas/knowledge/source-manifest.schema.json` — 이 모듈이 만드는 두 산출물의 계약.
- `docs/implementation-spec/open-decisions.md` D-054 — Chroma 잔존 유출, bm25.pkl pickle
  위험, Chroma 열기 시 바이트 변형 문제의 전체 기록.

## 코드 배치

- `builder.py` — `build()`/`verify()` 오케스트레이션 (§4.1 전체 흐름).
- `verification.py` — 7개 검증 체크 함수(`check_manifest_file_list`,
  `check_record_count_reconciliation`, `check_child_parent_referential_integrity`,
  `check_chunk_id_consistency`, `check_profile_model_identity`,
  `check_forbidden_files_and_secrets`, `check_checksum_integrity`) + `run_all_checks()`.
- `index_reader.py` — `data/indexes/` 산출물의 읽기 전용 리더. `read_chroma_snapshot()`이
  Chroma를 여는 유일한 지점(아래 "반복해서 틀렸던 것" 참고).
- `bm25_inspect.py` — `bm25.pkl`을 **절대 unpickle하지 않고** opcode만 disassemble해
  `chunk_ids`를 안전하게 추출(D-054). `relativize.py` — 절대경로를 패키지 상대경로로 재작성.
- `scanner.py` — 금지 파일명/Secret 패턴 스캔(정책 기반, `policy.py`가 YAML 로드).
- `source_manifest.py`, `checksums.py`, `models.py`, `settings.py`, `cli.py`.
- `config/package-policy.yaml` — 금지 파일명/패턴, `known_residual_leak_artifacts`,
  `fail_on_fatal`. 하드코딩 대신 여기서 조정한다.

## 이 모듈의 경계

- `dependencies`(`pyproject.toml`): `ai-asset-schemas`(workspace), `chromadb`, `pyyaml`,
  `pydantic-settings`, `click`. `services/indexing-runtime`을 Python 패키지로 import하지
  않는다(루트 원칙 2) — `index_reader.py`는 그 서비스가 디스크에 남긴 파일 포맷
  (`index-meta.json`/`parents.json`/JSON, `chroma/`/chromadb API)만 읽는다.
- `chromadb`는 `index_reader.py`/`relativize.py` 밖으로 절대 노출하지 않는다(Adapter 뒤에 둠,
  루트 코드 규칙).
- `--out` 경로가 `data/indexes/` 아래이거나 그 상위이면 `build()`가 즉시 `BuildError`로
  거부한다(`builder._reject_if_under_index_base`) — 승인 Version을 수정하는 코드를 만들지
  않는다(루트 코드 규칙)의 실제 가드.

## 실행

```
uv run package-knowledge build --index-dir data/indexes/<id> --out <out_dir> [--asset-manifest ...] [--indexing-profile ...] [--evaluation-result ...] [--relativize-source-paths]
uv run package-knowledge verify --package-dir <package_dir> [--indexing-profile ...]
```

## 테스트

`tests/unit/knowledge_packager/` — `test_builder.py`, `test_verification.py`(7개 체크 각각을
현실적으로 corrupt시켜 실패를 확인), `test_index_reader.py`, `test_bm25_inspect.py`,
`test_policy.py`, `test_relativize.py`, `test_scanner.py`, `test_source_manifest.py`,
`test_cli.py`. `conftest.py`의 `make_index_dir()`로 fixture index 디렉터리를 만든다.
실행: `uv run pytest tests/unit/knowledge_packager/ -v` (기본 `uv run pytest tests/ -q`에 포함).
실제 Package 변조/E2E 검증은 `tests/e2e/test_e2e_03_package_tamper.py`(라이브 스택 필요,
이 모듈 담당자가 직접 돌리지 않는다 — `tests/CLAUDE.md` 참고).

## 이 모듈에서 반복해서 틀렸던 것

- **Chroma는 열기만 해도 파일 바이트가 바뀐다.** `chromadb.PersistentClient`로 디렉터리를
  열면 읽기 전용 쿼리(`Collection.get()`, 쓰기 없음)여도 `chroma.sqlite3` 바이트가 매번
  달라진다(측정으로 3회 연속 확인, 1회성 정착이 아니라 열 때마다). 따라서
  `read_chroma_snapshot()`은 절대 원본 `index_dir/chroma`를 직접 열지 않고, 항상
  `tempfile.TemporaryDirectory`로 복사한 뒤 그 복사본을 연다. 이 규칙을 깨고 원본을
  직접 열면 `checksum_integrity`가 자기 자신의 읽기 때문에 실패하게 된다. Chroma를 다루는
  새 코드(읽기든 쓰기든)는 반드시 이 throwaway-copy 패턴을 따른다.
- **무결성 검사를 내용 검사보다 먼저 수행해야 한다.** `verify()`는 2단계로 나뉜다: 1단계
  (`manifest_file_list_consistency`, `checksum_integrity`)는 디스크의 raw byte만 다루고
  Chroma를 열거나 `bm25.pkl`을 파싱하지 않는다. 1단계가 실패하면 즉시 멈추고 나머지 5개
  체크는 `NOT_RUN`으로 보고한다(`_not_run_check`, `details.not_run=True`) — 실행되지 않은
  것을 조용한 PASS나 조작된 FAIL로 위장하지 않는다. 변조된 패키지를 그냥 열어 2단계로
  진행하면 `chromadb.errors.InternalError: database disk image is malformed` 같은 예외가
  빌드 호스트 절대경로가 담긴 traceback과 함께 CLI 밖으로 새어 나갔었다. 2단계(내용 검사)는
  1단계 통과 후에만 실행되며, 그 안에서도 읽기 실패는 `except Exception`으로 잡아
  `_content_check_read_error`로 변환한다 — 어떤 경로로도 unhandled exception이 CLI까지
  올라가지 않는다.
- 검증 체크는 총 **7개**(`verification._ALL_CHECKS`), `verify()`는 항상 이 7개 전부를
  보고한다(1단계 실패 시 2개 실제 결과 + 5개 NOT_RUN).

## 완료 전 확인

- Chroma를 새로 읽거나 쓰는 코드를 추가했다면 throwaway-copy 패턴을 따랐는가.
- 새 검증 체크를 추가했다면 `_ALL_CHECKS`와 `verify()`의 2단계 분류(`_CONTENT_CHECK_NAMES`/
  `_CONTENT_CHECK_FUNCS`) 양쪽에 반영했는가 — 하나만 바꾸면 `build()`와 `verify()`가
  다른 체크 집합을 실행하게 된다.
- 예외가 CLI까지 traceback으로 새어 나가지 않는가(`sanitize_text`로 빌드 호스트 경로가
  가려지는가).
- `bm25.pkl`을 다루는 코드가 `pickle.load`/`pickle.loads`를 절대 호출하지 않는가.
