# Electron 31 → 43 변경 및 macOS 실행 검증 종합 정리

## 받은 지시

> 변경 내용 정리 해서 파일로 남겨주고

## 배경과 원인

기존 프로젝트는 Electron `^31.0.0`을 선언했고 실제 잠금 버전은 31.7.7이었다.
이 버전은 2024년에 나온 뒤 공식 지원이 종료된 구버전이다. 당시 내려받은
`Electron.app`을 현재 Mac에서 검사했을 때 다음 판정이 나왔다.

```text
notarization indicates this code has been revoked
```

실행을 시도한 뒤 `Electron.app`이 사라졌으며, 이후에는 실행 파일을 찾지 못하는
`ENOENT` 오류로 Electron 개발 앱이 시작되지 않았다. 프로젝트의 React 화면이나
IPC 코드 오류가 아니라, 이 Mac에서 기존 Electron 31 런타임이 보안 신뢰 검사를
통과하지 못한 것이 직접 원인이었다.

Gatekeeper, XProtect, quarantine 설정을 끄거나 변경하지 않았고 `xattr -d` 같은
격리 속성 제거도 수행하지 않았다.

## 변경 내용

### Electron 런타임

- `package.json`의 Electron을 `^31.0.0`에서 `^43.3.0`으로 변경했다.
- 루트 `pnpm-lock.yaml`을 Electron 43.3.0 의존성 트리에 맞게 갱신했다.
- 공식 Electron npm 패키지의 설치 스크립트로 arm64 개발 런타임을 받았다.
- `pnpm exec electron --version`에서 `v43.3.0`을 확인했다.

Electron 43.3.0은 작업 당시 공식 지원되는 안정판 계열이며, 31 계열과 달리 이
Mac에서 실행 파일이 삭제되지 않고 정상 기동했다.

### macOS 서명·공증 준비

- `pnpm dist:mac` 스크립트를 추가했다.
- arm64 DMG와 ZIP을 생성하도록 `electron-builder.yml`에 macOS 타깃을 추가했다.
- Hardened Runtime과 Electron JIT용 entitlement를 추가했다.
- Developer ID 인증서가 없으면 미서명 결과물을 만들지 않고 빌드를 중단하도록 했다.
- Apple ID, App Store Connect API 키, notarytool Keychain 프로필 방식의 공증
  자격 증명을 지원하는 사전검사를 추가했다.
- `pnpm verify:mac -- <app 경로>`로 코드 서명, Gatekeeper 판정, 스테이플된 공증
  티켓을 확인하는 검증 스크립트를 추가했다.
- 인증서·비밀번호·API 키는 저장소에 넣거나 로그에 출력하지 않는다.

현재 이 Mac에는 유효한 `Developer ID Application` 인증서와 공증 자격 증명이
없으므로 실제 배포용 DMG 서명·Apple 공증 제출은 아직 실행하지 않았다. 지금
성공한 것은 로컬 개발 실행이며, 다른 Mac에 배포하려면 서명·공증이 여전히 필요하다.

## 개발 실행 방식

브라우저 프리뷰와 Electron 개발 실행은 다음 차이가 있다.

```text
브라우저 프리뷰
  Vite → React 렌더러만 실행
  window.desktop 없음 → 파일시스템/IPC 기능 제한

Electron 개발 실행
  Electron Main → preload → window.desktop → IPC → 로컬 파일시스템
  Vite 렌더러를 Electron 창에 로드
```

5173에서 Vite가 준비되기 전에 Electron이 접근하면 최초
`ERR_CONNECTION_REFUSED`가 발생할 수 있어, 검증할 때는 Vite를 먼저 실행한 뒤
Electron을 별도로 실행했다. 이후 `electron/main.ts`에 이미 존재하는 재시도 로직도
확인했다.

## 파일시스템 IPC 검증 결과

Electron 렌더러의 실제 `window.desktop` 브리지를 통해 다음을 검증했다.

- preload 브리지 노출: 정상, 38개 메서드
- 설치 루트 조회: `~/Library/Application Support/desktop-client`
- Desktop 설정 조회: 통과
- 디스크 공간 정보 조회: 통과
- 시스템 정보 조회: 통과
- 설치 자산 목록 조회: 통과
- 대화 목록 조회: 통과
- 임시 대화 생성: 통과
- 임시 대화에 턴 추가: 통과
- 저장된 대화 재조회: 통과
- 임시 대화 삭제 및 삭제 후 부재 확인: 통과

진단용으로 생성한 대화는 검증 후 삭제해 사용자 데이터에 남기지 않았다.

## 화면 검증 결과

- Electron 43.3.0 앱 창 실행을 확인했다.
- `http://localhost:5173/` 렌더러가 1280×800 제품 창에 정상 로드됐다.
- 채팅, 자산 허브, 설정 메뉴를 확인했다.
- 기본 Ollama 대화 화면과 Knowledge 기능 제한 안내를 확인했다.
- 하단 모델 선택에 `wcamaralopes/bonsai-27b:latest`가 표시되는 것을 확인했다.
- 화면 캡처에 사용한 로컬 진단 포트는 매번 캡처 후 닫고 일반 Electron 실행으로
  되돌렸다.

## 자동 검증

- `pnpm typecheck`: 통과
- `pnpm test`: 30개 파일, 371개 테스트 통과
- `electron-builder.yml` YAML 검사: 통과
- macOS entitlement plist 2개 구문 검사: 통과
- macOS 서명 사전검사: Developer ID 인증서 부재를 의도대로 감지하고 중단

## 관련 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `package.json` | Electron 43.3.0, `dist:mac`, `verify:mac` 추가 |
| `pnpm-lock.yaml` | Electron 43.3.0 의존성 잠금 갱신 |
| `electron-builder.yml` | arm64 DMG/ZIP, Hardened Runtime, 서명 강제, 공증 설정 |
| `packaging/entitlements.mac.plist` | Main 앱용 최소 entitlement |
| `packaging/entitlements.mac.inherit.plist` | Helper 프로세스용 최소 entitlement |
| `packaging/README.md` | 인증서·공증 자격 증명과 실행 방법 안내 |
| `scripts/macos-signing-preflight.mjs` | 인증서·공증 환경 사전검사 |
| `scripts/verify-macos-artifact.mjs` | 서명·Gatekeeper·스테이플 검증 |

## 결론

이전 문제가 해결된 이유는 macOS 보안을 우회했기 때문이 아니라, 보안 신뢰 검사를
통과하지 못하고 지원도 종료된 Electron 31.7.7 런타임을 지원 중인 Electron
43.3.0 공식 런타임으로 교체했기 때문이다. 현재 이 Mac에서는 Electron UI,
preload, IPC, 파일 읽기·쓰기 기능을 개발 모드로 테스트할 수 있다. 배포 단계만
회사 Developer ID 인증서와 Apple 공증 자격 증명 준비 후 남아 있다.
