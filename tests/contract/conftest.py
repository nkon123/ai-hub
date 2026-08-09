"""Contract test fixtures and helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES_ROOT = Path(__file__).parent.parent.parent / "fixtures"
VALID_DIR = FIXTURES_ROOT / "valid"
INVALID_DIR = FIXTURES_ROOT / "invalid"
SCHEMAS_ROOT = Path(__file__).parent.parent.parent / "packages" / "schemas"
API_DIR = SCHEMAS_ROOT / "api"


def collect_json_fixtures(directory: Path) -> list[Path]:
    return sorted(directory.rglob("*.json"))


@pytest.fixture
def valid_fixtures() -> list[Path]:
    return collect_json_fixtures(VALID_DIR)


@pytest.fixture
def invalid_fixtures() -> list[Path]:
    return collect_json_fixtures(INVALID_DIR)
