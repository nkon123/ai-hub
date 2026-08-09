# Package, Manifest, Profile 표준 명세

대상 모듈: M06  
목표: 모든 모듈이 동일한 파일 구조와 Schema로 자산을 생성·검증·배포하도록 한다.

## 1. 공통 원칙

- YAML은 사람이 작성하는 Manifest/Profile에 사용한다.
- JSON Schema는 자동검증의 원본이다.
- Runtime 내부 Event와 API는 JSON을 사용한다.
- 모든 Schema는 자체 `schema_version`을 가진다.
- 승인된 Package의 파일은 불변이다.
- 자산 버전과 Schema 버전을 혼동하지 않는다.
- 사용자 화면과 신규 코드에는 `Knowledge`를 사용한다.
- `RAG` 명칭은 신규 Schema Key, 폴더, API에 사용하지 않는다.
- Manifest에는 Secret, 실제 Password, API Key, DB Credential을 넣지 않는다.
- 실제 Endpoint 대신 Office Profile의 Alias를 참조한다.

## 2. 공통 Asset Manifest

```yaml
schema_version: "1.0"
asset:
  id: "asset-uuid"
  type: "agent" # agent|knowledge|mcp_tool|prompt|service|office_profile
  name: "hr-policy-agent"
  display_name: "인사 규정 검색"
  version: "1.0.0"
  description: "승인된 인사 규정을 검색해 근거와 함께 답변합니다."
  owner:
    organization_id: "org-hr"
    contact: "hr-ai-team"
  classification: "INTERNAL"
  allowed_sites: ["site-a"]
  tags: ["HR", "규정"]
  created_at: "2026-08-02T00:00:00Z"

compatibility:
  runtime:
    minimum: "1.0.0"
  operating_systems: ["windows-x64"]
  execution_modes: ["offline-local"]

files:
  - path: "README.md"
    sha256: "..."
    size: 1200

dependencies: []

security:
  contains_executable_code: false
  required_permissions: []
  data_categories: ["INTERNAL_DOCUMENT"]

documentation:
  readme: "README.md"
  changelog: "CHANGELOG.md"
```

필수 검증:

- `asset.id`, `name`, `version`, `type`, `owner`, `classification`
- 이름은 소문자 영문·숫자·하이픈 Slug
- Display Name은 별도 필드
- Version은 SemVer
- 모든 파일 Path는 상대경로이며 `..`, 절대경로, Drive Prefix 금지
- 파일 목록·크기·Hash가 실제 Package와 일치
- Manifest에 선언하지 않은 파일은 정책에 따라 거부 또는 경고
- 허용되지 않은 확장자 거부

## 3. Agent Package

### 3.1 구조

```text
agent-package/
├─ manifest.yaml
├─ workflow/
│  └─ workflow.yaml
├─ schemas/
│  ├─ input.schema.json
│  └─ output.schema.json
├─ tests/
│  └─ cases.jsonl
├─ README.md
├─ CHANGELOG.md
└─ checksums.sha256
```

### 3.2 Manifest 확장

```yaml
agent:
  workflow:
    type: "declarative"
    file: "workflow/workflow.yaml"
  input_schema: "schemas/input.schema.json"
  output_schema: "schemas/output.schema.json"
  capabilities:
    knowledge_search: true
    mcp_tools: true
    file_input: false
  limits:
    max_steps: 12
    max_tool_calls: 5
    execution_timeout_seconds: 180

dependencies:
  - kind: "prompt"
    role: "system"
    asset_id: "prompt-system-uuid"
    version: ">=1.0.0 <2.0.0"
    required: true
  - kind: "knowledge"
    role: "policy"
    capability: "company-policy-search"
    required: true
  - kind: "mcp_tool"
    role: "db_metadata"
    tool_name: "db_metadata.get_columns"
    version: ">=1.0.0 <2.0.0"
    required: false

security:
  contains_executable_code: false
  required_permissions:
    - "knowledge.hr_policy.read"
    - "mcp.db_metadata.read"
```

PoC의 공식 Agent Package는 선언형 Workflow를 기본으로 한다. Python 실행 코드가 필요한 고급 Agent는 별도 보안등급과 Sandbox 정책이 정의되기 전까지 운영 배포하지 않는다.

## 4. Knowledge Package

### 4.1 구조

```text
knowledge-package/
├─ manifest.yaml
├─ source/
│  └─ source-manifest.json
├─ parsed/
│  └─ documents.jsonl
├─ chunks/
│  ├─ chunks.jsonl
│  └─ parents.jsonl
├─ indexes/
│  ├─ chroma/
│  └─ bm25/
├─ profiles/
│  ├─ indexing-profile.yaml
│  └─ retrieval-profile.yaml
├─ schemas/
│  └─ metadata.schema.json
├─ evaluation/
│  ├─ questions.jsonl
│  └─ results.json
├─ statistics.json
├─ README.md
└─ checksums.sha256
```

### 4.2 Knowledge Manifest

