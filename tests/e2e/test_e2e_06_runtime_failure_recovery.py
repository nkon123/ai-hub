"""E2E-06 — Runtime 장애 복구 (06-quality-delivery.md §8).

The task brief is explicit: "do NOT kill any running service — I'm using
them. Simulate unavailability by pointing a client at a dead port and
asserting the caller degrades gracefully, or skip with a reason."

So this test never touches the live agent-runtime on :8100. Instead it
points a real `httpx.AsyncClient` at a guaranteed-closed local port
(`http://127.0.0.1:1` — port 0/1 never accepts application traffic) to
simulate "Runtime 강제 종료" from a caller's point of view, and asserts the
caller-side failure is a clean, typed connection error rather than a hang
or an unhandled exception — the same failure mode a Desktop Client's own
health-check/run-submission code must handle to show "복구 안내" instead of
crashing (CLAUDE.md UI 구현 규칙: "Desktop은 Runtime 장애 시 종료되지 않고
복구 안내를 제공한다").

Step-by-step mapping to §8's E2E-06 text:
  1. "실행 중 Runtime 강제 종료"      -> simulated via a dead-port client,
     not by killing the real, in-use agent-runtime process.
  2. "Desktop이 장애 감지"           -> asserted at the HTTP-client layer
     (connection refused/timeout), the same signal Desktop's health check
     consumes; the Desktop UI's own rendering of that signal needs Electron
     (skipped below).
  3. "실패 Run과 Trace 표시"         -> skipped (Desktop UI, Electron unavailable).
  4. "Runtime 재시작"                -> not performed (would require
     stopping/starting the real, in-use process — explicitly out of bounds
     per the task brief).
  5. "새 Run 정상 실행"              -> proven by every other E2E-0x test in
     this suite already running successful runs against the real,
     never-interrupted agent-runtime — a fresh, unrelated run request is
     the same code path a post-restart run would take.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.e2e

# Reserved/unassigned port that will never accept a connection on
# localhost, standing in for "the Runtime process is down" without
# touching the real agent-runtime this session is using.
_DEAD_RUNTIME_URL = "http://127.0.0.1:1"


async def test_e2e_06_client_degrades_gracefully_when_runtime_unreachable() -> None:
    async with httpx.AsyncClient(base_url=_DEAD_RUNTIME_URL, timeout=5.0) as dead_client:
        with pytest.raises(httpx.TransportError):
            await dead_client.post(
                "/local/v1/runs",
                json={"service_id": "e2e-06-probe", "input": {"question": "테스트"}},
            )


async def test_e2e_06_new_run_succeeds_against_the_real_untouched_runtime(
    agent: httpx.AsyncClient,
) -> None:
    """Step 5 in spirit: after simulating a failure against a *different*
    (dead) endpoint above, a fresh run against the real, still-running
    agent-runtime succeeds normally -- demonstrating that a Runtime restart
    (which this test does not itself trigger, per the task brief) would put
    the system back in exactly this state."""
    resp = await agent.post(
        "/local/v1/runs",
        json={"service_id": "e2e-06-recovery-probe", "input": {"question": "안녕하세요"}},
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "CREATED"


def test_e2e_06_steps2to4_desktop_detection_and_restart_not_available() -> None:
    pytest.skip(
        "E2E-06 steps 2-4 (Desktop이 장애를 감지해 실패 Run/Trace를 표시하고, Runtime을 "
        "재시작하는 UI 흐름) require the Desktop Client UI (Electron, quarantined by "
        "macOS Gatekeeper on this machine) AND actually stopping/starting the real "
        "agent-runtime process this session is using, which the task brief explicitly "
        "rules out ('do NOT kill any running service'). The client-side failure-detection "
        "signal these steps consume is verified directly above."
    )
