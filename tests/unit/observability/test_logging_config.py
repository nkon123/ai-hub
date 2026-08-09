"""Unit tests for `observability.logging_config` — the structured formatter
that makes `grep <trace_id>` work across every service's log file (README
§15 step 12 / NFR-04).

`configure_logging()` mutates the *global* root logger, so every test here
saves and restores the root logger's handlers/level to avoid leaking state
into other tests in the suite (pytest's own log capture also depends on the
root logger, so this isolation matters beyond just this file).
"""

from __future__ import annotations

import logging

import pytest
from observability.context import bind_run_id, bind_trace_id, reset_run_id, reset_trace_id
from observability.logging_config import TraceContextFilter, configure_logging


@pytest.fixture
def isolated_root_logger():
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    try:
        yield root
    finally:
        root.handlers = saved_handlers
        root.setLevel(saved_level)


class TestTraceContextFilter:
    def _make_record(self, msg: str = "hello") -> logging.LogRecord:
        return logging.LogRecord(
            name="some.logger", level=logging.INFO, pathname=__file__, lineno=1,
            msg=msg, args=(), exc_info=None,
        )

    def test_fills_defaults_when_context_unbound(self) -> None:
        record = self._make_record()
        filt = TraceContextFilter("test-service")

        assert filt.filter(record) is True

        assert record.service == "test-service"  # type: ignore[attr-defined]
        assert record.trace_id == "-"  # type: ignore[attr-defined]
        assert record.run_id == "-"  # type: ignore[attr-defined]

    def test_picks_up_ambient_trace_and_run_id(self) -> None:
        trace_token = bind_trace_id("trace-xyz")
        run_token = bind_run_id("run-abc")
        try:
            record = self._make_record()
            filt = TraceContextFilter("test-service")
            filt.filter(record)
            assert record.trace_id == "trace-xyz"  # type: ignore[attr-defined]
            assert record.run_id == "run-abc"  # type: ignore[attr-defined]
        finally:
            reset_trace_id(trace_token)
            reset_run_id(run_token)

    def test_explicit_extra_wins_over_ambient_context(self) -> None:
        """A caller that passes `extra={"trace_id": "..."}` explicitly is
        deliberately logging about a *different* run than the one currently
        bound (e.g. a supervisory loop) — the filter must not clobber it."""
        trace_token = bind_trace_id("ambient-trace")
        try:
            record = self._make_record()
            record.trace_id = "explicit-trace"  # simulates extra={"trace_id": ...}
            filt = TraceContextFilter("test-service")
            filt.filter(record)
            assert record.trace_id == "explicit-trace"  # type: ignore[attr-defined]
        finally:
            reset_trace_id(trace_token)


class TestConfigureLogging:
    def test_installs_exactly_one_handler_on_root_logger(self, isolated_root_logger) -> None:
        configure_logging("test-service", level="INFO")
        assert len(isolated_root_logger.handlers) == 1
        assert isolated_root_logger.level == logging.INFO

    def test_is_idempotent_not_cumulative(self, isolated_root_logger) -> None:
        configure_logging("test-service")
        configure_logging("test-service")
        configure_logging("test-service")
        assert len(isolated_root_logger.handlers) == 1

    def test_unknown_level_name_falls_back_to_info(self, isolated_root_logger) -> None:
        configure_logging("test-service", level="NOT_A_REAL_LEVEL")
        assert isolated_root_logger.level == logging.INFO

    def test_emitted_line_is_structured_and_greppable_by_trace_id(
        self, isolated_root_logger, capsys
    ) -> None:
        configure_logging("test-service", level="INFO")
        trace_token = bind_trace_id("trace-acceptance-999")
        run_token = bind_run_id("run-42")
        try:
            logging.getLogger("some.module").info("something happened")
        finally:
            reset_trace_id(trace_token)
            reset_run_id(run_token)

        captured = capsys.readouterr().out
        assert "trace_id=trace-acceptance-999" in captured
        assert "run_id=run-42" in captured
        assert "service=test-service" in captured
        assert "logger=some.module" in captured
        assert "something happened" in captured

    def test_emitted_line_uses_dash_placeholder_without_bound_trace_id(
        self, isolated_root_logger, capsys
    ) -> None:
        configure_logging("test-service", level="INFO")
        logging.getLogger("some.module").info("no trace bound")

        captured = capsys.readouterr().out
        assert "trace_id=-" in captured
        assert "run_id=-" in captured

    def test_below_level_records_are_not_emitted(self, isolated_root_logger, capsys) -> None:
        configure_logging("test-service", level="WARNING")
        logging.getLogger("some.module").info("should not appear")
        logging.getLogger("some.module").warning("should appear")

        captured = capsys.readouterr().out
        assert "should not appear" not in captured
        assert "should appear" in captured