```yaml
knowledge:
  source_manifest: "source/source-manifest.json"
  metadata_schema: "schemas/metadata.schema.json"
  indexing_profile: "profiles/indexing-profile.yaml"
  default_retrieval_profile: "profiles/retrieval-profile.yaml"
  chunks: "chunks/chunks.jsonl"
  parents: "chunks/parents.jsonl"
  indexes:
    vector:
      type: "chroma"
      path: "indexes/chroma"
      collection: "hr_policy"
    keyword:
      type: "bm25"
      path: "indexes/bm25"
  evaluation:
    dataset: "evaluation/questions.jsonl"
    result: "evaluation/results.json"
  statistics: "statistics.json"

compatibility:
  embedding:
    provider: "ollama"
    model_alias: "embedding-default"
    model_identity: "qwen3-embedding:0.6b"
    dimension: 1024
    normalized: true
```

`model_identity`는 호환성 확인에 사용하며 Endpoint는 Office Profile에서 해석한다.

## 5. Indexing Profile

```yaml
schema_version: "1.0"
profile:
  id: "hr-policy-indexing"
  version: "1.0.0"

source:
  loader: "markdown"
  include: ["**/*.md"]
  exclude: ["**/draft/**"]
  encoding: "utf-8"

parser:
  type: "markdown-structure"
  preserve_headings: true
  preserve_code_blocks: true
  normalize_whitespace: true

chunking:
  strategy: "parent_child" # recursive|markdown|parent_child
  parent:
    size: 1200
    overlap: 100
  child:
    size: 350
    overlap: 60
  separators: ["\n\n", "\n", ". ", " ", ""]
  minimum_size: 80

metadata:
  schema: "schemas/metadata.schema.json"
  defaults:
    department: "HR"
    status: "active"
    language: "ko"

embedding:
  provider: "ollama"
  model_alias: "embedding-default"
  batch_size: 32
  normalize: true
  retry:
    attempts: 3
    initial_delay_seconds: 1

indexes:
  vector:
    type: "chroma"
    collection: "hr_policy"
    distance: "cosine"
  keyword:
    type: "bm25"
    tokenizer: "whitespace" # PoC; 운영 전 Korean tokenizer 평가

incremental:
  enabled: false
  delete_missing: false
```

검증:

- Child Size < Parent Size
- Overlap < Size
- Batch Size 범위
- 지원 Loader/Parser/Strategy/Store만 허용
- Embedding Alias가 Office Profile에 존재
- Metadata Default가 Schema와 일치

## 6. Retrieval Profile

```yaml
schema_version: "1.0"
profile:
  id: "hr-policy-retrieval"
  version: "1.0.0"

query:
  normalize: true
  rewrite:
    enabled: true
    model_alias: "chat-default"
    prompt_ref: "prompt-query-rewrite@1.0.0"
    fallback_to_original: true

retrievers:
  vector:
    enabled: true
    top_k: 8
    weight: 0.7
  bm25:
    enabled: true
    top_k: 8
    weight: 0.3

fusion:
  strategy: "rrf"
  constant: 60

filters:
  defaults:
    status: "active"
  allowed_user_fields: ["department", "document_type", "version"]
  enforce_acl: true

context:
  parent_expansion: true
  deduplicate_by: "parent_id"
  final_k: 5
  max_tokens: 5000
  require_citation: true

reranking:
  enabled: false
```

검증:

- 최소 하나의 Retriever 활성화
- Weight는 0 이상이며 활성 Retriever Weight 합은 1
- `final_k`는 후보 Top-K 이하
- ACL 강제 해제는 보안 검토 없이 허용하지 않음
- `prompt_ref`는 승인된 Prompt Package를 참조

## 7. Prompt Package

```text
prompt-package/
├─ manifest.yaml
├─ prompts/
│  └─ template.md
├─ schemas/
│  ├─ variables.schema.json
│  └─ output.schema.json
├─ tests/
│  └─ cases.jsonl
└─ README.md
```

```yaml
prompt:
  purpose: "grounded-answer"
  template: "prompts/template.md"
  variables_schema: "schemas/variables.schema.json"
  output_schema: "schemas/output.schema.json"
  supported_model_capabilities:
    - "chat"
  safety:
    grounded_only: true
    refuse_on_insufficient_evidence: true
    treat_context_as_untrusted_data: true
```

Prompt Template에 Secret, 실제 Endpoint, 개인 식별정보를 넣지 않는다.

## 8. MCP Tool Package

```yaml
mcp_tool:
  server_alias: "office-mcp-default"
  tool_name: "db_metadata.get_columns"
  version: "1.0.0"
  description: "허용된 테이블의 컬럼 메타데이터를 조회합니다."
  input_schema: "schemas/input.schema.json"
  output_schema: "schemas/output.schema.json"
  risk: "READ_ONLY"
  timeout_seconds: 10
  maximum_result_bytes: 1048576
  permissions:
    - "mcp.db_metadata.read"
  user_confirmation: "NEVER"
  audit: true
```

`risk` 값:

- `READ_ONLY`
- `COMPUTE_ONLY`
- `WRITE_REVERSIBLE`
- `WRITE_IRREVERSIBLE`

