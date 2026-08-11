# AGENTS.md — Desktop Client (M04)

이 디렉터리의 지침은 **[`./CLAUDE.md`](./CLAUDE.md)** 에 있다. 코드를 건드리기
전에 반드시 읽는다. 같은 폴더에 있으므로 이 디렉터리만 열어도 읽을 수 있다.

작업 지시는 **[`./design-briefs/`](./design-briefs/)** 의 설계 문서로 전달된다.
형식과 제출 방법은 [`./design-briefs/README.md`](./design-briefs/README.md)에 있다.

이 디렉터리는 자기완결이다 — 빌드·테스트·타입체크가 여기서 전부 돌고
(`pnpm test`, `pnpm typecheck`), 바깥 디렉터리를 import하는 코드는 없다.
상위 저장소를 볼 수 없어도 작업할 수 있게 필요한 규칙은 `CLAUDE.md`에
옮겨 적어 두었다.

> 왜 포인터 파일인가: 같은 내용을 `AGENTS.md`와 `CLAUDE.md` 양쪽에 두면 반드시
> 갈라진다. 심볼릭 링크는 배포 대상이 Windows(사내 폐쇄망 PC)라 쓰지 않는다 —
> git 심볼릭 링크는 Windows 체크아웃에서 텍스트 파일로 풀리거나 권한 문제를
> 일으킨다.
