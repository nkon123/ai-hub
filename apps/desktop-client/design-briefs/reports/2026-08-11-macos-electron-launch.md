# 구현 보고 2026-08-11 — macOS Electron 실행 진단

설계 문서: 없음 — 직접 지시
구현자: Codex / 일자: 2026-08-11

## 받은 지시

> 맥에서 일렉트론 구동하는게 좋겠네 현재 맥에서 열수 있는지 테스트 해봐 일전엔 로드 하다 바로 죽었어 보안때문에

## 무엇이 어떻게 됐나

소스 변경 없이 현재 macOS에서 Electron 개발 실행이 가능한지 진단했다. Gatekeeper,
XProtect, 격리 속성 또는 시스템 보안 설정은 변경하거나 우회하지 않았다.

| 대상 | 무엇을 | 어느 지시에서 | 신규/수정/삭제 |
|---|---|---|---|
| `node_modules/electron/dist` | 바이너리 존재·서명·macOS 정책 평가 및 실행 확인 | macOS Electron 실행 테스트 | 로컬 의존성 재구성 후 OS에 의해 다시 제거됨 |
| `design-briefs/reports/2026-08-11-macos-electron-launch.md` | 실행 증거와 차단 원인 기록 | 직접 지시 보고 | 신규 |

## 실행 결과

최초 상태에서는 `path.txt`가 `Electron.app/Contents/MacOS/Electron`을 가리켰지만
실제 `Electron.app`이 없었다.

```text
$ pnpm exec electron --version
Error: spawn .../electron/dist/Electron.app/Contents/MacOS/Electron ENOENT
```

프로젝트에 이미 선언된 공식 Electron 의존성의 postinstall만 다시 실행했다.

```text
$ pnpm rebuild electron
.../node_modules/electron postinstall$ node install.js
.../node_modules/electron postinstall: Done
```

재설치 직후 실행 파일은 arm64 Mach-O로 존재했다.

```text
$ file node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
Mach-O 64-bit executable arm64
```

macOS 정책 평가는 다음과 같았다.

```text
$ spctl -a -vv node_modules/electron/dist/Electron.app
node_modules/electron/dist/Electron.app: notarization indicates this code has been revoked
```

`electron --version` 실행이 종료되지 않고 대기한 뒤 `Electron.app`이 다시 사라졌다.
프로젝트 실행도 같은 경로를 찾지 못해 실패했다.

```text
$ ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 pnpm exec electron .
Error: spawn .../electron/dist/Electron.app/Contents/MacOS/Electron ENOENT
```

검사용으로 띄운 5173 Vite 프로세스는 종료했다. 기존 5174 렌더러만 유지된다.
`pnpm rebuild electron`이 갱신한 루트 `pnpm-lock.yaml`은 진단 전 상태로 복구했다.

## 추가한 테스트

없음. 애플리케이션 코드 결함이 아니라 로컬 macOS 보안 정책과 개발용 Electron
바이너리의 공증 평가 문제를 진단한 작업이다.

## 눈으로 확인한 결과

Mac이 잠겨 있어 보안 대화상자 자체는 읽지 못했다. 터미널에서 다음 사실을 확인했다.

1. 재설치 전에는 Electron 실행 파일이 없었다.
2. 공식 postinstall 직후에는 arm64 실행 파일이 생성됐다.
3. `spctl`이 해당 앱의 공증 상태를 revoked로 판정했다.
4. 실행 시도 이후 `Electron.app`이 다시 없어졌고 이후 실행은 `ENOENT`였다.

## 설계와 다른 부분

없음 — 설계 문서가 없는 직접 진단이다.

## 범위 밖으로 남긴 것

- `xattr -d`, `spctl` 설정 변경, Gatekeeper/XProtect 비활성화 등 보안 우회는 수행하지 않았다.
- Mac이 잠겨 있어 GUI 보안 대화상자와 Electron 창은 확인하지 못했다.
- 서명·공증된 배포용 macOS 앱 제작은 현재 `dist:win`만 있는 패키징 설정의 별도 작업이다.
