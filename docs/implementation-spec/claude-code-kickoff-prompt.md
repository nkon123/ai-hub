# Claude Code 최초 실행 요청 Prompt

아래 내용을 Claude Code에 전달한다.

---

이 저장소에 Enterprise AI Asset Hub PoC를 구현해 주세요.

구현을 시작하기 전에 반드시 다음 순서로 문서를 읽으세요.

1. `CLAUDE.md`
2. `docs/implementation-spec/README.md`
3. `docs/implementation-spec/open-decisions.md`
4. 이번 단계와 관련된 상세 명세

중요한 제품 원칙:

- 사용자 화면과 신규 코드에서는 RAG라는 용어 대신 Knowledge/지식 자산을 사용합니다.
- Langflow와 자유형 Drag & Drop Canvas는 구현하지 않습니다.
- 비개발자는 단계형 Service Composer Wizard로 Agent, Knowledge, MCP Tool, Prompt, 모델 정책을 조합합니다.
- 중앙 Portal은 자산의 등록·검토·승인·배포를 담당합니다. Desktop 실행은 Local Agent Runtime, URL 게시형 챗봇은 별도 Hosted Agent Runtime에서 수행합니다.
- 발표 MVP에는 등록된 Knowledge로 챗봇을 빠르게 구성하고, 실제 Knowledge로 Preview한 후 `/chat/{slug}` 내부 URL로 게시하는 흐름이 필요합니다.
- 폐쇄망에서도 Offline Bundle로 설치·실행할 수 있어야 합니다.
- MCP PoC는 읽기 전용 Tool만 허용합니다.
- 임의 Python 실행, 임의 URL 연결, 임의 Package 설치 기능은 만들지 마세요.

한 번에 전체 시스템을 생성하지 마세요. 먼저 Phase 0만 진행하세요.

Phase 0 목표:

1. 현재 저장소 상태를 조사합니다.
2. 명세와 충돌하는 기존 코드가 있는지 확인합니다.
3. 권장 Monorepo 디렉터리 구조를 만듭니다.
4. 각 App/Service/Package에 최소 실행 가능한 Skeleton을 만듭니다.
5. 공통 개발 명령과 CI 기본 구조를 만듭니다.
6. 다음 계약을 코드보다 먼저 정의합니다.
   - Asset Manifest
   - Agent Manifest
   - Knowledge Manifest
   - Prompt Manifest
   - MCP Tool Manifest
   - AI Service Definition
   - Indexing Profile
   - Retrieval Profile
   - Office Profile
   - Portal OpenAPI 초안
   - Local Runtime API/Event 초안
   - Knowledge Search Request/Response
   - MCP Audit/Auth Context
   - Hosted Chat Deployment/Revision/Session/Event
7. 정상·오류 Sample Fixture를 만듭니다.
8. Schema/Contract Test가 CI에서 실행되게 만듭니다.

시작 전에 아래 내용을 보고하세요.

- 이해한 제품 구조
- 생성할 Monorepo 구조
- Phase 0 작업 목록
- 변경할 파일 목록
- 아직 결정되지 않은 항목과 적용할 PoC 가정
- 위험 요소와 검증 방법

명세에서 결정되지 않은 내용을 임의로 운영 확정하지 마세요. 필요한 항목은 `docs/implementation-spec/open-decisions.md`에 추가하고, Mock 또는 Adapter 경계까지만 구현하세요.

각 작업이 끝나면 다음을 함께 제공하세요.

- 변경 파일 요약
- 실행 방법
- 실행한 테스트와 결과
- 남은 Blocker
- 다음 Phase 진입 조건

---
