# macOS 서명·공증 구현 보고

## 받은 지시

> 서명 공증 진행해

## 구현 내용

- `pnpm dist:mac`을 추가해 arm64 DMG/ZIP 빌드 전에 서명·공증 사전검사를 수행한다.
- `Developer ID Application` 인증서가 없거나 공증 자격 증명이 불완전하면 패키징 전에 중단한다.
- Hardened Runtime과 Electron JIT용 최소 entitlement를 명시하고, 미서명 결과물을 허용하지 않는다.
- Apple ID, App Store Connect API 키, notarytool Keychain 프로필을 지원하되 비밀값은 저장하거나 출력하지 않는다.
- `pnpm verify:mac -- <app 경로>`로 코드 서명, Gatekeeper 판정, 스테이플된 공증 티켓을 검증한다.
- 지원 종료되고 이 Mac에서 공증 취소 판정을 받은 Electron 31을 현재 지원되는 안정판 43.3.0으로 갱신했다. 바이너리 설치 스크립트는 실행하지 않았다.

## 현재 환경의 차단 사항

- 이 Mac의 Keychain에는 유효한 `Developer ID Application` 인증서가 없다.
- 공증에 사용할 Apple 자격 증명이 환경에 설정되어 있지 않다.
- 따라서 파이프라인 구성과 실패 사전검증까지 완료했으며, 실제 Apple 공증 제출은 인증서/자격 증명 제공 후 실행해야 한다.
- 운영 배포 전 현재 placeholder인 bundle ID, 법인 author/copyright도 확정해야 한다.

## 검증

- `pnpm dist:mac` 사전검사: 인증서 부재를 명확한 오류로 감지하는지 확인
- macOS entitlement plist 2개와 `electron-builder.yml` 구문 검사: 통과
- `pnpm typecheck`: 통과
- `pnpm test`: 30개 파일, 371개 테스트 통과
