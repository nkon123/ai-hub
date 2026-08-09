# Knowledge 구축·검색·평가 상세 명세

대상 모듈: M07, M08, M09  
사용자 표기: Knowledge, 지식 자산, 지식 검색  
내부 코드 Prefix: `knowledge_*`, `indexing_*`, `retrieval_*`

## 1. 전체 구조

```text
[Knowledge 구축]
Source Document
  → Loader
  → Parser/Normalizer
  → Chunking Strategy
  → Metadata/ID/Hash
  → Embedding
  → Vector Index + Keyword Index
  → Knowledge Package
  → Evaluation

[Knowledge 검색]
User Query
  → Normalize/Rewrite
  ├→ Vector Search
  └→ BM25 Search
  → RRF Fusion
  → Metadata/ACL Filter
  → Parent Expansion
  → Deduplication
  → Context Budget
  → Citation Context
```

Indexing Runtime과 Search Runtime을 별도 모듈로 유지한다. 인덱싱에 사용하는 무거운 문서 처리 의존성이 일반 사용자 실행 Runtime에 포함되지 않도록 한다.

## 2. M07 Knowledge Indexing Runtime

### 2.1 실행 인터페이스

권장 CLI:

```text
knowledge-index validate-source --source <dir> --profile <yaml>
knowledge-index build --source <dir> --profile <yaml> --output <dir>
knowledge-index update --package <dir> --source <dir> --profile <yaml>
knowledge-index inspect --package <dir>
knowledge-index smoke-test --package <dir> --query <text>
```

공통 옵션:

- `--json`: 기계 판독 JSON 출력
- `--job-id`: 외부 Job과 연결
- `--resume`: Checkpoint에서 재개
- `--log-dir`: 구조화 로그 경로
- `--fail-on-warning`: 경고를 실패로 처리

### 2.2 Indexing Job 상태

```text
CREATED
→ VALIDATING_SOURCE
→ LOADING
→ PARSING
→ CHUNKING
→ EMBEDDING
→ BUILDING_VECTOR_INDEX
→ BUILDING_KEYWORD_INDEX
→ VERIFYING
→ PACKAGING_READY
→ SUCCEEDED
```

각 단계는 처리 문서 수, 전체 문서 수, 처리 청크 수, 실패 수, 경과시간을 보고한다.

### 2.3 Document Loader

MVP Loader:

- Markdown
- Plain Text

확장 Loader:

- PDF
- HTML
- Word
- PowerPoint
- Excel
- Source Code

공통 Loader 출력:

```json
{
  "document_id": "stable-id",
  "content": "...",
  "metadata": {
    "source_path": "policies/hr.md",
    "file_name": "hr.md",
    "source_hash": "sha256",
    "mime_type": "text/markdown",
    "language": "ko",
    "modified_at": "2026-08-02T00:00:00Z"
  }
}
```

Loader 요구사항:

- 파일 경로 정렬을 통해 재현 가능한 처리 순서 보장
- Encoding 오류를 문서별 오류로 기록
- Include/Exclude Pattern 적용
- Symbolic Link는 기본 금지
- 최대 파일 크기와 총 용량 정책 적용
- 원본 Binary는 Chunk에 저장하지 않음

### 2.4 Parser/Normalizer

공통 처리:

- Unicode 정규화
- 줄바꿈 통일
- 불필요한 연속 공백 정리
- 페이지·제목·Section 구조 보존
- 표·코드 블록의 경계 보존
- 반복 Header/Footer 제거는 Parser별 설정
- 문서 본문을 임의 요약하거나 재작성하지 않음

Parsed Document는 Source 위치를 추적할 수 있어야 한다.

### 2.5 Chunking Strategy

#### Recursive

적합 대상: 일반 Text, 구조가 약한 문서

- 문단 → 줄 → 문장 → 공백 → 문자 순 분할
- `child.size`, `child.overlap`, `minimum_size` 적용
- 너무 짧은 마지막 청크는 앞 청크와 병합 가능

#### Markdown

적합 대상: 규정, 매뉴얼, Wiki

