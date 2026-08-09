"""Storage Adapter — M03, `01-portal-and-distribution.md` §4.1.

Required interface: `put/get/head/delete_unreferenced/verify`. PoC File
System Adapter hard rules enforced here:

  - 사용자 입력 파일명을 실제 저장 경로로 사용하지 않는다: `put()` takes no
    caller-supplied filename for the on-disk path — objects live at
    `root/{object_id}/payload.bin`, where `object_id` must itself be a UUID
    (rejects anything else, so a malicious "object_id" can never smuggle a
    path). The caller's `original_file_name` is stored only inside a JSON
    metadata sidecar, never used to build a path.
  - `object_id` 기반 디렉터리에 저장한다.
  - Path Traversal을 차단한다: `safe_join()` is the single chokepoint used
    by every path computation in this module (and reused by bundler.py for
    every path derived from asset/knowledge ids or manifest-declared
    strings). It rejects `..`, absolute segments, and any resolved path
    that would land outside the given base directory (including via
    symlinks, since it resolves before the containment check).
  - 임시 Upload는 검증 성공 후 원자적으로 확정한다: `put()` writes to a
    temp file in the same directory and `os.replace()`s it into place.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class PackagePathUnsafeError(Exception):
    """Maps 1:1 to the central `PACKAGE_PATH_UNSAFE` error code
    (07-data-api-contracts.md §8). Never a bare `ValueError`/`OSError` so
    callers can distinguish "malicious/malformed path" from "disk full"
    etc. and report the correct code."""

    def __init__(self, offending: str, reason: str) -> None:
        self.offending = offending
        self.reason = reason
        super().__init__(f"Unsafe path {offending!r}: {reason}")


def safe_join(base: Path, *parts: str) -> Path:
    """Join `parts` onto `base`, refusing to leave `base`.

    This is the one function every path computation involving an
    externally-influenced string (asset id, version, manifest-declared file
    name, uploaded file name) must go through. Rejects:
      - empty segments
      - absolute segments (POSIX or Windows drive-letter style)
      - `..` traversal segments (checked before resolution)
      - any final resolved path that is not a descendant of `base`
        (defends against symlink escape — the check happens after
        `Path.resolve()`, which follows symlinks)
    """
    resolved_base = base.resolve()
    candidate = resolved_base
    for part in parts:
        text = str(part) if part is not None else ""
        if not text.strip():
            raise PackagePathUnsafeError(text, "빈 경로 조각은 허용되지 않습니다.")
        normalized = text.replace("\\", "/")
        posix = PurePosixPath(normalized)
        if posix.is_absolute() or normalized.startswith("/"):
            raise PackagePathUnsafeError(text, "절대 경로는 허용되지 않습니다.")
        if len(posix.drive) > 0:  # e.g. "C:/..." on Windows-authored input
            raise PackagePathUnsafeError(text, "드라이브 경로는 허용되지 않습니다.")
        if any(seg in ("..", "") for seg in posix.parts):
            raise PackagePathUnsafeError(text, "상위 경로 이동(..)은 허용되지 않습니다.")
        candidate = candidate / posix
    resolved = candidate.resolve()
    try:
        resolved.relative_to(resolved_base)
    except ValueError as exc:
        raise PackagePathUnsafeError(
            "/".join(str(p) for p in parts), "기준 디렉터리를 벗어난 경로입니다."
        ) from exc
    return resolved


def _sanitize_object_id(object_id: str) -> str:
    """Only ever accept UUID-shaped object ids for the top-level storage
    directory — this is stronger than `safe_join`'s general traversal check
    and is the concrete "object_id 기반 디렉터리" rule: nothing derived from
    a user-supplied filename or asset name can ever become a directory
    name here."""
    try:
        return str(uuid.UUID(str(object_id)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise PackagePathUnsafeError(str(object_id), "object_id는 UUID여야 합니다.") from exc


@dataclass(frozen=True)
class StoredObject:
    object_id: str
    sha256: str
    size_bytes: int
    original_file_name: str | None = None


class StorageAdapter(ABC):
    """§4.1 interface. Kept framework-free and file-format-free so a future
    Object Storage adapter (D-003 운영 전 결정) can implement the same
    surface without touching callers."""

    @abstractmethod
    def put(
        self, data: bytes, *, object_id: str, original_file_name: str | None = None
    ) -> StoredObject: ...

    @abstractmethod
    def get(self, object_id: str) -> bytes: ...

    @abstractmethod
    def head(self, object_id: str) -> StoredObject | None: ...

    @abstractmethod
    def delete_unreferenced(self, object_id: str) -> bool: ...

    @abstractmethod
    def verify(self, object_id: str, expected_hash: str) -> bool: ...


class FileSystemStorageAdapter(StorageAdapter):
    """PoC adapter — `01-portal-and-distribution.md` §4.1. Layout:

        root/{object_id}/payload.bin
        root/{object_id}/metadata.json   # {"original_file_name", "sha256", "size_bytes"}
    """

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _object_dir(self, object_id: str) -> Path:
        safe_id = _sanitize_object_id(object_id)
        return safe_join(self._root, safe_id)

    def put(
        self, data: bytes, *, object_id: str, original_file_name: str | None = None
    ) -> StoredObject:
        object_dir = self._object_dir(object_id)
        object_dir.mkdir(parents=True, exist_ok=True)
        sha256 = hashlib.sha256(data).hexdigest()

        # Atomic confirm: write to a temp file in the same directory, then
        # os.replace() into place — a crash mid-write never leaves a
        # half-written payload.bin visible to readers.
        fd, tmp_path = tempfile.mkstemp(dir=object_dir, prefix=".upload-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            final_path = object_dir / "payload.bin"
            os.replace(tmp_path, final_path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        stored = StoredObject(
            object_id=str(uuid.UUID(str(object_id))),
            sha256=sha256,
            size_bytes=len(data),
            original_file_name=original_file_name,
        )
        (object_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "original_file_name": stored.original_file_name,
                    "sha256": stored.sha256,
                    "size_bytes": stored.size_bytes,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return stored

    def get(self, object_id: str) -> bytes:
        payload_path = safe_join(self._object_dir(object_id), "payload.bin")
        if not payload_path.is_file():
            raise FileNotFoundError(f"No stored object for id {object_id}")
        return payload_path.read_bytes()

    def head(self, object_id: str) -> StoredObject | None:
        try:
            object_dir = self._object_dir(object_id)
        except PackagePathUnsafeError:
            return None
        meta_path = object_dir / "metadata.json"
        if not meta_path.is_file():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return StoredObject(
            object_id=str(uuid.UUID(str(object_id))),
            sha256=meta["sha256"],
            size_bytes=meta["size_bytes"],
            original_file_name=meta.get("original_file_name"),
        )

    def delete_unreferenced(self, object_id: str) -> bool:
        try:
            object_dir = self._object_dir(object_id)
        except PackagePathUnsafeError:
            return False
        if not object_dir.is_dir():
            return False
        shutil.rmtree(object_dir)
        return True

    def verify(self, object_id: str, expected_hash: str) -> bool:
        try:
            data = self.get(object_id)
        except FileNotFoundError:
            return False
        return hashlib.sha256(data).hexdigest() == expected_hash

    def object_path(self, object_id: str) -> Path:
        """Non-interface convenience for callers (e.g. the bundle job
        endpoint) that need the on-disk path to stream directly rather than
        loading the whole payload into memory via `get()`."""
        return safe_join(self._object_dir(object_id), "payload.bin")
