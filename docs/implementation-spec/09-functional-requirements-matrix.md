# 전체 기능 요구사항 추적표

이 표는 12개 모듈의 전체 기능을 상세 명세 Section과 연결하기 위한 기준 목록이다. 사용자 화면과 신규 구현에서는 Knowledge 명칭을 사용한다.

기본 모듈 기능 수: 144  
발표 MVP 추가 기능: `HOST-001`~`HOST-030`

| 기능 ID | Depth 1 | Depth 2 | Depth 3 | 사용 방식 | 사용 예시 | 우선순위 | 난이도 | 모듈 ID | 산출물 | 선행조건 | 개발 단계 | 완료 기준 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01-F01 | 포털 | 공통 UI | 앱 셸·내비게이션 | 포털의 공통 화면 구조 제공 | 자산·승인·다운로드 메뉴 이동 | MVP | 중급 | M01 | 포털 UI | M02 | P1 설계 | 앱 셸·내비게이션 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F02 | 포털 | 자산 탐색 | 통합 카탈로그 | Agent·Knowledge·MCP·Prompt 목록 표시 | Nexacro 관련 자산을 한 화면에서 확인 | MVP | 중급 | M01 | 카탈로그 화면 | M02 | P2 개발 | 통합 카탈로그 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F03 | 포털 | 자산 탐색 | 키워드 검색 | 이름·설명·태그 검색 | 'Nexacro'로 관련 Agent와 Knowledge 검색 | MVP | 중급 | M01 | 검색 UI | M02 | P2 개발 | 키워드 검색 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F04 | 포털 | 자산 탐색 | 복합 필터 | 유형·환경·사업장·상태 필터 | 폐쇄망 지원·승인됨 Agent만 표시 | MVP | 중급 | M01 | 필터 UI | M02 | P2 개발 | 복합 필터 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F05 | 포털 | 자산 상세 | 상세·호환성 | 버전·환경·담당자·보안등급 표시 | Ollama 지원 여부와 최소 Runtime 확인 | MVP | 중급 | M01 | 상세 화면 | M02 | P2 개발 | 상세·호환성 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F06 | 포털 | 자산 상세 | 의존성 표시 | 필수 Knowledge·MCP·Prompt 관계 표시 | Agent 설치 전 필요한 3개 자산 확인 | MVP | 중급 | M01 | 의존성 컴포넌트 | M02 | P2 개발 | 의존성 표시 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F07 | 포털 | 등록 | 자산 등록 폼 | 메타데이터와 패키지 업로드 | 신규 Knowledge ZIP과 평가 결과 등록 | MVP | 중급 | M01 | 등록 화면 | M02 | P2 개발 | 자산 등록 폼 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F08 | 포털 | 승인 | 검토·승인 화면 | 검토 의견·승인·반려 처리 | 보안 검토자가 반려 사유 기록 | MVP | 중급 | M01 | 승인 화면 | M02,M11 | P3 통합 | 검토·승인 화면 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F09 | 포털 | 배포 | 다운로드·번들 요청 | 온라인 다운로드와 오프라인 Bundle 요청 | 폐쇄망 사업장용 번들 생성 요청 | MVP | 중급 | M01 | 배포 UI | M03 | P3 통합 | 다운로드·번들 요청 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F10 | 포털 | 품질 | 평가 결과 표시 | Knowledge Recall·응답시간·Agent 성공률 표시 | Knowledge 1.1이 1.0보다 개선됐는지 확인 | 확장 | 중급 | M01 | 품질 화면 | M09 | P3 통합 | 평가 결과 표시 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F11 | 포털 | UX | 상태·오류·빈 화면 | 로딩·권한부족·검색결과 없음 처리 | MCP 자산이 없을 때 등록 방법 안내 | MVP | 초중급 | M01 | 공통 상태 UI | M02 | P4 검증 | 상태·오류·빈 화면 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M01-F12 | 포털 | 접근성 | 키보드·대비 | 키보드 탐색과 명확한 라벨 제공 | 마우스 없이 자산 검색·다운로드 | 확장 | 중급 | M01 | 접근성 체크 | M12 | P4 검증 | 키보드·대비 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F01 | 포털 API | 자산 | 메타데이터 Schema | 자산 공통 필드 정의 | ID·유형·버전·담당자 저장 | MVP | 고급 | M02 | DB Schema | M06 | P1 설계 | 메타데이터 Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F02 | 포털 API | 자산 | CRUD API | 자산 등록·조회·수정·폐기 | Agent 초안을 등록 후 검토 요청 | MVP | 고급 | M02 | REST API | M06 | P2 개발 | CRUD API 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F03 | 포털 API | 검색 | 검색·필터 API | 키워드와 복합 조건 검색 | 유형=Knowledge, 상태=승인됨 조회 | MVP | 고급 | M02 | Search API | M01 | P2 개발 | 검색·필터 API 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F04 | 포털 API | 버전 | 버전 관리 | SemVer와 변경이력 저장 | Agent 1.1.0과 1.2.0 공존 | MVP | 고급 | M02 | Version API | M06 | P2 개발 | 버전 관리 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F05 | 포털 API | 수명주기 | 상태 머신 | 초안·검토·승인·중단·폐기 전환 | 승인 전 다운로드 불가 | MVP | 고급 | M02 | Lifecycle Service | M11 | P2 개발 | 상태 머신 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F06 | 포털 API | 의존성 | Dependency Graph | 필수 자산과 최소 버전 저장 | Agent→Knowledge→Embedding 모델 관계 | MVP | 고급 | M02 | Dependency API | M06 | P2 개발 | Dependency Graph 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F07 | 포털 API | 의존성 | 호환성 검증 | 누락·순환·버전충돌 확인 | 요구 Knowledge 버전이 없으면 등록 차단 | MVP | 고급 | M02 | Validation Service | M06 | P3 통합 | 호환성 검증 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F08 | 포털 API | 파일 | 파일 메타데이터 연결 | Repository 파일과 자산 버전 연결 | ZIP 해시와 저장 경로 기록 | MVP | 중급 | M02 | File Metadata API | M03 | P3 통합 | 파일 메타데이터 연결 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F09 | 포털 API | 배포 | 다운로드 이력 | 사용자·버전·시간 기록 | 누가 MCP 1.0을 받았는지 조회 | MVP | 중급 | M02 | Download Log API | M03,M11 | P3 통합 | 다운로드 이력 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F10 | 포털 API | 권한 | 소유자·조직 | 작성자·검토자·사용범위 관리 | HR 조직에만 HR Knowledge 노출 | 확장 | 고급 | M02 | Access Metadata | M11 | P3 통합 | 소유자·조직 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F11 | 포털 API | 문서 | OpenAPI 계약 | 모든 API 요청·응답 문서화 | M01과 M03가 Mock API로 선행 개발 | MVP | 중급 | M02 | OpenAPI Spec | M06 | P1 설계 | OpenAPI 계약 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M02-F12 | 포털 API | 초기화 | Migration·Seed | 개발 DB와 샘플 자산 생성 | 샘플 Agent 2개 자동 등록 | MVP | 중급 | M02 | Migration Script | M12 | P4 검증 | Migration·Seed 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F01 | 배포 | 저장소 | Storage Adapter | 파일 시스템·Object Storage 추상화 | PoC는 로컬 파일, 운영은 사내 저장소 | MVP | 중급 | M03 | Repository Adapter | M02 | P1 설계 | Storage Adapter 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F02 | 배포 | 다운로드 | 승인 버전 다운로드 | 승인된 파일만 제공 | 폐기된 MCP 1.0 다운로드 차단 | MVP | 중급 | M03 | Download Service | M02,M11 | P2 개발 | 승인 버전 다운로드 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F03 | 배포 | 번들 | 의존성 해석 | Agent 의존 자산 자동 수집 | Agent와 Knowledge·Prompt·Office Profile 포함 | MVP | 고급 | M03 | Dependency Resolver | M02,M06 | P2 개발 | 의존성 해석 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F04 | 배포 | 번들 | Offline Bundle 생성 | 폐쇄망 반입용 ZIP 생성 | 사업장 A용 실행 패키지 생성 | MVP | 중급 | M03 | Bundle Builder | M06 | P2 개발 | Offline Bundle 생성 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F05 | 배포 | 번들 | Bundle Manifest | 포함 자산·버전·크기 목록 | 설치 전 전체 구성 확인 | MVP | 중급 | M03 | bundle-manifest.yaml | M06 | P2 개발 | Bundle Manifest 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F06 | 배포 | 무결성 | Checksum 생성 | 모든 파일 SHA-256 기록 | 반입 후 변조 여부 확인 | MVP | 중급 | M03 | checksums.sha256 | M11 | P2 개발 | Checksum 생성 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F07 | 배포 | 환경 | Office Profile 포함 | 사업장별 모델·MCP 설정 주입 | A사업장 Ollama와 MCP 주소 포함 | MVP | 중급 | M03 | Office Bundle | M06 | P3 통합 | Office Profile 포함 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F08 | 배포 | 가져오기 | Import 검증 | 구조·버전·해시·서명 검사 | 손상된 ZIP 설치 차단 | MVP | 고급 | M03 | Import Validator | M11 | P3 통합 | Import 검증 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F09 | 배포 | 설치 | 일괄 설치 순서 | Runtime→Knowledge→Agent 순 설치 | 의존성 순서대로 안전하게 설치 | MVP | 중급 | M03 | Install Plan | M04 | P3 통합 | 일괄 설치 순서 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F10 | 배포 | 복구 | 설치 Rollback | 부분 실패 시 이전 상태 복원 | Knowledge 설치 실패 후 Agent 미설치 | 확장 | 고급 | M03 | Rollback Handler | M04 | P4 검증 | 설치 Rollback 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F11 | 배포 | 채널 | 개발·테스트·운영 | 배포 채널별 버전 분리 | 테스트 채널에서 먼저 배포 | 확장 | 중급 | M03 | Channel Policy | M02 | P4 검증 | 개발·테스트·운영 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M03-F12 | 배포 | 회수 | Revocation 조회 | 차단된 버전 설치 방지 | 보안 사고 Agent 실행 차단 | 확장 | 고급 | M03 | Revocation Check | M11 | P4 검증 | Revocation 조회 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F01 | 클라이언트 | 공통 UI | Desktop Shell | Windows 앱 내비게이션과 화면 틀 | Agent·자산·설정·로그 화면 이동 | MVP | 중급 | M04 | PySide6 Shell | M06 | P1 설계 | Desktop Shell 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F02 | 클라이언트 | Agent | 설치 목록 | 설치된 Agent와 버전 표시 | SQL 분석 Agent 1.2 설치 확인 | MVP | 중급 | M04 | Agent Manager | M05 | P2 개발 | 설치 목록 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F03 | 클라이언트 | 대화 | 채팅·스트리밍 | 질문과 단계별 응답 표시 | 검색 중·Tool 실행 중 상태 표시 | MVP | 중급 | M04 | Chat UI | M05 | P2 개발 | 채팅·스트리밍 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F04 | 클라이언트 | 패키지 | ZIP 가져오기 | 오프라인 Bundle 선택·설치 | 승인된 USB 반입 ZIP 설치 | MVP | 중급 | M04 | Import UI | M03 | P2 개발 | ZIP 가져오기 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F05 | 클라이언트 | 패키지 | 무결성 확인 | Manifest·Checksum·서명 검사 결과 표시 | 변조 파일 설치 거부 | MVP | 중급 | M04 | Verification UI | M03,M11 | P3 통합 | 무결성 확인 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F06 | 클라이언트 | 진단 | 의존성 사전점검 | 모델·Knowledge·MCP·Runtime 확인 | 필수 Ollama 모델 미설치 안내 | MVP | 중급 | M04 | Preflight Check | M05,M06 | P3 통합 | 의존성 사전점검 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F07 | 클라이언트 | 상태 | 연결 상태 | Ollama·Knowledge·MCP 상태 표시 | MCP 연결 실패와 조치 방법 표시 | MVP | 초중급 | M04 | Status Panel | M05,M10 | P3 통합 | 연결 상태 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F08 | 클라이언트 | 설정 | Office Profile | 사업장 설정 선택·적용 | A사업장 Profile로 MCP 주소 변경 | MVP | 중급 | M04 | Settings UI | M06 | P2 개발 | Office Profile 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F09 | 클라이언트 | 실행 | 취소·재시도 | 긴 실행 중단과 안전한 재시도 | LLM 응답 지연 시 취소 | MVP | 중급 | M04 | Run Control | M05 | P3 통합 | 취소·재시도 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F10 | 클라이언트 | 로그 | 실행 기록 | 질문·상태·오류 기록 조회 | 실패 실행의 Trace ID 확인 | MVP | 중급 | M04 | Log Viewer | M05,M11 | P3 통합 | 실행 기록 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F11 | 클라이언트 | 결과 | 출처·내보내기 | 근거 문서와 답변 저장 | 답변을 Markdown 보고서로 저장 | 확장 | 초중급 | M04 | Result Export | M05,M08 | P4 검증 | 출처·내보내기 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M04-F12 | 클라이언트 | 배포 | 설치 패키징 | Python 런타임 포함 Windows 배포 | 폐쇄망 PC에서 설치 파일 실행 | MVP | 고급 | M04 | Windows Installer | M12 | P4 검증 | 설치 패키징 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F01 | Agent Runtime | 패키지 | Manifest Loader | Agent Package 규격 검증·로딩 | entrypoint와 의존성 읽기 | MVP | 고급 | M05 | Package Loader | M06 | P1 설계 | Manifest Loader 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F02 | Agent Runtime | Workflow | 실행 엔진 | 노드·분기·상태 기반 실행 | 분석→검색→Tool→답변 순 실행 | MVP | 고급 | M05 | Workflow Engine | M06 | P2 개발 | 실행 엔진 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F03 | Agent Runtime | 상태 | Context 관리 | 노드 간 질문·검색·Tool 결과 전달 | Knowledge 출처를 답변 단계에 전달 | MVP | 고급 | M05 | Agent Context | M06 | P2 개발 | Context 관리 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F04 | Agent Runtime | LLM | Ollama Adapter | Chat·Embedding 로컬 모델 호출 | EXAONE으로 답변 생성 | MVP | 고급 | M05 | Ollama Adapter | M06 | P2 개발 | Ollama Adapter 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F05 | Agent Runtime | LLM | Frontier Adapter | 승인 외부 모델 공통 인터페이스 | 일반망에서는 회사 승인 모델 사용 | 확장 | 고급 | M05 | Frontier Adapter | M11 | P4 검증 | Frontier Adapter 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F06 | Agent Runtime | Knowledge | Search Client | Retrieval Profile 기반 검색 호출 | Hybrid 검색 결과와 Citation 수신 | MVP | 고급 | M05 | Knowledge Client | M08 | P3 통합 | Search Client 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F07 | Agent Runtime | MCP | MCP Client | Tool 발견·Schema 확인·호출 | db_metadata.get_columns 실행 | MVP | 고급 | M05 | MCP Client | M10 | P3 통합 | MCP Client 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F08 | Agent Runtime | Prompt | Template Renderer | Prompt Package와 입력 변수 결합 | 질문·검색 문맥을 답변 Prompt에 삽입 | MVP | 중급 | M05 | Prompt Renderer | M06 | P2 개발 | Template Renderer 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F09 | Agent Runtime | 출력 | Response Schema | 답변·출처·Tool 이력 표준화 | Desktop에 answer/citations/status 반환 | MVP | 고급 | M05 | Response Model | M06,M08 | P3 통합 | Response Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F10 | Agent Runtime | 제어 | Timeout·Cancel·Retry | 무한 실행과 일시 장애 제어 | MCP Timeout 후 1회 재시도 | MVP | 고급 | M05 | Execution Control | M04,M10 | P3 통합 | Timeout·Cancel·Retry 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F11 | Agent Runtime | 정책 | 허용 자산 검사 | 선언된 모델·Knowledge·MCP만 사용 | Agent가 임의 MCP 주소 연결하지 못함 | MVP | 고급 | M05 | Runtime Policy | M11 | P3 통합 | 허용 자산 검사 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M05-F12 | Agent Runtime | 관측 | 구조화 로그 | Trace ID와 단계별 시간 기록 | 검색 0.4초, MCP 0.2초 기록 | MVP | 중급 | M05 | Runtime Logging | M11,M12 | P4 검증 | 구조화 로그 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F01 | 표준 | 공통 | Asset Manifest | 모든 자산의 공통 필드 정의 | id·version·owner·status 공통 사용 | MVP | 중급 | M06 | asset.schema.json | 없음 | P1 설계 | Asset Manifest 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F02 | 표준 | Agent | Agent Schema | Workflow·Prompt·의존성 규격 | Agent가 Knowledge와 MCP 최소 버전 선언 | MVP | 중급 | M06 | agent.schema.json | 없음 | P1 설계 | Agent Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F03 | 표준 | Knowledge | Knowledge Index Schema | 청크·인덱스·평가 파일 규격 | chunks.jsonl과 Chroma 경로 선언 | MVP | 중급 | M06 | knowledge.schema.json | M07,M09 | P1 설계 | Knowledge Index Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F04 | 표준 | MCP | MCP Tool Schema | 입력·출력·권한·위험도 규격 | table_count가 read-only임을 선언 | MVP | 중급 | M06 | mcp.schema.json | M10 | P1 설계 | MCP Tool Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F05 | 표준 | Prompt | Prompt Schema | 변수·지원 모델·출력 형식 규격 | query와 context 변수를 선언 | MVP | 초중급 | M06 | prompt.schema.json | M05 | P1 설계 | Prompt Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F06 | 표준 | Knowledge | Indexing Profile | 파서·청킹·임베딩·DB 설정 | Parent 1200, Child 350 설정 | MVP | 중급 | M06 | indexing-profile.schema | M07 | P1 설계 | Indexing Profile 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F07 | 표준 | Knowledge | Retrieval Profile | Vector·BM25·RRF·Top-K 설정 | Vector 0.7, BM25 0.3 결합 | MVP | 중급 | M06 | retrieval-profile.schema | M08 | P1 설계 | Retrieval Profile 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F08 | 표준 | 환경 | Office Profile | 사업장 모델·MCP·경로·정책 | A사업장 Ollama URL과 MCP 주소 | MVP | 중급 | M06 | office-profile.schema | M03,M04 | P1 설계 | Office Profile 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F09 | 표준 | 버전 | 호환성 규칙 | SemVer·최소 Runtime·마이그레이션 | Agent 2.x는 Runtime 2.x 요구 | MVP | 중급 | M06 | Compatibility Guide | M02 | P1 설계 | 호환성 규칙 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F10 | 표준 | 검증 | Schema Validator | CLI로 YAML·JSON 규격 검사 | 등록 전 누락 필드 확인 | MVP | 중급 | M06 | Validator CLI | M02,M03 | P2 개발 | Schema Validator 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F11 | 표준 | 템플릿 | 샘플 패키지 | 각 자산의 최소 실행 예제 | hello-agent와 hr-policy-knowledge 제공 | MVP | 초중급 | M06 | Sample Assets | M05,M07 | P2 개발 | 샘플 패키지 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M06-F12 | 표준 | 문서 | 변경·마이그레이션 | Schema 변경 절차와 호환 정책 | v1→v2 필드 변환 가이드 | 확장 | 초중급 | M06 | Migration Guide | M12 | P4 검증 | 변경·마이그레이션 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F01 | Knowledge 구축 | 입력 | Markdown·Text Loader | 기본 문서 파일을 Document로 로드 | hr_policy.md를 원본 메타데이터와 로드 | MVP | 중급 | M07 | Document Loader | M06 | P2 개발 | Markdown·Text Loader 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F02 | Knowledge 구축 | 파싱 | 정제·구조 보존 | 공백 정리와 제목·페이지 보존 | Markdown 제목을 section으로 저장 | MVP | 중급 | M07 | Parser Pipeline | M06 | P2 개발 | 정제·구조 보존 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F03 | Knowledge 구축 | 청킹 | Recursive 전략 | 문단·줄·공백 순 재귀 분할 | 일반 텍스트를 350자 단위 분할 | MVP | 중급 | M07 | Recursive Chunker | M06 | P2 개발 | Recursive 전략 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F04 | Knowledge 구축 | 청킹 | Markdown 전략 | 제목 구조 우선 분리 후 재귀 분할 | 규정의 장·절 구조 유지 | MVP | 고급 | M07 | Markdown Chunker | M06 | P2 개발 | Markdown 전략 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F05 | Knowledge 구축 | 청킹 | Parent-Child 전략 | 작은 검색 청크와 큰 문맥 연결 | Child 검색 후 Parent 규정 반환 | MVP | 고급 | M07 | ParentChild Chunker | M06 | P2 개발 | Parent-Child 전략 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F06 | Knowledge 구축 | 식별 | 문서·Parent·Chunk ID | 안정적 Hash 기반 ID 생성 | 동일 문서는 재색인해도 ID 유지 | MVP | 고급 | M07 | ID Service | M06 | P2 개발 | 문서·Parent·Chunk ID 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F07 | Knowledge 구축 | 메타데이터 | Schema·업무 정보 | 부서·상태·언어·섹션 기록 | department=HR, status=active 저장 | MVP | 중급 | M07 | Metadata Enricher | M06 | P2 개발 | Schema·업무 정보 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F08 | Knowledge 구축 | 임베딩 | Ollama Batch | 로컬 Embedding 모델 일괄 호출 | qwen3-embedding으로 32개씩 처리 | MVP | 고급 | M07 | Embedding Service | M06 | P2 개발 | Ollama Batch 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F09 | Knowledge 구축 | Vector | Chroma Upsert | Collection 생성·추가·갱신 | chunk_id를 Chroma ID로 저장 | MVP | 고급 | M07 | Vector Indexer | M06 | P2 개발 | Chroma Upsert 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F10 | Knowledge 구축 | Keyword | BM25 Index | 검색용 키워드 인덱스 생성·저장 | 육아휴직·제15조 정확 검색 | MVP | 고급 | M07 | BM25 Builder | M08 | P3 통합 | BM25 Index 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F11 | Knowledge 구축 | 갱신 | 증분·삭제 동기화 | Hash 비교로 변경분만 처리 | 수정된 규정 문서만 재임베딩 | 확장 | 고급 | M07 | Incremental Indexer | M09 | P4 검증 | 증분·삭제 동기화 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M07-F12 | Knowledge 구축 | 운영 | 진행률·재시도·통계 | 처리 현황·오류·시간·재개 지원 | 5000/18000 청크 진행률 표시 | MVP | 중급 | M07 | Indexing Report | M09,M12 | P4 검증 | 진행률·재시도·통계 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F01 | Knowledge 검색 | 초기화 | 인덱스·호환성 로딩 | Chroma·BM25와 Embedding 모델 검사 | 문서·질의 임베딩 모델 불일치 차단 | MVP | 고급 | M08 | Index Loader | M06,M07 | P2 개발 | 인덱스·호환성 로딩 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F02 | Knowledge 검색 | 질의 | 정규화·Rewrite | 검색용 질의로 변환하고 실패 시 원문 사용 | '아파서 쉬기'를 '병가 신청 증빙'으로 변환 | MVP | 고급 | M08 | Query Transformer | M05 | P2 개발 | 정규화·Rewrite 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F03 | Knowledge 검색 | 검색 | Vector Search | Chroma 의미 유사도 검색 | 다른 표현의 동일 의미 문서 검색 | MVP | 고급 | M08 | Vector Retriever | M07 | P2 개발 | Vector Search 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F04 | Knowledge 검색 | 검색 | BM25 Search | 정확한 키워드·코드 검색 | HR-2026-001 정확 검색 | MVP | 고급 | M08 | BM25 Retriever | M07 | P2 개발 | BM25 Search 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F05 | Knowledge 검색 | 검색 | 한국어 Tokenizer | 형태소·업무 사전 기반 토큰화 | 육아휴직을 하나의 검색어로 유지 | 확장 | 고급 | M08 | Korean Tokenizer | M07 | P4 검증 | 한국어 Tokenizer 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F06 | Knowledge 검색 | 결합 | Hybrid 병렬 검색 | Vector·BM25 동시 실행 | 두 검색 결과를 후보군으로 수집 | MVP | 고급 | M08 | Hybrid Retriever | M07 | P2 개발 | Hybrid 병렬 검색 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F07 | Knowledge 검색 | 결합 | RRF Fusion | 순위와 가중치로 결과 결합 | Vector 0.7·BM25 0.3으로 통합 | MVP | 고급 | M08 | RRF Fusion | M06 | P2 개발 | RRF Fusion 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F08 | Knowledge 검색 | 필터 | Metadata Filter | 부서·상태·버전 조건 적용 | HR이면서 active인 규정만 검색 | MVP | 중급 | M08 | Filter Engine | M06 | P2 개발 | Metadata Filter 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F09 | Knowledge 검색 | 보안 | ACL Filter Hook | 사용자 권한 조건을 검색에 강제 | 다른 부서의 기밀 청크 제외 | 확장 | 고급 | M08 | ACL Hook | M11 | P3 통합 | ACL Filter Hook 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F10 | Knowledge 검색 | 문맥 | Parent 확장·중복제거 | Child 결과를 Parent로 교체하고 중복 제거 | 동일 Parent의 Child 3개를 하나로 반환 | MVP | 고급 | M08 | Context Expander | M07 | P2 개발 | Parent 확장·중복제거 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F11 | Knowledge 검색 | 문맥 | 토큰 예산·Citation | 최종 문맥 크기와 출처 표준화 | 파일·섹션·페이지를 답변에 전달 | MVP | 고급 | M08 | Context Builder | M05 | P3 통합 | 토큰 예산·Citation 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M08-F12 | Knowledge 검색 | 관측 | Trace·Latency·Rerank Hook | 검색 단계·점수·시간 기록과 확장점 | Vector 0.2초·BM25 0.05초 기록 | MVP | 중급 | M08 | Search Trace | M09,M12 | P4 검증 | Trace·Latency·Rerank Hook 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F01 | Knowledge 자산 | 패키징 | Package Assembler | Knowledge 결과를 표준 ZIP으로 조립 | chunks·parents·Chroma·Profile 포함 | MVP | 중급 | M09 | Knowledge Packager | M06,M07 | P2 개발 | Package Assembler 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F02 | Knowledge 자산 | 데이터 | Chunks·Parents JSONL | DB 독립적인 핵심 검색 데이터 저장 | 다른 Vector DB로 재색인 가능 | MVP | 중급 | M09 | JSONL Dataset | M07 | P2 개발 | Chunks·Parents JSONL 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F03 | Knowledge 자산 | 추적 | Source Manifest | 원본 문서·Hash·버전·권한 기록 | Nexacro 문서 17.1 출처 저장 | MVP | 중급 | M09 | source-manifest.json | M07 | P2 개발 | Source Manifest 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F04 | Knowledge 자산 | 설정 | Profile 포함 | Indexing·Retrieval Profile 보관 | 색인 재현과 기본 검색 설정 제공 | MVP | 초중급 | M09 | profiles/ | M06 | P2 개발 | Profile 포함 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F05 | Knowledge 평가 | 데이터 | 평가 질문 세트 | 질문·기대 문서·기대 청크 정의 | 병가 질문의 기대 청크 지정 | MVP | 중급 | M09 | questions.jsonl | 업무 전문가 | P2 개발 | 평가 질문 세트 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F06 | Knowledge 평가 | 검색 | Recall@K·MRR | 정답 문서 검색 순위 측정 | 기대 청크가 Top-5에 포함 | MVP | 중급 | M09 | Retrieval Evaluator | M08 | P3 통합 | Recall@K·MRR 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F07 | Knowledge 평가 | 성능 | Latency·용량 | 검색시간·메모리·패키지 크기 측정 | 폐쇄망 PC에서 검색 1초 이내 | MVP | 중급 | M09 | Performance Report | M08 | P3 통합 | Latency·용량 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F08 | Knowledge 평가 | 답변 | 근거성·Citation | 답변이 검색 문서에 근거하는지 평가 | 없는 내용 추측 시 실패 처리 | 확장 | 고급 | M09 | Grounding Evaluator | M05,M08 | P4 검증 | 근거성·Citation 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F09 | Knowledge 평가 | 비교 | 버전 비교 | Knowledge 버전별 지표 비교 | 1.0 대비 1.1 Recall +8% 확인 | MVP | 중급 | M09 | Comparison Report | M07,M08 | P3 통합 | 버전 비교 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F10 | Knowledge 평가 | 회귀 | Regression Gate | 기준 미달 시 승인 차단 | Recall@5 80% 미만 배포 불가 | 확장 | 고급 | M09 | Quality Gate | M11,M12 | P4 검증 | Regression Gate 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F11 | Knowledge 자산 | 문서 | Data Card | 출처·전략·제한·평가 결과 설명 | 지원 문서와 알려진 검색 한계 기록 | MVP | 초중급 | M09 | README/Data Card | M12 | P4 검증 | Data Card 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M09-F12 | Knowledge 자산 | 검증 | Smoke Test | 설치 직후 대표 검색 수행 | 육아휴직 질문으로 정상 검색 확인 | MVP | 중급 | M09 | Smoke Test | M08,M12 | P4 검증 | Smoke Test 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F01 | MCP | 서버 | Server Bootstrap | 사업장 공용 MCP 서버 기본 구성 | Office MCP 서버 시작과 종료 | MVP | 고급 | M10 | MCP Server | M06 | P1 설계 | Server Bootstrap 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F02 | MCP | Tool | Tool Registry | Tool 등록·조회·버전 관리 | db_metadata 1.0 등록 | MVP | 고급 | M10 | Tool Registry | M06 | P2 개발 | Tool Registry 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F03 | MCP | Schema | 입력·출력 검증 | JSON Schema 기반 요청·응답 검사 | 허용되지 않은 테이블명 거부 | MVP | 고급 | M10 | Schema Validator | M06 | P2 개발 | 입력·출력 검증 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F04 | MCP | 인증 | 사용자 Context | 사용자·조직·Agent 정보를 요청에 전달 | 요청자의 부서와 Agent ID 확인 | 확장 | 고급 | M10 | Auth Context | M11 | P3 통합 | 사용자 Context 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F05 | MCP | 권한 | RBAC·Allowlist | Tool과 데이터 범위 접근 제어 | 읽기 허용 테이블만 조회 | MVP | 고급 | M10 | Authorization | M11 | P3 통합 | RBAC·Allowlist 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F06 | MCP | Connector | Oracle Read-only | Connection Pool과 읽기 전용 실행 | 업무 DB Metadata 조회 | MVP | 고급 | M10 | Oracle Connector | M11 | P2 개발 | Oracle Read-only 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F07 | MCP | Tool | DB Metadata | 테이블·컬럼·프로시저 정보 조회 | Nexacro 화면 관련 컬럼 조회 | MVP | 중급 | M10 | db_metadata Tool | Oracle Connector | P2 개발 | DB Metadata 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F08 | MCP | Tool | Table Count | 허용 테이블 건수 조회 | 인터페이스 처리 건수 확인 | MVP | 중급 | M10 | table_count Tool | Oracle Connector | P2 개발 | Table Count 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F09 | MCP | 실행 | Timeout·Rate·Size | 수행시간·호출량·결과 크기 제한 | 10초 초과 조회 중단 | MVP | 고급 | M10 | Execution Guard | M11 | P3 통합 | Timeout·Rate·Size 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F10 | MCP | 출력 | Masking | 민감 컬럼과 오류정보 제거 | 주민번호 일부 마스킹 | 확장 | 고급 | M10 | Output Filter | M11 | P3 통합 | Masking 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F11 | MCP | 감사 | Correlation Log | 사용자·Agent·Tool·결과 상태 기록 | Agent Trace와 Tool 호출 연결 | MVP | 중급 | M10 | Audit Logger | M11 | P3 통합 | Correlation Log 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M10-F12 | MCP | 운영 | Health·Version·Kill Switch | 상태·버전·긴급 중단 제공 | 위험 Tool 즉시 비활성화 | MVP | 고급 | M10 | Operations API | M11,M12 | P4 검증 | Health·Version·Kill Switch 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F01 | 보안 | 접근 | Portal RBAC | 사용자·개발자·검토자·관리자 역할 | 일반 사용자는 승인 기능 접근 불가 | MVP | 고급 | M11 | RBAC Policy | M02 | P1 설계 | Portal RBAC 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F02 | 보안 | 거버넌스 | 승인 Workflow | 기술·보안·운영 검토 단계 | MCP Tool은 보안 검토 후 배포 | MVP | 고급 | M11 | Approval Policy | M02 | P1 설계 | 승인 Workflow 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F03 | 보안 | 데이터 | 등급·ACL | 자산 보안등급과 조직 범위 | HR Knowledge를 HR 조직에만 노출 | 확장 | 고급 | M11 | Asset ACL | M02,M08 | P2 개발 | 등급·ACL 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F04 | 보안 | 무결성 | Checksum Policy | 생성·검증·실패 처리 규칙 | SHA-256 불일치 시 설치 차단 | MVP | 중급 | M11 | Checksum Policy | M03,M04 | P1 설계 | Checksum Policy 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F05 | 보안 | 신뢰 | Signature·Trust Store | 서명 발급·검증·신뢰키 관리 | 승인 포털이 서명한 패키지만 실행 | 확장 | 고급 | M11 | Signing Policy | M03,M04 | P3 통합 | Signature·Trust Store 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F06 | 보안 | 공급망 | 의존성 검사 Hook | 취약 라이브러리와 라이선스 검사 | 고위험 Python 패키지 등록 차단 | 확장 | 고급 | M11 | Scan Hook | M02 | P4 검증 | 의존성 검사 Hook 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F07 | 보안 | 실행 | Secret Policy | 계정정보를 패키지 밖에서 주입 | DB 비밀번호를 Office Profile에 저장 금지 | MVP | 고급 | M11 | Secret Guide | M05,M10 | P2 개발 | Secret Policy 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F08 | 보안 | Agent | Prompt·Tool 정책 | Prompt Injection과 임의 Tool 호출 제한 | 문서 속 명령이 MCP 실행을 유도해도 차단 | MVP | 고급 | M11 | Agent Security Policy | M05,M10 | P3 통합 | Prompt·Tool 정책 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F09 | 보안 | 감사 | Audit Schema | Portal·Runtime·MCP 공통 로그 필드 | user/asset/tool/trace/time/status 기록 | MVP | 중급 | M11 | Audit Schema | M02,M05,M10 | P1 설계 | Audit Schema 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F10 | 보안 | 개인정보 | Masking·Retention | 로그 민감정보 제거와 보관기간 | 질문 속 계정번호 마스킹 | 확장 | 고급 | M11 | Data Handling Policy | M10 | P4 검증 | Masking·Retention 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F11 | 보안 | 사고대응 | Revocation·Kill Switch | 문제 자산의 배포·실행 중지 | 취약 MCP 1.0 즉시 차단 | 확장 | 고급 | M11 | Revocation Policy | M02,M03,M10 | P4 검증 | Revocation·Kill Switch 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M11-F12 | 보안 | 검증 | 위협 시나리오 테스트 | 변조·권한상승·Injection 테스트 | 승인되지 않은 ZIP 설치 시도 | MVP | 고급 | M11 | Security Test Cases | M12 | P4 검증 | 위협 시나리오 테스트 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F01 | 통합 | 계획 | Test Strategy | 단위·계약·통합·인수 테스트 기준 | 모듈별 Done 정의 통일 | MVP | 중급 | M12 | Test Plan | 전 모듈 | P1 설계 | Test Strategy 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F02 | 통합 | 계약 | Contract Test | API·Manifest·Schema 호환 자동 검사 | Portal API와 Desktop 모델 일치 확인 | MVP | 중급 | M12 | Contract Tests | M02,M06 | P2 개발 | Contract Test 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F03 | 통합 | E2E | 대표 시나리오 | 등록→번들→설치→검색→Tool→답변 | Nexacro Agent 전체 흐름 자동 검증 | MVP | 고급 | M12 | E2E Suite | 전 모듈 | P3 통합 | 대표 시나리오 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F04 | 통합 | 데이터 | 테스트 자산 | 샘플 Agent·Knowledge·MCP·문서 관리 | HR 규정 Knowledge와 Mock DB 제공 | MVP | 초중급 | M12 | Test Fixtures | M06,M09 | P2 개발 | 테스트 자산 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F05 | 통합 | 자동화 | CI Pipeline | Lint·Test·Package·검증 자동화 | PR마다 Schema와 단위 테스트 실행 | MVP | 중급 | M12 | CI Workflow | 전 모듈 | P2 개발 | CI Pipeline 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F06 | 통합 | 환경 | 개발환경 Bootstrap | 공통 실행·Mock·설정 스크립트 | 신규 회원이 30분 내 샘플 실행 | MVP | 중급 | M12 | Dev Setup | M06 | P1 설계 | 개발환경 Bootstrap 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F07 | 통합 | 품질 | 릴리스 체크리스트 | 버전·테스트·문서·보안 확인 | 운영 후보 배포 전 15개 항목 점검 | MVP | 초중급 | M12 | Release Checklist | M11 | P4 검증 | 릴리스 체크리스트 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F08 | 통합 | 문서 | 설치·사용 가이드 | 비개발자와 개발자 문서 분리 | Desktop Client 패키지 가져오기 안내 | MVP | 초중급 | M12 | User/Dev Guide | 전 모듈 | P4 검증 | 설치·사용 가이드 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F09 | 통합 | 협업 | Issue·PR Template | AI 생성 코드의 검증 항목 표준화 | 테스트 증거 없는 PR 병합 금지 | MVP | 초중급 | M12 | Repo Templates | 전 모듈 | P1 설계 | Issue·PR Template 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F10 | 통합 | 관측 | 통합 상태표 | 모듈별 계약·테스트·Blocker 추적 | M08 지연이 M05 통합에 미치는 영향 표시 | MVP | 중급 | M12 | Integration Board | 전 모듈 | P3 통합 | 통합 상태표 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F11 | 통합 | 데모 | Demo Runbook | 환경 준비·질문·기대 결과 정의 | 폐쇄망 Nexacro 분석 10분 데모 | MVP | 초중급 | M12 | Demo Script | 전 모듈 | P4 검증 | Demo Runbook 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |
| M12-F12 | 통합 | 인수 | Acceptance Report | 기능·성능·보안·UX 결과 정리 | Go/Conditional Go 판단 자료 | MVP | 중급 | M12 | Final Report | 전 모듈 | P4 검증 | Acceptance Report 기능이 예시 시나리오에서 동작하고 테스트 증거가 저장됨 |

## 추적 규칙

- 기능 ID는 Issue, PR, Test 이름에 포함한다.
- 명세 변경으로 기능이 추가되면 새 ID를 만들고 기존 ID를 재사용하지 않는다.
- AI Service Composer 추가 요구사항은 `SVC-*` ID로 별도 관리한다.
- Knowledge 챗봇 Preview·URL 게시 추가 요구사항은 [10-hosted-chatbot-publication.md](./10-hosted-chatbot-publication.md)의 `HOST-*` ID로 관리한다.
- 완료는 코드 생성이 아니라 완료 기준과 테스트 증거가 모두 충족된 상태다.