1. `#`, `##`, `###` 제목으로 Section 분리
2. Section Metadata에 Title Path 저장
3. 큰 Section만 Recursive 분할
4. Chunk 본문 또는 Metadata에 제목 Context 포함

#### Parent-Child

적합 대상: 긴 규정, 업무 지침, 문맥이 중요한 문서

1. Parent Splitter로 큰 문맥 생성
2. Parent별 Stable ID 생성
3. Parent를 Child Splitter로 분할
4. Child에 `parent_id`만 저장
5. Parent 본문은 `parents.jsonl` 또는 Parent Store에 한 번만 저장

금지:

- 모든 Child Metadata에 Parent 본문을 중복 저장
- 문서가 바뀌지 않았는데 처리 순서 때문에 ID가 변경되는 구현

### 2.6 ID와 Hash

- `document_id`: Source Namespace + 정규화 상대경로
- `source_hash`: 원본 Bytes SHA-256
- `parser_hash`: Parser 이름·버전·설정
- `parent_id`: document_id + Parent 순서/Anchor + Parent Hash
- `chunk_id`: parent_id + Child 순서/Anchor + Child Hash
- `embedding_identity`: Provider·Model·Dimension·Normalize 설정 Hash
- `index_build_id`: 모든 입력 Manifest Hash

Hash는 변경 감지와 재현성에 사용하며 권한 Token으로 사용하지 않는다.

### 2.7 Metadata

공통 필수 Metadata:

- document_id, chunk_id, parent_id
- source_path, file_name, document_version
- title, section, subsection
- page 또는 location
- language
- document_type
- owner_organization
- classification
- status
- source_hash
- indexing_profile_version

업무 Metadata는 Schema로 확장한다.

예:

- department
- business_system
- component
- class_name
- method_name
- regulation_number
- effective_date

### 2.8 Embedding Service

요구사항:

- Office Profile의 Model Alias 해석
- Ollama Health와 Model 존재 검사
- Batch 처리
- Timeout과 지수형 Retry
- 실패한 Batch와 Chunk ID 기록
- 취소와 Checkpoint
- 입력 Text의 최대 길이 사전 검사
- 반환 Vector 개수와 Dimension 검사
- Normalize 설정 적용·기록

Embedding 결과 자체를 별도 `embeddings` Artifact로 보관하는 기능은 확장 범위다. PoC는 Vector Store에 저장하되 Model Identity를 Manifest에 반드시 기록한다.

### 2.9 Vector Index

Chroma PoC 요구사항:

- Collection 이름과 Distance 설정
- `chunk_id`를 Record ID로 사용
- Upsert 지원
- Metadata Type 검증
- 저장 완료 후 Record 수 대사
- 임의 샘플 Query로 Dimension과 검색 가능 여부 확인
- Chroma Library/Storage 호환 정보를 Manifest에 기록

### 2.10 BM25 Index

- Child Document와 동일 `chunk_id` 사용
- 검색 Text와 최소 Metadata 저장
- Build 결과를 파일로 영속화
- Search Runtime 시작 시 매번 Chroma 전체를 읽어 재생성하지 않음
- PoC 공백 Tokenizer 결과를 기준선으로 기록
- 한국어 형태소 Tokenizer는 동일 평가 데이터로 비교 후 채택

### 2.11 증분 인덱싱

확장 기능이나 인터페이스는 미리 정의한다.

1. Source Manifest 비교
2. 신규·변경·삭제 문서 식별
3. 변경 문서만 Parse/Chunk/Embed
4. 삭제 Chunk와 Parent 제거
5. Vector/BM25 Index Upsert/Delete
6. 새 Build Manifest 작성
7. 전체 개수와 참조 무결성 검증

전체 재색인과 증분 결과가 검색상 동등한지 회귀 테스트한다.

### 2.12 Build Result

```json
{
  "job_id": "uuid",
  "build_id": "hash",
  "status": "SUCCEEDED",
  "documents": 120,
  "parents": 840,
  "chunks": 3120,
  "embedded": 3120,
  "failures": 0,
  "duration_seconds": 418.2,
  "outputs": {
    "chunks": "chunks/chunks.jsonl",
    "parents": "chunks/parents.jsonl",
    "vector_index": "indexes/chroma",
    "keyword_index": "indexes/bm25"
  },
  "warnings": []
}
```

