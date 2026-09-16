# AIHUB Ollama 서버 설정

저장소 루트의 `config/ollama.json`에서 `endpoint`를 변경한다.

```json
{
  "endpoint": "http://192.168.0.10:11434"
}
```

agent-runtime, indexing-runtime, search-runtime을 재시작하면 채팅, 모델 목록,
문서 임베딩, 검색 질의 임베딩에 같은 주소가 적용된다. 모델 이름은 기존 설정을 유지한다.
HTTP/HTTPS 서버 기본 주소를 입력하며 `/api`는 붙이지 않는다.

배포 환경에서는 `AIHUB_OLLAMA_CONFIG` 환경변수로 JSON 파일의 절대 경로를 지정할 수 있다.
파일 누락, 잘못된 JSON, 잘못된 URL은 시작 오류로 처리하며 localhost로 대체하지 않는다.
기존 `AGENT_RUNTIME_OLLAMA_ENDPOINT` 환경변수는 agent-runtime에 한해 파일보다 우선한다.
공통 설정을 사용하려면 해당 환경변수를 제거한다. 공통 주소는 Office Profile의 Ollama
alias endpoint보다 우선하며, Ollama 이외 provider에는 영향을 주지 않는다.

서비스 간 내부 import 없이 각 런타임이 동일한 JSON 계약을 읽는다.

`scripts/windows/doctor.ps1`의 Ollama 점검도 이 파일을 읽고 설정된 서버의
`/api/tags`를 확인한다. `AIHUB_OLLAMA_CONFIG` 경로 지정도 지원하며,
설정 파일 오류와 서버 연결 실패를 구분해서 표시한다.
