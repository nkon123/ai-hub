"""D-079: registration table for Knowledge indexes installed *outside* this
service's own `INDEX_BASE` tree.

The gap this closes. Until now `hybrid_search` resolved exactly one directory
per Knowledge — `INDEX_BASE/<knowledge_id>/` — and `INDEX_BASE` is written
only by `services/indexing-runtime` (M07) on the machine that built the index.
A Knowledge that instead arrived as an Offline Bundle and was installed by the
Desktop Client (M04) lands under that app's per-user install root, which this
service has never looked at. The result was a Knowledge that had passed the
whole 15-step Bundle verification, showed as "설치됨", and still returned zero
citations forever — indistinguishable, from the user's seat, from a Knowledge
that simply had no relevant content.

Why a registry and not "just also look under the Desktop install root":

1. Module boundary (CLAUDE.md 구현 원칙 2). M04 must not write into M08's
   tree and M08 must not go hunting through M04's. The installer names a
   directory over a public API; this service decides whether to accept it.
2. Explicit refusals. Every reason a directory cannot be searched is returned
   at *registration* time, where a human is watching, instead of degrading
   into an empty result set at query time. "설치됨" and "활성화됨" become two
   different, separately visible facts.
3. Trust asymmetry. Content that travelled over a distribution channel is not
   the same trust class as content this deployment's own indexing-runtime
   built locally. D-054 already documented that a `bm25.pkl` (executable
   pickle) can travel byte-for-byte inside a Bundle; registration refuses such
   an index outright, and `hybrid_search` additionally forces
   `allow_legacy_pickle=False` for every registered path regardless of the
   deployment-wide `ALLOW_LEGACY_PICKLE_BM25` default.

Precedence rule, chosen to make this change unable to alter any existing
behavior: a `knowledge_id` that exists under `INDEX_BASE` always resolves to
`INDEX_BASE`, and registering such an id is refused (`central_index_exists`).
A registered directory can therefore never shadow locally-built content — the
only ids it can serve are ids this service could not serve at all before.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from search_runtime import settings
from search_runtime.bm25_store import BM25_JSON_FILENAME, BM25_PICKLE_FILENAME
from search_runtime.errors import ErrorCode

_logger = logging.getLogger("search_runtime")

# `knowledge_id` is an AssetVersion UUID (07-data-api-contracts.md §1). Pinned
# to that shape here and not merely "a safe filename" because this value is
# joined onto a filesystem path: anything that is not a UUID has no business
# reaching the path layer at all.
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE
)

INDEX_META_FILENAME = "index-meta.json"
CHROMA_DIRNAME = "chroma"

ALLOWED_SOURCES = frozenset({"DESKTOP_OFFLINE_BUNDLE"})

MAX_LABEL_LENGTH = 200


class LocalIndexError(Exception):
    """A registration/validation refusal, carrying the central error code and
    a machine-readable `reason` for the Error Envelope's `details`.

    `message` is Korean and user-facing; it deliberately never contains the
    candidate filesystem path (07-data-api-contracts.md §10.2: "Message must
    never contain a stack trace or internal path"). The path the caller sent
    is echoed back only on success, in the entry itself."""

    def __init__(self, code: ErrorCode, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.message = message

    @property
    def details(self) -> dict[str, str]:
        return {"reason": self.reason}


@dataclass(frozen=True)
class LocalIndexEntry:
    knowledge_id: str
    index_path: str
    source: str
    label: str | None
    registered_at: str

    def to_dict(self) -> dict:
        return {
            "knowledge_id": self.knowledge_id,
            "index_path": self.index_path,
            "source": self.source,
            "label": self.label,
            "registered_at": self.registered_at,
        }

    @staticmethod
    def from_dict(raw: object) -> LocalIndexEntry | None:
        """Parses one persisted row, returning None for anything malformed —
        one unreadable row must not take the whole registry (and with it every
        other activated Knowledge) down with it."""
        if not isinstance(raw, dict):
            return None
        knowledge_id = raw.get("knowledge_id")
        index_path = raw.get("index_path")
        source = raw.get("source")
        registered_at = raw.get("registered_at")
        if not (
            isinstance(knowledge_id, str)
            and isinstance(index_path, str)
            and isinstance(source, str)
            and isinstance(registered_at, str)
        ):
            return None
        label = raw.get("label")
        return LocalIndexEntry(
            knowledge_id=knowledge_id,
            index_path=index_path,
            source=source,
            label=label if isinstance(label, str) else None,
            registered_at=registered_at,
        )


def _resolved_allowed_roots(allowed_roots: tuple[str, ...]) -> list[Path]:
    roots: list[Path] = []
    for raw in allowed_roots:
        try:
            roots.append(Path(raw).expanduser().resolve())
        except OSError:
            # An unreachable configured root is not fatal — the remaining
            # roots still apply, and a candidate path under this one simply
            # fails containment below.
            _logger.warning("search.local_index.allowed_root_unresolvable")
    return roots


def _is_contained(candidate: Path, roots: list[Path]) -> bool:
    """True when `candidate` is one of `roots` or lives beneath one.

    Both sides are already `resolve()`d by the callers, which is the whole
    point: containment is decided on real paths, so neither `..` segments nor
    a symlink planted inside an allowed root can point the service at a
    directory the operator did not allow."""
    for root in roots:
        if candidate == root or root in candidate.parents:
            return True
    return False


class LocalIndexRegistry:
    """Persistent registration table. One instance per process (see
    `get_registry`); every mutation rewrites the whole JSON file under a lock,
    which is ample for a table that changes only when a user installs or
    removes a Knowledge."""

    def __init__(
        self,
        registry_path: str | os.PathLike[str],
        allowed_roots: tuple[str, ...],
        central_index_base: str | os.PathLike[str],
    ) -> None:
        self._registry_path = Path(registry_path)
        self._allowed_roots = _resolved_allowed_roots(tuple(allowed_roots))
        self._central_index_base = Path(central_index_base)
        self._lock = threading.Lock()
        # Freshness-keyed memo of the parsed file, same (mtime, size) design
        # `bm25_cache` uses and for the same reason: `resolve()` runs on every
        # search query once this feature is enabled, and re-reading plus
        # re-parsing a JSON file per query is exactly the per-query cost D-054
        # and D-067 were about. Bounded by construction — one file, one entry.
        self._cache: tuple[tuple[int, int], list[LocalIndexEntry]] | None = None

    @property
    def enabled(self) -> bool:
        """False when no allowed root is configured — registration is off for
        this deployment (the default, see `settings.LOCAL_INDEX_ROOTS`)."""
        return len(self._allowed_roots) > 0

    # -- persistence --------------------------------------------------------

    def _read_all(self) -> list[LocalIndexEntry]:
        try:
            stat = self._registry_path.stat()
        except OSError:
            # Includes "not created yet" — the normal state before the first
            # activation on a machine.
            return []
        key = (stat.st_mtime_ns, stat.st_size)
        cached = self._cache
        if cached is not None and cached[0] == key:
            return cached[1]
        try:
            raw = json.loads(self._registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Same fail-soft stance the Desktop store takes for its own state
            # file: a corrupted registry reads as "nothing activated", which
            # the caller-side activation state surfaces honestly, rather than
            # crashing the search service on startup.
            _logger.error("search.local_index.registry_unreadable")
            return []
        if not isinstance(raw, list):
            _logger.error("search.local_index.registry_malformed")
            return []
        entries = [entry for entry in (LocalIndexEntry.from_dict(row) for row in raw) if entry]
        self._cache = (key, entries)
        return entries

    def _write_all(self, entries: list[LocalIndexEntry]) -> None:
        # Dropped rather than updated: the next read re-derives the freshness
        # key from the file we are about to write, so the cache can never
        # claim a state the file does not have.
        self._cache = None
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(
            json.dumps([e.to_dict() for e in entries], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # -- validation ---------------------------------------------------------

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise LocalIndexError(
                ErrorCode.PERMISSION_DENIED,
                "local_indexes_disabled",
                "이 배포는 외부에 설치된 Knowledge 색인 등록을 허용하지 않습니다 "
                "(SEARCH_LOCAL_INDEX_ROOTS 미설정).",
            )

    def _validated_path(self, knowledge_id: str, index_path: str) -> Path:
        """Full registration-time validation. Returns the resolved directory,
        or raises `LocalIndexError` naming exactly one refusal reason."""
        self._require_enabled()

        if not _UUID_PATTERN.match(knowledge_id):
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "knowledge_id_invalid",
                "knowledge_id는 AssetVersion UUID여야 합니다.",
            )

        raw = index_path.strip()
        if not raw or not Path(raw).is_absolute():
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "path_not_absolute",
                "색인 경로는 절대 경로여야 합니다.",
            )

        try:
            candidate = Path(raw).expanduser().resolve()
        except OSError:
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "path_not_a_directory",
                "색인 경로를 확인할 수 없습니다.",
            ) from None

        if not _is_contained(candidate, self._allowed_roots):
            raise LocalIndexError(
                ErrorCode.PERMISSION_DENIED,
                "path_outside_allowed_roots",
                "이 배포가 허용한 설치 경로 밖의 디렉터리는 등록할 수 없습니다.",
            )

        if not candidate.is_dir():
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "path_not_a_directory",
                "색인 경로가 디렉터리가 아닙니다.",
            )

        # Refuse before we can ever shadow locally-built content. This is what
        # makes the whole feature incapable of changing an existing search
        # result — see this module's docstring (precedence rule).
        if (self._central_index_base / knowledge_id).exists():
            # 실패가 아니라 사실 안내: 이 knowledge_id는 이미 이 배포의 기본
            # 색인 경로(INDEX_BASE)에서 검색 가능하다(module docstring의
            # precedence rule) — 등록이 "거부"되는 것은 맞지만, 호출자
            # 입장에서는 검색이 이미 되고 있으니 실패로 읽혀서는 안 된다.
            # 메시지 문구만 바꾼다 — code/reason("central_index_exists")과
            # 동작(등록 거부)은 그대로다.
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "central_index_exists",
                "이 Knowledge는 이미 이 배포의 기본 색인 경로에 등록되어 있어 "
                "바로 검색 가능합니다 — 별도의 외부 색인 등록은 필요하지 않습니다.",
            )

        meta_path = candidate / INDEX_META_FILENAME
        if not meta_path.is_file():
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "index_meta_missing",
                f"색인 폴더에 {INDEX_META_FILENAME}이 없습니다 — "
                "이 폴더는 Knowledge 색인이 아닙니다.",
            )
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "index_meta_unreadable",
                f"{INDEX_META_FILENAME}을 읽을 수 없습니다(손상되었을 수 있습니다).",
            ) from None
        recorded = meta.get("knowledge_id") if isinstance(meta, dict) else None
        if not isinstance(recorded, str) or recorded != knowledge_id:
            # The D-060 class of bug, refused rather than believed: if the
            # directory's own metadata does not claim this id, registering it
            # would silently answer this Knowledge's questions out of some
            # other Knowledge's documents.
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "index_meta_knowledge_id_mismatch",
                f"{INDEX_META_FILENAME}에 기록된 knowledge_id가 요청한 값과 다릅니다.",
            )

        if not (candidate / BM25_JSON_FILENAME).is_file():
            if (candidate / BM25_PICKLE_FILENAME).is_file():
                # D-054. Refused at registration, not at query time: this
                # index arrived over a distribution channel, and unpickling
                # distributed content is arbitrary code execution.
                raise LocalIndexError(
                    ErrorCode.VALIDATION_ERROR,
                    "bm25_legacy_pickle_only",
                    f"이 색인은 실행 가능한 legacy 형식({BM25_PICKLE_FILENAME})만 가지고 있어 "
                    f"등록할 수 없습니다 — convert-bm25-format으로 {BM25_JSON_FILENAME}으로 "
                    "변환한 뒤 다시 반입하세요.",
                )
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "bm25_missing",
                f"색인 폴더에 {BM25_JSON_FILENAME}이 없습니다 — 색인이 불완전합니다.",
            )

        if not (candidate / CHROMA_DIRNAME).is_dir():
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "chroma_missing",
                f"색인 폴더에 {CHROMA_DIRNAME} 디렉터리가 없습니다 — 색인이 불완전합니다.",
            )

        return candidate

    def _still_valid(self, entry: LocalIndexEntry) -> bool:
        """Cheap re-validation applied on every read/resolve. Registration
        already did the expensive checks; what can change afterwards is the
        filesystem (the user deletes or moves the installed asset) and the
        deployment's allowed roots (an operator narrows them). Both must take
        effect immediately rather than at the next registration."""
        if not self.enabled:
            return False
        try:
            candidate = Path(entry.index_path).resolve()
        except OSError:
            return False
        return _is_contained(candidate, self._allowed_roots) and candidate.is_dir()

    # -- public operations --------------------------------------------------

    def register(
        self, knowledge_id: str, index_path: str, source: str, label: str | None = None
    ) -> LocalIndexEntry:
        if source not in ALLOWED_SOURCES:
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "source_not_allowed",
                "지원하지 않는 색인 출처(source)입니다.",
            )
        if label is not None and len(label) > MAX_LABEL_LENGTH:
            raise LocalIndexError(
                ErrorCode.VALIDATION_ERROR,
                "label_too_long",
                f"label은 {MAX_LABEL_LENGTH}자를 넘을 수 없습니다.",
            )

        resolved = self._validated_path(knowledge_id, index_path)
        entry = LocalIndexEntry(
            knowledge_id=knowledge_id,
            index_path=str(resolved),
            source=source,
            label=label,
            registered_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            kept = [e for e in self._read_all() if e.knowledge_id != knowledge_id]
            kept.append(entry)
            self._write_all(kept)
        _logger.info(
            "search.local_index.registered knowledge_id=%s source=%s", knowledge_id, source
        )
        return entry

    def unregister(self, knowledge_id: str) -> bool:
        with self._lock:
            all_entries = self._read_all()
            kept = [e for e in all_entries if e.knowledge_id != knowledge_id]
            if len(kept) == len(all_entries):
                return False
            self._write_all(kept)
        _logger.info("search.local_index.unregistered knowledge_id=%s", knowledge_id)
        return True

    def list_entries(self) -> list[LocalIndexEntry]:
        """Registered entries that would actually serve a query right now.
        An entry whose directory has since been removed is omitted, so the
        list can never claim an activation that no longer works."""
        return [e for e in self._read_all() if self._still_valid(e)]

    def resolve(self, knowledge_id: str) -> Path | None:
        """The one lookup `hybrid_search` uses. Returns None whenever the
        central `INDEX_BASE` tree should be used instead — including for a
        registered id that (impossibly, since registration refuses it, but
        the central tree can gain the id afterwards) also exists centrally."""
        if not self.enabled:
            return None
        if (self._central_index_base / knowledge_id).exists():
            return None
        for entry in self._read_all():
            if entry.knowledge_id == knowledge_id:
                return Path(entry.index_path) if self._still_valid(entry) else None
        return None


_registry: LocalIndexRegistry | None = None
_registry_lock = threading.Lock()


def get_registry() -> LocalIndexRegistry:
    """Process-wide singleton built from `settings`. Lazy (not a module-level
    constant) so tests can point `settings` at a temp directory and call
    `reset_registry()` — the same reason `chroma_client_cache` keeps its cache
    behind a function rather than a module constant."""
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = LocalIndexRegistry(
                registry_path=settings.LOCAL_INDEX_REGISTRY_PATH,
                allowed_roots=settings.LOCAL_INDEX_ROOTS,
                central_index_base=settings.INDEX_BASE,
            )
        return _registry


def reset_registry() -> None:
    """Test seam only — drops the singleton so the next `get_registry()` picks
    up freshly patched settings."""
    global _registry
    with _registry_lock:
        _registry = None