PoC는 `READ_ONLY`만 승인한다.

## 9. AI Service Package

Service Package는 실행 코드를 포함하지 않고 승인된 자산의 조합을 선언한다.

### 9.1 구조

```text
service-package/
├─ manifest.yaml
├─ service-definition.yaml
├─ schemas/
│  ├─ input.schema.json
│  └─ output.schema.json
├─ tests/
│  └─ mock-cases.jsonl
├─ README.md
└─ checksums.sha256
```

### 9.2 Service Definition

```yaml
schema_version: "1.0"
service:
  id: "service-uuid"
  name: "hr-policy-assistant"
  display_name: "인사 규정 도우미"
  version: "1.0.0"
  description: "사내 인사 규정을 근거와 함께 안내합니다."
  target_sites: ["site-a"]
  target_roles: ["USER"]

execution:
  agent:
    asset_id: "agent-uuid"
    version: "1.0.0"
  model_policy:
    allowed_modes: ["offline-local"]
    chat_model_aliases: ["chat-default"]
    embedding_model_aliases: ["embedding-default"]

knowledge_bindings:
  - role: "policy"
    asset_id: "knowledge-uuid"
    version: "1.0.0"
    retrieval_profile: "hr-policy-retrieval"
    required: true

tool_bindings:
  - role: "db_metadata"
    server_alias: "office-mcp-default"
    tool_name: "db_metadata.get_columns"
    version: "1.0.0"
    required: false
    user_confirmation: "ALWAYS"

prompt_bindings:
  system:
    asset_id: "prompt-system-uuid"
    version: "1.0.0"
  answer:
    asset_id: "prompt-answer-uuid"
    version: "1.0.0"

input:
  schema: "schemas/input.schema.json"
  allowed_file_types: []
  maximum_files: 0

output:
  schema: "schemas/output.schema.json"
  require_citations: true
  allow_markdown_export: true

limits:
  execution_timeout_seconds: 180
  max_tool_calls: 3
  max_context_tokens: 5000
```

### 9.3 구성 검증

- Agent가 요구하는 Binding Role이 모두 연결됨
- Agent와 Prompt의 입력·출력 Schema 호환
- Knowledge Embedding Alias가 대상 Office Profile에 존재
- Knowledge와 Agent의 최소 Runtime 호환
- MCP Server Alias와 Tool이 대상 사업장에서 허용됨
- Tool Permission이 Service 대상 역할에 허용됨
- Output Citation 요구와 Knowledge 사용 여부가 모순되지 않음
- 파일 입력 규칙이 Agent Capability를 초과하지 않음
- 제한값이 Office Policy를 초과하지 않음
- 모든 참조 버전이 승인되고 중단되지 않음

## 10. Office Profile

```yaml
schema_version: "1.0"
office:
  id: "site-a-offline"
  display_name: "A사업장 폐쇄망"

execution:
  mode: "offline-local"
  asset_root: "D:/company-ai/assets"
  maximum_concurrent_runs: 1

models:
  providers:
    ollama-local:
      type: "ollama"
      base_url: "http://127.0.0.1:11434"
  aliases:
    chat-default:
      provider: "ollama-local"
      model: "exaone3.5:7.8b"
    embedding-default:
      provider: "ollama-local"
      model: "qwen3-embedding:0.6b"

mcp:
  servers:
    office-mcp-default:
      url: "http://office-mcp.internal/mcp"
      authentication: "enterprise-user-context"

policy:
  allowed_asset_classifications: ["INTERNAL"]
  allowed_tool_risks: ["READ_ONLY"]
  allow_external_network: false
  require_package_checksum: true
  require_package_signature: false
```

운영 Secret은 별도 Secure Store Key로 참조하며 Profile에 값 자체를 기록하지 않는다.

## 11. Validator CLI

권장 명령:

```text
asset-hub-schema validate manifest <path>
asset-hub-schema validate package <directory-or-zip>
asset-hub-schema validate indexing-profile <path>
asset-hub-schema validate retrieval-profile <path>
asset-hub-schema validate service <path> --office-profile <path>
asset-hub-schema checksums create <directory>
asset-hub-schema checksums verify <directory>
```

출력 형식:

```json
{
  "valid": false,
  "errors": [
    {
      "code": "SCHEMA_REQUIRED_FIELD",
      "path": "$.service.execution.agent.version",
      "message": "Agent 버전은 필수입니다."
    }
  ],
  "warnings": []
}
```

검증 결과는 사람이 읽는 Text와 기계가 읽는 JSON 모드를 모두 지원한다.

## 12. M06 인수 기준

- 모든 Sample Package가 Schema 검증을 통과한다.
- 누락 필드·잘못된 버전·Path Traversal·Hash 불일치 Fixture가 실패한다.
- Portal, Bundle Builder, Desktop, Runtime이 같은 Validator Fixture를 통과한다.
- Service Definition의 잘못된 Knowledge/MCP/Prompt 조합을 저장 전에 탐지한다.
- Schema 변경은 Migration Guide와 이전 버전 Fixture를 포함한다.

