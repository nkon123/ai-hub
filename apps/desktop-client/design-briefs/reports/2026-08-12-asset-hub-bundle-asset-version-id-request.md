# 자산 허브 수정 요청 — Knowledge Bundle의 AssetVersion ID 누락

## 받은 지시

> 외부 요인이면 고치지말고 기록만 해둬, 이건 자산허브쪽에 수정 요청 해야해.

## 요청 대상

- 자산 허브 Portal API 운영 담당
- Distribution Service 운영·개발 담당
- Offline Bundle Manifest 계약 담당

## 문제 요약

자산 허브에서 Knowledge를 내려받아 Desktop Client에 정상 설치했으나, 생성된
Offline Bundle의 `bundle-manifest.yaml` 내 `included_assets[]`에
`asset_version_id`가 없어 채팅에서 지식 검색을 활성화할 수 없다.

Desktop Client는 부모 Asset ID와 AssetVersion ID가 서로 다른 식별자라는 계약을
지킨다. 검색 런타임은 AssetVersion ID로 인덱스를 찾으므로, 누락 시 부모 ID로
추측하지 않고 해당 Knowledge를 검색 불가로 표시하는 것이 정상 동작이다.

## 재현 자산

```text
자산명: 재택근무 정책 Knowledge
Asset ID: 2f157a86-29c2-41d7-a8a8-e3d34a36e515
AssetVersion ID: d9e660b7-ca76-4f46-899e-2e1621bac139
버전: 1.0.0
생성된 Bundle ID: 4a165a79-7c97-4f2c-bcff-8213d6a3dd33
설치 시각: 2026-08-12T13:11:48.215Z
Desktop 설치 결과 assetVersionId: null
```

## 확인된 원인

저장소의 최신 코드는 이미 다음 필드를 생성하도록 구현되어 있다.

```yaml
included_assets:
  - asset_id: 2f157a86-29c2-41d7-a8a8-e3d34a36e515
    asset_version_id: d9e660b7-ca76-4f46-899e-2e1621bac139
```

그러나 실제 실행 프로세스가 수정 전부터 재시작되지 않았다.

| 항목 | 시각 |
|---|---|
| Distribution Service 시작 | 2026-08-06 09:56:04 |
| Portal API 시작 | 2026-08-06 22:39:36 |
| Distribution 계약 코드 수정 | 2026-08-08 14:31:16 |
| Distribution bundler 수정 | 2026-08-09 10:47:49 |
| Portal distribution serializer 수정 | 2026-08-09 20:30:10 |
| 문제 Bundle 설치 | 2026-08-12 22:11 KST |

따라서 최신 소스가 아니라 프로세스 메모리에 남아 있던 구버전 코드가 Bundle을
생성한 것으로 확인됐다.

## 자산 허브 측 요청 사항

1. Portal API와 Distribution Service를 최신 배포본으로 재시작한다.
2. 두 서비스의 실행 버전 또는 commit SHA가 수정 포함 버전인지 확인한다.
3. 위 Knowledge로 Offline Bundle을 다시 생성한다.
4. 생성된 `bundle-manifest.yaml`의 Knowledge 항목에 다음 두 ID가 서로 구분되어
   포함되는지 확인한다.

   ```text
   asset_id: 2f157a86-29c2-41d7-a8a8-e3d34a36e515
   asset_version_id: d9e660b7-ca76-4f46-899e-2e1621bac139
   ```

5. Distribution Service 회귀 테스트에 실제 생성 ZIP의 Manifest를 열어
   `asset_version_id`가 보존되는 검사를 포함한다.
6. 서비스 시작 시 build version/commit SHA를 로그나 health 응답에 노출해 소스와
   실행 프로세스의 버전 불일치를 확인할 수 있게 한다.

## 완료 조건

- 새 Bundle을 Desktop Client에 설치했을 때 `installations.json`의 해당 항목에
  `assetVersionId: d9e660b7-ca76-4f46-899e-2e1621bac139`가 저장된다.
- 채팅 화면의 `보유 Knowledge에서 찾기`가 활성화된다.
- 해당 Knowledge 질문에서 로컬 Citation이 반환된다.

## Desktop Client 처리 방침

이번 문제를 이유로 Desktop Client가 `assetVersionId` 누락 시 부모 `assetId`를
대체 사용하도록 변경하지 않는다. 그렇게 하면 잘못된 ID로 검색하면서 오류 없이
0건만 반환하는 문제가 재발한다. 자산 허브가 올바른 Bundle 계약을 제공하는 것이
수정 지점이다.

또한 Desktop 설치 경로와 search-runtime 인덱스 경로 연결은 별도의 구조 개선
과제로 남긴다. 이 요청서의 직접 범위는 자산 허브가 Bundle에 AssetVersion ID를
정상 포함하는 것까지다.

## 2026-08-12 후속 구현 결과

요청 사항 6의 운영 식별 기능을 Portal API와 Distribution Service 양쪽에
구현했다.

- 배포 자동화가 `PORTAL_BUILD_VERSION`/`PORTAL_COMMIT_SHA`와
  `DISTRIBUTION_BUILD_VERSION`/`DISTRIBUTION_COMMIT_SHA`를 주입할 수 있다.
- 두 서비스의 `/health`가 `status`, `version`, `commit_sha`를 반환한다.
- 두 서비스가 시작될 때 실제 메모리에 로드된 build version과 commit SHA를
  구조화 로그로 한 번 기록한다.
- 로컬에서 값이 주입되지 않은 경우 Git 작업 트리를 추측하지 않고
  `commit_sha: "unknown"`을 반환한다.
- Portal OpenAPI의 `HealthResponse`에도 두 필드를 필수 계약으로 반영했다.

회귀 검증은 Portal API/Distribution Service 관련 263개 테스트, 전체 계약
30개, 변경 범위 정적 검사를 통과했다. 실제 장기 실행 프로세스의 재시작과 새
Bundle 재생성은 운영 상태를 바꾸는 작업이므로 이 구현 작업에서는 수행하지
않았다.
