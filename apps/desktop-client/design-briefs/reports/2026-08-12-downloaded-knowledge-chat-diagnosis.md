# 자산 허브에서 설치한 Knowledge가 채팅에 사용되지 않는 원인 진단

## 받은 지시

> 자산허브에서 날리지를 다운받아 불러왔는데, 해당 지식에대해 이야기 해볼수가 없네 원인 찾아봐줘

후속 지시:

> 외부 요인이면 고치지말고 기록만 해둬, 이건 자산허브쪽에 수정 요청 해야해.

## 결론

직접 원인은 다운로드한 Offline Bundle의 `included_assets[]`에
`asset_version_id`가 없어서, Desktop 설치 기록의 `assetVersionId`가 `null`로
저장된 것이다. 채팅과 search-runtime은 부모 Asset ID가 아니라 AssetVersion ID로
Knowledge를 검색하므로 Desktop은 이 자산을 검색 대상에서 의도적으로 제외한다.

지식 원문이나 검색 인덱스가 손상된 문제는 아니다. 실제 AssetVersion ID로
search-runtime에 직접 질의했을 때 정상적인 근거가 반환됐다.

## 확인한 설치 데이터

설치된 자산:

```text
이름: 재택근무 정책 Knowledge
Asset ID: 2f157a86-29c2-41d7-a8a8-e3d34a36e515
버전: 1.0.0
Bundle ID: 4a165a79-7c97-4f2c-bcff-8213d6a3dd33
설치 시각: 2026-08-12T13:11:48.215Z
AssetVersion ID: null
```

설치 기록 위치:

```text
~/Library/Application Support/desktop-client/state/installations.json
```

설치된 인덱스의 `index/index-meta.json`에는 실제 검색 ID가 존재한다.

```text
knowledge_id: d9e660b7-ca76-4f46-899e-2e1621bac139
chunk_count: 4
document_count: 1
embed_model: qwen3-embedding:0.6b
```

즉 Bundle 안에는 올바른 인덱스가 들어왔지만, Bundle Manifest가 그 인덱스를
가리키는 AssetVersion ID를 Desktop 설치 목록까지 전달하지 못했다.

## 채팅에서 제외되는 코드 경로

`electron/bundle-install.ts`는 Bundle Manifest의 값을 다음처럼 저장한다.

```text
assetVersionId = item.asset_version_id ?? null
```

`src/screens/chatTypes.ts`의 `resolveKnowledgeSelection()`은
`assetVersionId`가 없으면 빈 Knowledge ID를 반환한다. 부모 `assetId`로 대체하지
않는 것은 의도된 안전 동작이다. 두 ID는 서로 다르며 잘못된 부모 ID를 보내면
오류 없이 검색 결과만 항상 0건이 되는 더 위험한 문제가 생기기 때문이다.

그 결과 `ChatScreen`은 다음 상태가 된다.

```text
설치된 Knowledge 수: 1
검색 가능한 Knowledge ID 수: 0
보유 Knowledge에서 찾기: 비활성화
대화 방식: 기본 Ollama 일반 대화
```

## 왜 8월 12일에 받은 Bundle이 구형 형식인가

현재 저장소 코드는 이미 `asset_version_id`를 전달하도록 수정되어 있다.

- Portal API `routers/distributions.py` 수정 시각: 2026-08-09 20:30:10
- Distribution Service `bundler.py` 수정 시각: 2026-08-09 10:47:49
- Distribution Service `contracts.py` 수정 시각: 2026-08-08 14:31:16

하지만 실행 중인 서비스는 수정 전부터 재시작되지 않았다.

- Portal API 시작: 2026-08-06 22:39:36
- Distribution Service 시작: 2026-08-06 09:56:04

따라서 8월 12일의 새 다운로드 요청도 프로세스 메모리에 남아 있던 구버전
serializer/bundler가 처리했다. 그 결과 현재 코드와 달리 `asset_version_id`가 없는
구형 Bundle이 생성됐다.

## 지식 인덱스 정상 여부 실측

search-runtime에 실제 AssetVersion ID
`d9e660b7-ca76-4f46-899e-2e1621bac139`로 다음 질문을 직접 보냈다.

```text
재택근무 장비 지원은 무엇인가요?
```

정상적으로 2개 Citation이 반환됐고, 최상위 근거는 다음 내용이었다.

```text
섹션: 장비 지원
- 재택근무자에게 모니터 1대와 노트북 거치대 지급
- 인터넷 요금 월 3만원까지 지원
similarity: 0.6978
```

따라서 이번 장애는 문서·Chroma·BM25·임베딩 모델 문제가 아니라 식별자 전달
계약 문제다.

## 2차 구조 문제

현재 search-runtime의 `INDEX_BASE` 기본값은 저장소 중앙 경로다.

```text
<repo>/data/indexes/{asset_version_id}
```

Desktop이 Bundle을 설치하는 경로는 별도다.

```text
~/Library/Application Support/desktop-client/assets/knowledge/{asset_id}/{version}/index
```

현재 Desktop 설치 후 이 경로를 search-runtime에 등록하거나 중앙 인덱스 경로로
연결하는 코드가 없다. 이번 재택근무 데모 Knowledge는 동일 인덱스가 저장소
`data/indexes/d9e660b7-...`에도 이미 존재해서 AssetVersion ID만 정상 전달되면
검색된다. 그러나 중앙 인덱스에 없는 완전히 새로운 Knowledge는 ID 문제를 고쳐도
추가 등록/경로 연결 없이는 검색되지 않을 수 있다.

또한 배포 채널을 통해 받은 `bm25.pkl`은 신뢰 경계가 다르므로, Desktop 설치
인덱스를 search-runtime에 연결할 때는 legacy pickle 허용 여부와 변환 정책도 함께
설계해야 한다.

## 권장 복구 순서

1. Portal API와 Distribution Service를 최신 코드로 재시작한다.
2. 자산 허브에서 같은 Knowledge의 Bundle을 새로 생성해 다시 다운로드한다.
3. 기존 설치를 새 Bundle로 재설치한다.
4. `installations.json`의 해당 항목에 다음 값이 저장됐는지 확인한다.

   ```text
   assetVersionId: d9e660b7-ca76-4f46-899e-2e1621bac139
   ```

5. 채팅에서 `보유 Knowledge에서 찾기`가 활성화되는지 확인한다.
6. 중앙 `data/indexes`에 없는 신규 Knowledge까지 지원하려면 Desktop 설치 인덱스를
   로컬 search-runtime에 안전하게 등록하는 별도 구현을 진행한다.

## 이번 작업 범위

사용자가 원인 진단을 요청했으므로 서비스 재시작, 기존 설치 수정, Bundle 재생성,
코드 변경은 수행하지 않았다. 기존 사용자 데이터도 변경하지 않았다.

후속 지시에 따라 이 문제를 Desktop Client 수정 대상이 아닌 자산 허브 측 수정 요청
대상으로 확정했다. Desktop의 `assetVersionId` 검증이나 부모 Asset ID 대체 금지
동작은 올바른 안전장치이므로 변경하지 않는다. 자산 허브 담당자용 요청 사항은
`2026-08-12-asset-hub-bundle-asset-version-id-request.md`에 별도로 기록했다.
