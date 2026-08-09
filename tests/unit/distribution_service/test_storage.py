"""Unit tests for the §4.1 File System Storage Adapter (M03).

The security control under test: nothing derived from a caller-supplied
string can ever escape the adapter's root directory or land in a path built
from a non-UUID object_id (`storage.py` module docstring). These tests run
entirely against a `tmp_path` fixture tree, never the running services'
storage.
"""

from __future__ import annotations

import uuid

import pytest
from distribution_service.storage import (
    FileSystemStorageAdapter,
    PackagePathUnsafeError,
    safe_join,
)


@pytest.fixture
def adapter(tmp_path):
    return FileSystemStorageAdapter(tmp_path / "bundles")


def test_put_then_get_roundtrips(adapter):
    object_id = str(uuid.uuid4())
    stored = adapter.put(b"hello world", object_id=object_id, original_file_name="report.pdf")

    assert stored.object_id == object_id
    assert stored.size_bytes == len(b"hello world")
    assert adapter.get(object_id) == b"hello world"


def test_head_returns_metadata_without_reading_payload(adapter):
    object_id = str(uuid.uuid4())
    adapter.put(b"payload", object_id=object_id, original_file_name="secret-name.txt")

    meta = adapter.head(object_id)

    assert meta is not None
    assert meta.original_file_name == "secret-name.txt"
    assert meta.size_bytes == len(b"payload")


def test_head_missing_object_returns_none(adapter):
    assert adapter.head(str(uuid.uuid4())) is None


def test_verify_detects_match_and_mismatch(adapter):
    object_id = str(uuid.uuid4())
    stored = adapter.put(b"content", object_id=object_id)

    assert adapter.verify(object_id, stored.sha256) is True
    assert adapter.verify(object_id, "0" * 64) is False


def test_delete_unreferenced_removes_directory(adapter):
    object_id = str(uuid.uuid4())
    adapter.put(b"content", object_id=object_id)

    assert adapter.delete_unreferenced(object_id) is True
    assert adapter.head(object_id) is None
    # Idempotent: deleting again is a no-op, not an error.
    assert adapter.delete_unreferenced(object_id) is False


@pytest.mark.parametrize(
    "bad_object_id",
    [
        "../../etc/passwd",
        "../../../root",
        "not-a-uuid",
        "",
        "/etc/passwd",
        "..",
    ],
)
def test_put_rejects_non_uuid_object_id(adapter, bad_object_id):
    with pytest.raises(PackagePathUnsafeError):
        adapter.put(b"data", object_id=bad_object_id)


def test_get_rejects_traversal_object_id(adapter):
    with pytest.raises(PackagePathUnsafeError):
        adapter.get("../../etc/passwd")


def test_head_swallows_traversal_object_id_as_missing(adapter):
    # head() is a lookup, not a mutation — an attacker-shaped id should read
    # back as "nothing there", not raise and potentially leak a stack trace.
    assert adapter.head("../../etc/passwd") is None


class TestSafeJoin:
    def test_allows_nested_relative_path(self, tmp_path):
        result = safe_join(tmp_path, "sub", "dir", "file.txt")
        assert result == (tmp_path / "sub" / "dir" / "file.txt").resolve()

    @pytest.mark.parametrize(
        "parts",
        [
            ("..",),
            ("..", "etc", "passwd"),
            ("sub", "..", "..", "etc"),
            ("/etc/passwd",),
            ("",),
        ],
    )
    def test_rejects_traversal_and_absolute_and_empty(self, tmp_path, parts):
        with pytest.raises(PackagePathUnsafeError):
            safe_join(tmp_path, *parts)

    def test_rejects_symlink_escape(self, tmp_path):
        base = tmp_path / "base"
        base.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("top secret")

        escape_link = base / "escape"
        escape_link.symlink_to(outside)

        with pytest.raises(PackagePathUnsafeError):
            safe_join(base, "escape", "secret.txt")
