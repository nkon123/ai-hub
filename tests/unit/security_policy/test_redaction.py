"""Secret-shape detection (security_policy.redaction) — backs P15 관리자
설정's "실제 Secret 값은 화면에서 재표시하지 않는다" rule
(01-portal-and-distribution.md §2 P15). See module docstring in
`packages/security-policy/src/security_policy/redaction.py` for why this
helper lives here instead of reusing `knowledge_packager.scanner`."""

from __future__ import annotations

import pytest
from security_policy import looks_like_secret, redact_if_secret


class TestLooksLikeSecret:
    @pytest.mark.parametrize(
        "value",
        [
            "-----BEGIN RSA PRIVATE KEY-----",
            "Authorization: Bearer sk-abcdEFGH12345678",
            'api_key="sk-live-abcdefghijklmnop"',
            "password=SuperSecret123",
            "token: ghp_abcdefghijklmnopqrstuvwxyz012345",
            "https://svc-user:hunter2pass@internal.miracom.local:8500",
        ],
    )
    def test_flags_known_secret_shapes(self, value: str) -> None:
        assert looks_like_secret(value) is True

    @pytest.mark.parametrize(
        "value",
        [
            "http://127.0.0.1:11434",
            "exaone3.5:7.8b",
            "ollama",
            "headquarters",
            "miracom-default",
            "http://127.0.0.1:8500/oracle-connector",
        ],
    )
    def test_does_not_flag_plain_config_values(self, value: str) -> None:
        assert looks_like_secret(value) is False


class TestRedactIfSecret:
    def test_secret_shaped_value_is_replaced(self) -> None:
        assert redact_if_secret("password=hunter2pass") == "***REDACTED***"

    def test_plain_value_passes_through_unchanged(self) -> None:
        assert redact_if_secret("http://127.0.0.1:11434") == "http://127.0.0.1:11434"

    def test_custom_placeholder(self) -> None:
        assert redact_if_secret("password=hunter2pass", placeholder="<hidden>") == "<hidden>"
