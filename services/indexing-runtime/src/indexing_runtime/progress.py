"""색인 Job의 진행 상황 — 메모리 안에서만 산다.

## 왜 필요한가

`/indexing/v1/jobs` 는 파이프라인을 **동기 실행**하고 끝나야 응답한다. 큰 문서는
그 사이가 몇 분이고, 그동안 밖에서 볼 수 있는 것은 "아직 응답이 없다" 뿐이다.
portal-api 의 `IndexingJob` 행도 `status='RUNNING'` 만 들고 있고 `chunk_count` 는
**끝나야** 채워진다. 그래서 등록 화면에는 돌아가는 스피너 말고 보여 줄 것이 없고,
등록한 사람 입장에서 "진행 중"과 "멈춤"이 구분되지 않는다. 실제로 사내 테스트에서
700만자 문서를 올리고 "멈춘 것처럼 보인다"는 보고가 나왔다(2026-09-17).

## 왜 DB가 아니라 메모리인가

`portal.db` 는 M02 소유다. M07 이 거기에 쓰면 모듈 경계를 깬다. 그리고 진행률은
**Job 이 살아 있는 동안만** 의미가 있다 — indexing-runtime 프로세스가 죽으면 그
Job 도 같이 죽고(HTTP 연결이 끊겨 portal-api 가 FAILED 로 기록한다) 진행률을
남겨 둘 이유가 없다. 영속성이 필요 없는 값을 DB에 넣으면 정리 책임만 생긴다.

## 크기 상한

D-067(Chroma 클라이언트 누수로 런타임이 2일 7시간 만에 멈춘 사고)의 교훈대로,
프로세스 수명 동안 무한히 자라는 자료구조를 만들지 않는다. 오래된 항목부터
버린다.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, replace

#: 동시에 추적할 Job 수 상한. 이 저장소는 Job 을 동기로 한 건씩 처리하므로
#: 실제로는 1~2개면 충분하지만, 끝난 Job 의 최종 상태를 잠시 더 들고 있어야
#: 마지막 폴링이 100%를 볼 수 있어서 여유를 둔다.
MAX_TRACKED_JOBS = 32

#: 파이프라인 단계. 순서가 곧 진행 순서이고, UI 는 "N/M 단계"로 쓴다.
STAGES = ("load", "chunk", "embed", "store", "index", "finalize")

#: 사용자에게 보여 줄 단계 이름. 기술 용어보다 무슨 일이 일어나는지를 적는다
#: (루트 CLAUDE.md UI 규칙: 기술 명칭보다 업무 목적을 먼저).
STAGE_LABELS = {
    "load": "문서 읽는 중",
    "chunk": "문서 나누는 중",
    "embed": "임베딩 생성 중",
    "store": "벡터 저장 중",
    "index": "키워드 색인 만드는 중",
    "finalize": "마무리 중",
}


@dataclass(frozen=True)
class JobProgress:
    job_id: str
    stage: str
    done: int
    total: int
    started_at: float
    updated_at: float

    @property
    def stage_index(self) -> int:
        return STAGES.index(self.stage) + 1 if self.stage in STAGES else 0

    @property
    def percent(self) -> float | None:
        """이 단계의 진행률. 총량을 모르는 단계(load 등)는 None 이다.

        모르는 것을 0%나 50%로 꾸며내지 않는다 — 진행률 표시의 값어치는 그것이
        실제 상태라는 믿음에서 나온다.
        """
        if self.total <= 0:
            return None
        return round(100.0 * self.done / self.total, 1)

    @property
    def elapsed_seconds(self) -> float:
        return max(0.0, self.updated_at - self.started_at)

    @property
    def eta_seconds(self) -> float | None:
        """남은 시간 추정. 지금까지의 실제 처리 속도로만 계산한다.

        진행이 없거나(done=0) 총량을 모르면 None — 추정할 근거가 없을 때
        아무 숫자나 내놓으면 "3분 남음"이 10분째 3분 남음으로 서 있게 된다.
        """
        if self.total <= 0 or self.done <= 0 or self.done >= self.total:
            return None
        rate = self.done / self.elapsed_seconds if self.elapsed_seconds > 0 else 0
        if rate <= 0:
            return None
        return round((self.total - self.done) / rate, 1)

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "stage": self.stage,
            "stage_label": STAGE_LABELS.get(self.stage, self.stage),
            "stage_index": self.stage_index,
            "stage_total": len(STAGES),
            "done": self.done,
            "total": self.total,
            "percent": self.percent,
            "elapsed_seconds": round(self.elapsed_seconds, 1),
            "eta_seconds": self.eta_seconds,
        }


_jobs: OrderedDict[str, JobProgress] = OrderedDict()


def start(job_id: str | None) -> None:
    if not job_id:
        return
    now = time.monotonic()
    _jobs[job_id] = JobProgress(job_id, STAGES[0], 0, 0, now, now)
    _jobs.move_to_end(job_id)
    while len(_jobs) > MAX_TRACKED_JOBS:
        _jobs.popitem(last=False)


def report(job_id: str | None, stage: str, done: int = 0, total: int = 0) -> None:
    """한 단계의 진행을 기록한다. 추적 중이 아닌 Job 은 조용히 무시한다
    (CLI 실행처럼 job_id 가 없는 경로가 있고, 그것 때문에 색인이 실패해서는
    안 된다)."""
    if not job_id:
        return
    prev = _jobs.get(job_id)
    if prev is None:
        start(job_id)
        prev = _jobs[job_id]
    _jobs[job_id] = replace(prev, stage=stage, done=done, total=total,
                            updated_at=time.monotonic())
    _jobs.move_to_end(job_id)


def get(job_id: str) -> JobProgress | None:
    return _jobs.get(job_id)


def finish(job_id: str | None) -> None:
    """마지막 상태를 100%로 못 박는다. 바로 지우지 않는 이유는, 지우면 마지막
    폴링이 404 를 받아 '끝났는지 사라졌는지' 구분이 안 되기 때문이다."""
    if not job_id:
        return
    prev = _jobs.get(job_id)
    if prev is None:
        return
    total = prev.total or prev.done
    _jobs[job_id] = replace(prev, stage=STAGES[-1], done=total, total=total,
                            updated_at=time.monotonic())


def clear() -> None:
    """테스트용."""
    _jobs.clear()
