"""Anti-rot test for the P05 asset registration wizard's per-type examples.

`apps/portal-web/app/assets/new/[type]/examples/route.ts` shows CREATOR users
a real, working example manifest for `agent` / `prompt` / `mcp_tool` (real
user feedback: "어떤 파일을 등록하라는건지 모르겠다" — see
docs/implementation-spec/progress-log.md M01 session history). That route
reads real manifest files verbatim and only ever (a) swaps `id` for a fresh
UUID and (b) drops the optional `manifest_hash`/`created_at` placeholders —
see `fixtures/wizard-examples-index.json` for the single source-of-truth
mapping both that route and this test read. A type maps to a *list* of
examples (an MCP server reached over HTTP and one launched on the user's own
PC share a schema but almost no fields), and the paths in it are relative to
the **repository root** so an example can point straight at a sample project
under `samples/**` instead of a copy that drifts from it.

This test mirrors that exact transform in Python and asserts the result
still validates against `packages/schemas`. If a schema changes underneath
the wizard's example in a way that breaks it, this test fails loudly instead
of the wizard silently teaching users a wrong shape.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from ai_asset_schemas.validator import SchemaType, validate

from .conftest import FIXTURES_ROOT

REPO_ROOT = FIXTURES_ROOT.parent
INDEX_PATH = FIXTURES_ROOT / "wizard-examples-index.json"

_SCHEMA_TYPE_BY_WIZARD_TYPE = {
    "agent": SchemaType.AGENT,
    "prompt": SchemaType.PROMPT,
    "mcp_tool": SchemaType.MCP_TOOL,
    "mcp_server": SchemaType.MCP_SERVER,
}


# `encoding="utf-8"` 은 생략할 수 없다 — 한국어 Windows 의 기본 인코딩은
# cp949 라서, 지정하지 않으면 한글이 든 이 JSON 들을 읽다가
# `UnicodeDecodeError` 로 죽는다(이 환경에서 실제로 죽고 있었다).
def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_index() -> dict[str, list[dict[str, Any]]]:
    data = _read_json(INDEX_PATH)
    return {k: v for k, v in data.items() if not k.startswith("$")}


def _example_ids() -> list[tuple[str, int]]:
    """(wizard_type, 목록 내 위치) — 예시가 여럿인 유형도 하나씩 따로 본다."""
    return [
        (wizard_type, i)
        for wizard_type in sorted(_INDEX)
        for i in range(len(_INDEX[wizard_type]))
    ]


def _apply_wizard_transform(manifest: dict[str, Any]) -> dict[str, Any]:
    """Same transform as the route handler: fresh id, drop computed fields."""
    transformed = dict(manifest)
    transformed["id"] = str(uuid.uuid4())
    transformed.pop("manifest_hash", None)
    transformed.pop("created_at", None)
    return transformed


_INDEX = _load_index()


@pytest.mark.parametrize(
    ("wizard_type", "position"), _example_ids(), ids=[f"{t}-{i}" for t, i in _example_ids()]
)
def test_wizard_example_manifest_validates(wizard_type: str, position: int) -> None:
    entry = _INDEX[wizard_type][position]
    manifest = _read_json(REPO_ROOT / entry["manifest"])

    example = _apply_wizard_transform(manifest)

    schema_type = _SCHEMA_TYPE_BY_WIZARD_TYPE[wizard_type]
    validate(example, schema_type)  # must not raise


@pytest.mark.parametrize(
    ("wizard_type", "position"), _example_ids(), ids=[f"{t}-{i}" for t, i in _example_ids()]
)
def test_wizard_example_declares_what_the_screen_shows(wizard_type: str, position: int) -> None:
    """화면이 예시를 고르게 하려면 고를 근거(이름·설명)가 있어야 한다."""
    entry = _INDEX[wizard_type][position]
    for field in ("id", "label", "summary", "sourceFixture"):
        assert entry.get(field, "").strip(), f"{wizard_type}[{position}] 의 {field} 가 비어 있다"


@pytest.mark.parametrize("wizard_type", sorted(_INDEX), ids=sorted(_INDEX))
def test_wizard_example_ids_are_unique_within_a_type(wizard_type: str) -> None:
    """`id` 는 화면에서 React key 이자 '내용 보기' 대상 식별자다."""
    ids = [entry["id"] for entry in _INDEX[wizard_type]]
    assert len(ids) == len(set(ids)), f"{wizard_type} 예시 id 가 중복됐다: {ids}"


@pytest.mark.parametrize(
    ("wizard_type", "position"), _example_ids(), ids=[f"{t}-{i}" for t, i in _example_ids()]
)
def test_wizard_example_companion_files_exist(wizard_type: str, position: int) -> None:
    entry = _INDEX[wizard_type][position]
    for rel_path in entry["companionFiles"]:
        companion = REPO_ROOT / rel_path
        assert companion.is_file(), f"missing companion file for {wizard_type}: {rel_path}"
        assert companion.read_text(encoding="utf-8").strip(), (
            f"companion file for {wizard_type} is empty: {rel_path}"
        )


def test_prompt_example_template_file_matches_companion() -> None:
    """The prompt example's `template.file` must name the file we offer for download."""
    for entry in _INDEX["prompt"]:
        manifest = _read_json(REPO_ROOT / entry["manifest"])

        expected_name = manifest["template"]["file"]
        companion_names = [Path(p).name for p in entry["companionFiles"]]
        assert expected_name in companion_names, (
            f"prompt example's template.file={expected_name!r} has no matching "
            f"companion file in {companion_names}"
        )