## 3. M08 Knowledge Search Runtime

### 3.1 Public Interface

Python 또는 Local REST Contract:

```text
search(request) -> SearchResponse
health(knowledge_id, version) -> KnowledgeStatus
explain(search_id) -> SearchTrace
```

요청:

```json
{
  "query": "아이 돌봄 때문에 장기간 쉬는 제도",
  "knowledge": {
    "asset_id": "knowledge-uuid",
    "version": "1.0.0",
    "retrieval_profile": "hr-policy-retrieval"
  },
  "filters": {
    "department": "HR"
  },
  "access_context": {
    "user_id": "user-uuid",
    "organization_id": "org-hr",
    "permissions": ["knowledge.hr_policy.read"]
  },
  "limits": {
    "max_context_tokens": 5000
  },
  "trace_id": "trace-uuid"
}
```

응답:

```json
{
  "search_id": "uuid",
  "original_query": "아이 돌봄 때문에 장기간 쉬는 제도",
  "rewritten_query": "육아휴직 신청 대상 및 절차",
  "documents": [
    {
      "document_id": "doc-id",
      "chunk_id": "child-id",
      "parent_id": "parent-id",
      "content": "...",
      "citation": {
        "display_title": "인사 규정",
        "section": "육아휴직",
        "location": "제3장"
      },
      "scores": {
        "vector_rank": 2,
        "bm25_rank": 1,
        "fusion_score": 0.027
      }
    }
  ],
  "timing_ms": {
    "rewrite": 210,
    "vector": 80,
    "bm25": 15,
    "fusion_context": 20,
    "total": 325
  }
}
```

### 3.2 초기화와 호환성

- Knowledge Manifest Schema 지원 여부
- Chroma/BM25 Index 존재
- Manifest Record 수와 실제 Index 개수
- Embedding Model Identity와 현재 Alias Identity 일치
- Metadata Schema 존재
- Retrieval Profile 검증
- Parent 참조 무결성
- Checksum 상태

문제가 있는 Knowledge는 `INVALID` 상태로 격리한다.

### 3.3 Query Normalization

- 앞뒤 공백과 제어문자 정리
- 최대 Query 길이 적용
- 빈 Query 거부
- 사용자 원문은 임의로 변경하지 않고 별도 필드에 유지
- 검색 Log에는 정책에 따라 Hash 또는 Masked Query 사용

### 3.4 Query Rewrite

규칙:

- 답변하지 않고 검색 Query만 반환
- 사용자 의도에 없는 사실을 추가하지 않음
- 업무 고유명사·코드·숫자를 보존
- 한 줄 Text 또는 명시적 JSON Schema 사용
- Timeout 또는 Output 오류 시 원문 Fallback
- Rewrite 원문과 결과를 Search Trace에 저장하되 민감정보 정책 적용

### 3.5 Vector Search

- Retrieval Profile의 `top_k`
- Metadata Filter를 가능한 경우 Store Query에 적용
- Distance/Similarity Score의 의미를 Manifest에 맞게 처리
- Query Embedding 실패를 별도 오류로 구분
- Raw Score를 다른 Retriever Score와 직접 더하지 않음

### 3.6 BM25 Search

- Build 시 사용한 Tokenizer Identity와 동일 Tokenizer 사용
- 정확한 업무 용어·문서번호·코드 검색 지원
- ACL/Metadata Filter를 검색 전 또는 직후 강제
- 전체 문서를 매 요청마다 재로딩하지 않음

### 3.7 Hybrid와 RRF

```text
score(document) = Σ weight / (rrf_constant + rank)
```

- Retriever별 중복 Chunk는 `chunk_id`로 합친다.
- Weight와 RRF Constant는 Retrieval Profile에서 읽는다.
- 비활성 Retriever는 계산에서 제외한다.
- Tie는 가장 좋은 개별 Rank, 그다음 Chunk ID로 안정적으로 정렬한다.

