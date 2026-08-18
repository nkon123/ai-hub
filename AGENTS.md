# AGENTS.md

이 저장소의 지침은 **[`./CLAUDE.md`](./CLAUDE.md)** 에 있다. 작업 전에 반드시 읽는다.

모듈별 지침은 각 모듈 루트의 `CLAUDE.md`에 있다(예:
`apps/desktop-client/CLAUDE.md`, `services/agent-runtime/CLAUDE.md`,
`tests/CLAUDE.md`). 담당 모듈의 파일을 건드리기 전에 그 모듈의 것도 읽는다.

> 왜 포인터 파일인가: 같은 내용을 `AGENTS.md`와 `CLAUDE.md` 양쪽에 두면 반드시
> 갈라진다. 심볼릭 링크는 이 저장소의 배포 대상이 Windows(사내 폐쇄망 PC)라
> 쓰지 않는다 — git 심볼릭 링크는 Windows 체크아웃에서 텍스트 파일로 풀리거나
> 권한 문제를 일으킨다. 그래서 원본은 `CLAUDE.md` 하나로 두고 여기서 가리킨다.
