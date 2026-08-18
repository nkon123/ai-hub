# Knowledge/MCP 설치 UX 1차 구현 기록

## 요청

Asset Hub에 등록·승인한 Knowledge와 MCP Tool을 VS Code Extension처럼 Desktop에서 찾아 설치하거나, 승인 시점의 ZIP으로 내려받아 가져오는 흐름을 단순하게 만든다.

## 이번 구현

- Portal 카탈로그의 핵심 동작을 Knowledge/MCP Tool 등록으로 좁혔다.
- MCP Tool 등록은 서버 연결 이름, Tool 호출 이름, 제한 시간, 사용자 확인 여부를 기본 입력으로 제공하고 Manifest 직접 편집은 고급 설정으로 이동했다.
- 승인된 자산 버전은 별도 반출 요청 화면을 여러 번 이동하지 않고 버전 화면에서 ZIP 생성과 다운로드를 이어서 수행한다.
- Desktop Store는 이름 검색과 Knowledge/MCP Tool 필터를 제공한다.
- Desktop Store의 설치 버튼은 즉시 기존 안전 검증·설치 파이프라인을 실행한다.
- Portal 연결 설정은 최초 연결 또는 변경할 때만 펼친다.
- Offline Bundle Import 용어를 사용자 관점의 `ZIP 가져오기`로 정리했다.

## 지킨 경계

- ZIP 생성은 기존 Distribution Service를 사용하므로 승인 상태, 긴급 회수, 권한, 감사, 체크섬 검증을 우회하지 않는다.
- Desktop 설치는 기존 `importBundle()` 15단계 검증을 그대로 재사용한다.
- M04 Desktop이 M05 Agent Runtime 또는 M08 Search Runtime의 내부 코드를 Import하지 않는다.
- 사용자 UI와 신규 코드에서는 `RAG` 대신 저장소 표준 용어인 `Knowledge`를 사용한다.

## 남은 구조적 공백

현재 `설치됨`은 파일과 설치 메타데이터가 안전하게 기록되었다는 뜻이다. 새로 설치한 Knowledge가 search-runtime의 검색 경로에 자동 등록되거나, MCP Tool이 agent-runtime/Office Profile의 실행 레지스트리에 자동 연결된다는 뜻은 아니다.

이전 Bundle이 `asset_version_id`만 누락했지만 설치된 Knowledge의 `index/index-meta.json`과 설치 시점 체크섬은 보존한 경우에는 Desktop이 식별자를 자동 복구한다. 체크섬이 없거나 달라진 파일, UUID가 아닌 값, 부모 Asset ID와 같은 값은 복구하지 않는다. 이 복구는 식별자 전달 장애만 해소하며, 설치된 index 경로를 search-runtime에 등록하는 D-079 활성화 계약을 대신하지 않는다.

다음 단계는 D-079의 공개 Loopback API 계약을 먼저 정의한 후 구현해야 한다. Desktop에서 설치와 활성화 상태를 분리해 보여주고, 활성화 실패 시 설치 파일을 손상시키지 않으면서 재시도하거나 되돌릴 수 있어야 한다.
