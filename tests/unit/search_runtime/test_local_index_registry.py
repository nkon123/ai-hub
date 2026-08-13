"""D-079: registration of Knowledge indexes installed outside INDEX_BASE.

Every test here builds a real directory tree on a tmp_path and drives the
real `LocalIndexRegistry` — the validations under test are filesystem
decisions (containment after symlink resolution, which artifact files are
present, what the index's own metadata claims), so faking the filesystem
would fake away the thing being tested. No Ollama/Chroma is touched.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from search_runtime.errors import ErrorCode
from search_runtime.local_index_registry import LocalIndexError, LocalIndexRegistry

KNOWLEDGE_ID = "d9e660b7-ca76-4f46-899e-2e1621bac139"
OTHER_KNOWLEDGE_ID = "11111111-1111-4111-8111-111111111111"
SOURCE = "DESKTOP_OFFLINE_BUNDLE"


def make_index_dir(
    parent: Path,
    knowledge_id: str = KNOWLEDGE_ID,
    *,
    bm25: str | None = "bm25.json",
    with_meta: bool = True,
    meta_knowledge_id: str | None = None,
    with_chroma: bool = True,
) -> Path:
    """Builds an installed-Knowledge index directory in the same shape
    `services/indexing-runtime` writes and the Offline Bundle copies verbatim."""
    index_dir = parent / knowledge_id / "index"
    index_dir.mkdir(parents=True, exist_ok=True)
    if with_meta:
        (index_dir / "index-meta.json").write_text(
            json.dumps({"knowledge_id": meta_knowledge_id or knowledge_id, "embed_model": "m"}),
            encoding="utf-8",
        )
    if bm25:
        (index_dir / bm25).write_text("{}", encoding="utf-8")
    if with_chroma:
        (index_dir / "chroma").mkdir(exist_ok=True)
    return index_dir


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    """(allowed install root, central INDEX_BASE) — deliberately siblings, so
    a test can put the same knowledge_id in both."""
    installed = tmp_path / "installed"
    central = tmp_path / "central"
    installed.mkdir()
    central.mkdir()
    return installed, central


def make_registry(tmp_path: Path, installed: Path, central: Path) -> LocalIndexRegistry:
    return LocalIndexRegistry(
        registry_path=tmp_path / "state" / "local-indexes.json",
        allowed_roots=(str(installed),),
        central_index_base=central,
    )


def expect_refusal(fn, reason: str, code: ErrorCode = ErrorCode.VALIDATION_ERROR) -> None:
    with pytest.raises(LocalIndexError) as exc:
        fn()
    assert exc.value.reason == reason
    assert exc.value.code == code
    # 07-data-api-contracts.md §10.2: no filesystem path in the message.
    assert "/" not in exc.value.message


# --- happy path -------------------------------------------------------------


def test_register_then_resolve_and_list(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)

    entry = registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE, label="재택근무 정책")

    assert entry.knowledge_id == KNOWLEDGE_ID
    assert Path(entry.index_path) == index_dir.resolve()
    assert entry.label == "재택근무 정책"
    assert registry.resolve(KNOWLEDGE_ID) == index_dir.resolve()
    assert [e.knowledge_id for e in registry.list_entries()] == [KNOWLEDGE_ID]


def test_registration_survives_a_new_registry_instance(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """A restart of search-runtime must not silently deactivate a Knowledge."""
    installed, central = roots
    index_dir = make_index_dir(installed)
    make_registry(tmp_path, installed, central).register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    reloaded = make_registry(tmp_path, installed, central)
    assert reloaded.resolve(KNOWLEDGE_ID) == index_dir.resolve()


def test_reregistering_same_id_replaces_the_entry(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """Re-installing the same Knowledge must not need an explicit delete
    first, and must not leave two rows for one id."""
    installed, central = roots
    first = make_index_dir(installed / "a")
    second = make_index_dir(installed / "b")
    registry = make_registry(tmp_path, installed, central)

    registry.register(KNOWLEDGE_ID, str(first), SOURCE)
    registry.register(KNOWLEDGE_ID, str(second), SOURCE)

    assert len(registry.list_entries()) == 1
    assert registry.resolve(KNOWLEDGE_ID) == second.resolve()


def test_unregister_reports_whether_anything_was_removed(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)
    registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    assert registry.unregister(KNOWLEDGE_ID) is True
    assert registry.unregister(KNOWLEDGE_ID) is False
    assert registry.resolve(KNOWLEDGE_ID) is None


def test_unregister_never_deletes_the_installed_files(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """The index belongs to whoever installed it (M04) — deactivation removes
    the registration only."""
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)
    registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    registry.unregister(KNOWLEDGE_ID)

    assert (index_dir / "index-meta.json").is_file()


# --- refusals ---------------------------------------------------------------


def test_disabled_when_no_allowed_root_is_configured(tmp_path: Path) -> None:
    """The default for every existing (central) deployment: registration is
    off, and says so, rather than reaching a new filesystem area."""
    registry = LocalIndexRegistry(
        registry_path=tmp_path / "local-indexes.json",
        allowed_roots=(),
        central_index_base=tmp_path / "central",
    )
    assert registry.enabled is False
    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(tmp_path), SOURCE),
        "local_indexes_disabled",
        ErrorCode.PERMISSION_DENIED,
    )


def test_path_outside_allowed_roots_is_refused(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    installed, central = roots
    outside = make_index_dir(tmp_path / "elsewhere")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(outside), SOURCE),
        "path_outside_allowed_roots",
        ErrorCode.PERMISSION_DENIED,
    )


def test_symlink_inside_allowed_root_pointing_out_is_refused(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """Containment is decided on the resolved path — otherwise a link planted
    inside the install root would hand this service any directory on disk."""
    installed, central = roots
    outside = make_index_dir(tmp_path / "elsewhere")
    link = installed / "linked-index"
    link.symlink_to(outside, target_is_directory=True)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(link), SOURCE),
        "path_outside_allowed_roots",
        ErrorCode.PERMISSION_DENIED,
    )


def test_parent_traversal_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    make_index_dir(tmp_path / "elsewhere")
    traversal = str(installed / ".." / "elsewhere" / KNOWLEDGE_ID / "index")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, traversal, SOURCE),
        "path_outside_allowed_roots",
        ErrorCode.PERMISSION_DENIED,
    )


def test_relative_path_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, "index", SOURCE), "path_not_absolute"
    )


def test_non_uuid_knowledge_id_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    """The id is joined onto a filesystem path by the central lookup; nothing
    that is not an AssetVersion UUID may reach that layer."""
    installed, central = roots
    index_dir = make_index_dir(installed, knowledge_id="../escape")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register("../escape", str(index_dir), SOURCE), "knowledge_id_invalid"
    )


def test_index_meta_knowledge_id_mismatch_is_refused(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """The D-060 class of bug: believing a caller-asserted id over the index's
    own record would answer one Knowledge's questions from another's docs."""
    installed, central = roots
    index_dir = make_index_dir(installed, meta_knowledge_id=OTHER_KNOWLEDGE_ID)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE),
        "index_meta_knowledge_id_mismatch",
    )


def test_missing_index_meta_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed, with_meta=False)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE), "index_meta_missing"
    )


def test_unreadable_index_meta_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed)
    (index_dir / "index-meta.json").write_text("{ not json", encoding="utf-8")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE), "index_meta_unreadable"
    )


def test_legacy_pickle_only_index_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    """D-054: a bm25.pkl travels byte-for-byte inside an Offline Bundle and is
    executable content. Refused here, where the message can tell the user how
    to convert it — never accepted and then silently unsearchable."""
    installed, central = roots
    index_dir = make_index_dir(installed, bm25="bm25.pkl")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE),
        "bm25_legacy_pickle_only",
    )


def test_missing_bm25_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed, bm25=None)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE), "bm25_missing")


def test_missing_chroma_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed, with_chroma=False)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE), "chroma_missing"
    )


def test_file_instead_of_directory_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    a_file = installed / "not-a-dir"
    a_file.write_text("x", encoding="utf-8")
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(a_file), SOURCE), "path_not_a_directory"
    )


def test_unknown_source_is_refused(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), "SOMEWHERE_ELSE"),
        "source_not_allowed",
    )


# --- precedence: a registered index can never shadow the central tree -------


def test_registering_an_id_that_exists_centrally_is_refused(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    installed, central = roots
    (central / KNOWLEDGE_ID).mkdir()
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)

    expect_refusal(
        lambda: registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE), "central_index_exists"
    )


def test_central_index_wins_if_it_appears_after_registration(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """Registration refuses the collision, but indexing-runtime could still
    create the central index afterwards. The central tree must win then too —
    this feature is not allowed to change any locally-built search result."""
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)
    registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    (central / KNOWLEDGE_ID).mkdir()

    assert registry.resolve(KNOWLEDGE_ID) is None


# --- state that changes after registration ----------------------------------


def test_deleted_directory_drops_out_of_resolve_and_list(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """The user can uninstall the asset without telling search-runtime. A
    stale row must not be reported as an active activation."""
    import shutil

    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)
    registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    shutil.rmtree(index_dir)

    assert registry.resolve(KNOWLEDGE_ID) is None
    assert registry.list_entries() == []


def test_narrowing_allowed_roots_deactivates_existing_entries(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """An operator revoking a root takes effect immediately, not at the next
    registration."""
    installed, central = roots
    index_dir = make_index_dir(installed)
    make_registry(tmp_path, installed, central).register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    narrowed = LocalIndexRegistry(
        registry_path=tmp_path / "state" / "local-indexes.json",
        allowed_roots=(str(tmp_path / "somewhere-else"),),
        central_index_base=central,
    )

    assert narrowed.resolve(KNOWLEDGE_ID) is None
    assert narrowed.list_entries() == []


def test_corrupted_registry_file_reads_as_empty(tmp_path: Path, roots: tuple[Path, Path]) -> None:
    """Desktop's own state stores take the same stance: a damaged state file
    must not crash the service."""
    installed, central = roots
    registry_path = tmp_path / "state" / "local-indexes.json"
    registry_path.parent.mkdir(parents=True)
    registry_path.write_text("{ not a list", encoding="utf-8")

    registry = LocalIndexRegistry(
        registry_path=registry_path, allowed_roots=(str(installed),), central_index_base=central
    )

    assert registry.list_entries() == []
    assert registry.resolve(KNOWLEDGE_ID) is None


def test_external_change_to_the_registry_file_is_picked_up(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    """`resolve()` memoizes the parsed file on an (mtime, size) key because it
    runs on every query. The memo must not outlive a change made by another
    process (or another registry instance in the same process)."""
    installed, central = roots
    first = make_index_dir(installed / "a")
    second = make_index_dir(installed / "b", knowledge_id=OTHER_KNOWLEDGE_ID)
    reader = make_registry(tmp_path, installed, central)
    writer = make_registry(tmp_path, installed, central)

    writer.register(KNOWLEDGE_ID, str(first), SOURCE)
    assert reader.resolve(KNOWLEDGE_ID) == first.resolve()

    writer.register(OTHER_KNOWLEDGE_ID, str(second), SOURCE)
    assert reader.resolve(OTHER_KNOWLEDGE_ID) == second.resolve()

    writer.unregister(KNOWLEDGE_ID)
    assert reader.resolve(KNOWLEDGE_ID) is None


def test_one_malformed_row_does_not_hide_the_others(
    tmp_path: Path, roots: tuple[Path, Path]
) -> None:
    installed, central = roots
    index_dir = make_index_dir(installed)
    registry = make_registry(tmp_path, installed, central)
    registry.register(KNOWLEDGE_ID, str(index_dir), SOURCE)

    registry_path = tmp_path / "state" / "local-indexes.json"
    rows = json.loads(registry_path.read_text(encoding="utf-8"))
    registry_path.write_text(json.dumps([{"garbage": True}, *rows]), encoding="utf-8")

    assert [e.knowledge_id for e in registry.list_entries()] == [KNOWLEDGE_ID]
