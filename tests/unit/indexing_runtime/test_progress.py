"""진행률은 **정직해야** 쓸모가 있다.

이 기능은 "700만자 문서를 등록했는데 멈춘 것처럼 보인다"는 보고에서 나왔다
(2026-09-17). 그러니 여기서 가장 중요한 성질은 "숫자가 나온다"가 아니라
**모르는 것을 지어내지 않는다** 이다 — 근거 없는 "약 3분 남음"이 10분째 서
있으면, 진행률이 없을 때보다 더 나쁘다(멈춘 것을 진행 중으로 오독하게 만든다).

또 하나: 진행률 보고가 색인을 깨뜨려서는 안 된다. 부가 정보 때문에 본 작업이
실패하면 완전히 손해다.
"""

from __future__ import annotations

import pytest
from indexing_runtime import pipeline, progress

from .conftest import patch_chroma, patch_embed_batch


@pytest.fixture(autouse=True)
def _clean():
    progress.clear()
    yield
    progress.clear()


# --- 모르는 것을 지어내지 않는다 --------------------------------------------


def test_percent_is_none_when_total_is_unknown() -> None:
    """총량을 모르는 단계(문서 읽기 등)에서 0%나 50%를 만들어내면, 그 숫자는
    상태가 아니라 장식이다."""
    progress.start("j1")
    assert progress.get("j1").percent is None


def test_eta_is_none_before_any_real_progress() -> None:
    """진행이 0인데 남은 시간을 추정하면 근거가 없다 — 속도를 모른다."""
    progress.report("j1", "embed", 0, 1000)
    assert progress.get("j1").eta_seconds is None


def test_eta_is_none_when_finished() -> None:
    progress.report("j1", "embed", 1000, 1000)
    assert progress.get("j1").eta_seconds is None


def test_percent_reflects_actual_counts() -> None:
    progress.report("j1", "embed", 250, 1000)
    assert progress.get("j1").percent == 25.0


def test_eta_uses_the_measured_rate(monkeypatch) -> None:
    """남은 시간은 지금까지의 실제 처리 속도로만 계산한다."""
    clock = {"t": 100.0}
    monkeypatch.setattr(progress.time, "monotonic", lambda: clock["t"])

    progress.start("j1")
    clock["t"] = 110.0  # 10초 동안
    progress.report("j1", "embed", 100, 400)  # 100개 처리 -> 10개/초

    # 남은 300개 -> 약 30초
    assert progress.get("j1").eta_seconds == pytest.approx(30.0, abs=0.5)


# --- 없는 Job / 없는 job_id --------------------------------------------------


def test_unknown_job_returns_none() -> None:
    assert progress.get("없는-job") is None


def test_reporting_without_a_job_id_is_a_no_op() -> None:
    """CLI 경로에는 job_id 가 없다. 그것 때문에 색인이 실패하면 안 된다."""
    progress.start(None)
    progress.report(None, "embed", 1, 2)
    progress.finish(None)  # 예외가 나지 않아야 한다


# --- 크기 상한 (D-067 의 교훈) ----------------------------------------------


def test_tracked_jobs_are_bounded() -> None:
    """프로세스 수명 동안 무한히 자라는 자료구조를 만들지 않는다 — 이 저장소는
    이미 그런 누수로 런타임이 멈춘 적이 있다(D-067, Chroma 클라이언트)."""
    for i in range(progress.MAX_TRACKED_JOBS * 3):
        progress.report(f"job-{i}", "embed", 1, 10)
    assert len(progress._jobs) <= progress.MAX_TRACKED_JOBS


def test_oldest_job_is_evicted_first() -> None:
    for i in range(progress.MAX_TRACKED_JOBS + 1):
        progress.report(f"job-{i}", "embed", 1, 10)
    assert progress.get("job-0") is None
    assert progress.get(f"job-{progress.MAX_TRACKED_JOBS}") is not None


# --- 끝난 뒤 --------------------------------------------------------------


def test_finish_pins_the_last_state_to_complete() -> None:
    """끝나자마자 지우면 마지막 폴링이 404 를 받아 '끝났는지 사라졌는지'
    구분할 수 없다."""
    progress.report("j1", "embed", 900, 1000)
    progress.finish("j1")
    state = progress.get("j1")
    assert state is not None
    assert state.percent == 100.0


# --- 파이프라인 실제 배선 ----------------------------------------------------


@pytest.mark.asyncio
async def test_pipeline_reports_progress_for_a_real_run(tmp_path, monkeypatch) -> None:
    """배선이 실제로 되어 있는지. 모듈만 있고 파이프라인이 호출하지 않으면
    진행률은 영원히 비어 있다."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "doc.md").write_text("# 제목\n\n본문입니다.\n", encoding="utf-8")

    patch_chroma(monkeypatch, pipeline)
    patch_embed_batch(monkeypatch, pipeline)

    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id="55555555-5555-5555-5555-555555555555",
        index_base=str(tmp_path / "indexes"),
        job_id="job-abc",
    )
    assert result["status"] == "COMPLETED"

    state = progress.get("job-abc")
    assert state is not None
    assert state.percent == 100.0


@pytest.mark.asyncio
async def test_pipeline_without_job_id_still_indexes(tmp_path, monkeypatch) -> None:
    """job_id 를 안 주는 기존 호출자(CLI)가 그대로 동작해야 한다."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "doc.md").write_text("# 제목\n\n본문입니다.\n", encoding="utf-8")

    patch_chroma(monkeypatch, pipeline)
    patch_embed_batch(monkeypatch, pipeline)

    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id="66666666-6666-6666-6666-666666666666",
        index_base=str(tmp_path / "indexes"),
    )
    assert result["status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_a_failing_progress_callback_does_not_fail_the_job(monkeypatch) -> None:
    """진행률 보고가 색인을 깨뜨리면 부가 정보 때문에 본 작업을 잃는 것이다."""
    import httpx
    from indexing_runtime import embedders

    def boom(done: int, total: int) -> None:
        raise RuntimeError("진행률 보고 실패")

    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json={"embeddings": [[0.1]] * 2})
    )
    real = httpx.AsyncClient

    class _Mocked(real):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            kw.pop("transport", None)
            super().__init__(*a, transport=transport, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", _Mocked)

    out = await embedders.embed_batch(["a", "b"], batch_size=2, on_progress=boom)
    assert len(out) == 2