### 3.8 Filter와 ACL

순서:

1. 사용자 Access Context 검증
2. 강제 ACL Filter 생성
3. Profile Default Filter 적용
4. 사용자가 요청한 허용 Filter 적용
5. 충돌 시 더 제한적인 조건 사용

사용자가 요청에서 ACL Field를 덮어쓸 수 없다.

### 3.9 Parent Expansion

- 검색은 Child로 수행한다.
- 최종 Context는 Parent Store에서 Parent 본문을 읽는다.
- 동일 Parent의 여러 Child는 하나로 합친다.
- 어떤 Child가 Parent를 선택하게 했는지 `retrieved_child_ids`에 기록한다.
- Parent가 없으면 Child를 사용하고 경고를 기록한다.

### 3.10 Deduplication과 다양성

- 동일 Chunk ID 제거
- 동일 Parent ID 제거
- 동일 Source의 결과가 과도하게 편중될 때 Profile 기반 Source Limit 가능
- 단순 문자열 중복 제거는 확장 기능

### 3.11 Context Budget

1. 최종 후보를 관련도 순으로 정렬
2. Citation Metadata 비용 포함
3. 최대 Context Token까지 Parent 또는 Child 추가
4. 한 문서를 중간에서 임의 자르지 않도록 우선 처리
5. 제외된 후보는 Trace에 이유 기록

Token 계산은 실제 Generation Model Tokenizer와 다를 수 있으므로 안전 여유를 둔다.

### 3.12 Citation

필수 필드:

- document_id
- display_title
- section 또는 location
- source_version
- chunk_id 또는 parent_id

선택 필드:

- page
- source_uri; 접근 가능한 내부 URI만
- excerpt; 사용자 권한에 따라 제공

Citation은 답변 후 임의 생성하지 않고 Search Result에서 전달한다.

### 3.13 Reranking Extension

PoC에서는 비활성이다. 다음 Interface만 정의한다.

```text
rerank(query, candidates, top_n, access_context) -> ranked_candidates
```

Cross Encoder 또는 LLM Reranker를 추가할 경우 평가 데이터로 기본 Hybrid 대비 개선을 입증해야 한다.

### 3.14 Search Trace

기록:

- Original/Rewritten Query의 Sanitized 값
- 사용 Knowledge와 Profile 버전
- Retriever별 Rank와 Score
- 적용 Filter와 ACL Policy ID
- Fusion 결과
- Parent Expansion과 Dedup 결과
- Context 제외 이유
- 단계별 시간
- 오류와 Fallback

일반 사용자에게 Raw Trace를 노출하지 않는다.

## 4. M09 Knowledge Package & Evaluation

### 4.1 Package Assembler

입력:

- Build Result
- Source Manifest
- Parsed Documents 선택 Artifact
- Chunks/Parents
- Chroma/BM25 Index
- Indexing/Retrieval Profile
- Metadata Schema
- Evaluation Dataset/Result
- Data Card

검증:

- Manifest File List와 실제 파일 일치
- Record 수 대사
- Child→Parent 참조 무결성
- Chunk ID와 Vector/BM25 Record ID 일치
- Profile에 선언된 Model Identity와 Build Identity 일치
- 금지 파일과 Secret Pattern 없음
- Checksum 생성

### 4.2 Source Manifest

문서별 필드:

- document_id
- display_name
- relative_source_path
- source_hash
- source_version
- owner
- classification
- license_or_usage_basis
- effective_date
- status
- parser identity

Source 원본을 Package에 포함할지는 저작권·보안 정책으로 결정한다. 포함하지 않아도 Source Manifest와 Parsed/Chunk Trace는 존재해야 한다.

### 4.3 Evaluation Dataset

```json
{
  "case_id": "HR-001",
  "question": "병가 신청에 필요한 서류는 무엇인가?",
  "expected_document_ids": ["hr-policy"],
  "expected_chunk_ids": ["chunk-sick-leave-proof"],
  "required_filters": {
    "status": "active"
  },
  "forbidden_document_ids": [],
  "tags": ["병가", "정확검색"]
}
```

평가 질문은 업무 전문가가 검토한다. 생성형 AI가 만든 질문은 사람 검토 없이 기준 데이터로 사용하지 않는다.

### 4.4 검색 평가

필수 지표:

- Recall@1
- Recall@5
- MRR
- 검색 결과 없음 비율
- P50/P95 Search Latency
- 평균 Context Token

선택 지표:

- Precision@K
- NDCG
- Source Diversity
- Filter 정확도

### 4.5 답변 평가

확장 지표:

- Citation 존재
- Citation이 실제 Context에 포함
- 답변의 주장과 근거 일치
- 근거 부족 시 답변 거절
- 금지 문서 또는 권한 밖 문서 사용 여부

자동 LLM Judge만으로 승인하지 않는다. 대표 Case는 수동 검토 결과를 함께 보관한다.

### 4.6 버전 비교

Report:

- 기존/후보 Knowledge Version
- 동일 Evaluation Dataset Version
- Profile 차이
- Recall/MRR/Latency 변화
- 개선/퇴행 Case 목록
- Package 크기와 Index 수 변화
- 승인 권고 또는 차단 이유

### 4.7 Quality Gate

PoC 기본 제안:

- Recall@5 80% 이상
- 이전 승인 버전보다 Recall@5가 5%p 이상 하락하지 않음
- 기대 문서가 없는 질문에서 치명적 오검색이 없음
- 모든 ACL Test 통과
- 평가 환경에서 P95 Search 2초 이하
- Package Smoke Test 통과

수치는 최초 실험 후 조정하며 코드에 하드코딩하지 않고 정책 설정으로 관리한다.

### 4.8 Data Card

필수 Section:

- 목적과 적합한 사용 사례
- 포함 Source 범위와 기준일
- 제외 Source
- 소유자와 문의처
- Parser/Chunk/Embedding/Index 전략
- 기본 Retrieval Profile
- 평가 데이터와 결과
- 알려진 제한사항
- 보안등급과 접근 조건
- 업데이트 방법
- 호환 Runtime/Model

## 5. Knowledge 오류코드

| 코드 | 의미 |
|---|---|
| `KNOWLEDGE_SOURCE_INVALID` | Source 파일 또는 Metadata 오류 |
| `KNOWLEDGE_PROFILE_INVALID` | Indexing/Retrieval Profile 오류 |
| `KNOWLEDGE_EMBEDDING_UNAVAILABLE` | Embedding 모델 연결 실패 |
| `KNOWLEDGE_EMBEDDING_MISMATCH` | 문서·질의 Embedding Identity 불일치 |
| `KNOWLEDGE_INDEX_CORRUPT` | Index 파일 손상 또는 Record 대사 실패 |
| `KNOWLEDGE_PARENT_MISSING` | Child가 참조하는 Parent 없음 |
| `KNOWLEDGE_ACCESS_DENIED` | Knowledge 또는 문서 접근 권한 없음 |
| `KNOWLEDGE_SEARCH_TIMEOUT` | 검색 Timeout |
| `KNOWLEDGE_NO_RESULTS` | 허용 범위 내 결과 없음; 오류가 아닌 상태 가능 |
| `KNOWLEDGE_PACKAGE_INCOMPATIBLE` | Runtime/Schema/Model 호환 실패 |

## 6. 인수 기준

- 동일 Source와 Indexing Profile로 재실행했을 때 동일 Stable ID를 생성한다.
- Recursive, Markdown, Parent-Child가 선택 가능하다.
- Vector, BM25, Hybrid RRF가 Retrieval Profile로 교체된다.
- Child 검색 후 Parent Context와 Citation을 반환한다.
- Embedding Model 불일치를 실행 전에 탐지한다.
- ACL Filter를 사용자 Filter보다 우선한다.
- Chroma 전체 문서를 읽어 BM25를 매 시작마다 재구성하지 않는다.
- `chunks.jsonl`, `parents.jsonl`, Index, Profile, 평가 결과가 포함된 Knowledge Package를 생성한다.
- 동일 평가 데이터로 Knowledge Version을 비교할 수 있다.

