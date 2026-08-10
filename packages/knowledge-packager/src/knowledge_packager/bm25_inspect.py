"""Safe, non-executing introspection of a Knowledge index's BM25 artifact
(D-054, see docs/implementation-spec/open-decisions.md).

Two formats coexist in the wild:

  - `bm25.json` (current, since D-054's resolution): a plain JSON file
    written by `indexing_runtime.pipeline.run_pipeline` — a tokenized
    corpus plus `chunk_ids`/`chunk_texts`/`chunk_metadata`. Reading it is a
    trivial `json.loads`; there is no way for JSON to execute code, so
    `peek_bm25_json` needs none of this module's pickle-opcode machinery.

  - `bm25.pkl` (legacy — an index not yet migrated by indexing-runtime's
    `convert-bm25-format` CLI): a Python pickle written the old way,
    `pickle.dump({"bm25": BM25Okapi(...), "chunk_ids": [...], "chunk_texts":
    [...], "chunk_metadata": [...]}, f)`. A Knowledge Package may travel
    over `services/distribution-service` to an untrusted destination before
    anyone runs `package-knowledge verify` against it — `pickle.load` on
    that file would import whatever module the GLOBAL/STACK_GLOBAL opcodes
    name and call whatever callable the REDUCE/NEWOBJ/BUILD opcodes
    reference. That is arbitrary code execution by design (the same
    primitive `pickle` docs themselves warn about), so this package NEVER
    calls `pickle.load`/`pickle.loads` on package content, anywhere,
    including here — regardless of whether the package's *source* index was
    built locally or not. `packages/knowledge_packager`'s trust boundary is
    always "the package's bytes are untrusted," unlike
    `indexing_runtime`/`search_runtime`'s narrower "an operator-controlled
    local index directory is trusted" carve-outs.

    For this legacy case, this module walks the pickle's *opcode stream*
    with `pickletools.genops` — a pure disassembler that decodes each
    opcode's literal argument (an int, a string, a float, ...) without
    importing anything or invoking any callable — and reconstructs only the
    JSON-safe parts of the object graph
    (dict/list/tuple/str/int/float/bool/None). Anything that would require
    executing code to produce (GLOBAL, STACK_GLOBAL, REDUCE, NEWOBJ,
    NEWOBJ_EX, BUILD, INST, OBJ, PERSID, BINPERSID, EXT1/2/4) is instead
    represented by an inert `_Opaque` placeholder that carries only a
    human-readable label — the interpreter below never imports the named
    module/class and never calls the named callable. This makes
    `peek_bm25_pickle` safe to run on a `bm25.pkl` from a package of unknown
    provenance.

    Scope note: this is deliberately narrow — it is a "safe peek", not a
    general sandboxed unpickler. It handles every opcode in
    `pickletools.opcodes` (the complete pickle protocol 0-5 opcode set), so
    it will not crash on a normally-produced pickle, but it makes no
    attempt to be a hardened parser against a maliciously malformed pickle
    stream (e.g. it trusts `pickletools.genops`'s own parsing and does not
    defend against crafted memo/stack-depth attacks meant to exhaust
    memory). That is an acceptable PoC-scope limitation given
    `package-knowledge verify` is a local developer tool, not a
    network-facing service. Kept (not retired) specifically to still
    support packages built from an index directory an operator has not yet
    run `convert-bm25-format` against — retiring it outright would make
    `package-knowledge build/verify` unable to handle any not-yet-migrated
    index at all.

`peek_bm25_artifact(index_dir)` is the one entry point `builder.py` uses —
it resolves which file is actually present (`bm25.json` preferred) and
returns a summary plus which format it read, so callers never need to know
which of the two code paths above ran.
"""

from __future__ import annotations

import json
import pickletools
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class UnsafePickleError(Exception):
    """Raised when the opcode stream contains something this safe reader
    cannot interpret without guessing (e.g. an opcode outside the known
    protocol 0-5 set, or a malformed stack)."""


@dataclass(frozen=True)
class _Opaque:
    """Placeholder for any pickled value this module refuses to construct
    for real (i.e. anything that would require importing a name or calling
    a callable). Carries only a label for diagnostics — never the ability
    to be invoked."""

    label: str

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"<Opaque {self.label}>"


_MARK = object()  # sentinel pushed by the MARK opcode


def _safe_peek(data: bytes) -> Any:
    """Reconstruct the JSON-safe skeleton of a pickle stream without
    executing any of its GLOBAL/REDUCE/BUILD instructions. See module
    docstring for the safety argument."""
    stack: list[Any] = []
    memo: dict[int, Any] = {}
    result: Any = None

    def pop_to_mark() -> list[Any]:
        items: list[Any] = []
        while stack and stack[-1] is not _MARK:
            items.append(stack.pop())
        if not stack:
            raise UnsafePickleError("MARK 없이 stackslice 연산을 만났습니다 (malformed pickle)")
        stack.pop()  # discard the MARK itself
        items.reverse()
        return items

    for opcode, arg, _pos in pickletools.genops(data):
        name = opcode.name
        if name in ("PROTO", "FRAME", "PUT", "BINPUT", "LONG_BINPUT"):
            if name in ("PUT", "BINPUT", "LONG_BINPUT"):
                memo[int(arg)] = stack[-1]
            continue
        if name == "MEMOIZE":
            memo[len(memo)] = stack[-1]
            continue
        if name in ("GET", "BINGET", "LONG_BINGET"):
            stack.append(memo[int(arg)])
            continue
        if name == "MARK":
            stack.append(_MARK)
            continue
        if name in (
            "NONE",
            "NEWTRUE",
            "NEWFALSE",
            "BININT",
            "BININT1",
            "BININT2",
            "LONG1",
            "LONG4",
            "INT",
            "LONG",
            "BINFLOAT",
            "FLOAT",
            "SHORT_BINUNICODE",
            "BINUNICODE",
            "BINUNICODE8",
            "UNICODE",
            "SHORT_BINSTRING",
            "BINSTRING",
            "STRING",
            "SHORT_BINBYTES",
            "BINBYTES",
            "BINBYTES8",
        ):
            stack.append(arg)
            continue
        if name == "EMPTY_DICT":
            stack.append({})
            continue
        if name == "EMPTY_LIST":
            stack.append([])
            continue
        if name == "EMPTY_TUPLE":
            stack.append(())
            continue
        if name == "EMPTY_SET":
            stack.append(set())
            continue
        if name == "TUPLE":
            stack.append(tuple(pop_to_mark()))
            continue
        if name == "TUPLE1":
            a = stack.pop()
            stack.append((a,))
            continue
        if name == "TUPLE2":
            b, a = stack.pop(), stack.pop()
            stack.append((a, b))
            continue
        if name == "TUPLE3":
            c, b, a = stack.pop(), stack.pop(), stack.pop()
            stack.append((a, b, c))
            continue
        if name == "LIST":
            stack.append(pop_to_mark())
            continue
        if name == "APPEND":
            value = stack.pop()
            stack[-1].append(value)
            continue
        if name == "APPENDS":
            values = pop_to_mark()
            stack[-1].extend(values)
            continue
        if name == "DICT":
            items = pop_to_mark()
            stack.append(dict(zip(items[0::2], items[1::2], strict=True)))
            continue
        if name == "SETITEM":
            value, key = stack.pop(), stack.pop()
            stack[-1][key] = value
            continue
        if name == "SETITEMS":
            items = pop_to_mark()
            target = stack[-1]
            for key, value in zip(items[0::2], items[1::2], strict=True):
                target[key] = value
            continue
        if name in ("FROZENSET", "ADDITEMS"):
            items = pop_to_mark() if name == "FROZENSET" else None
            if name == "FROZENSET":
                stack.append(frozenset(items))
            else:
                values = pop_to_mark()
                stack[-1].update(values)
            continue
        if name in ("POP",):
            stack.pop()
            continue
        if name == "POP_MARK":
            pop_to_mark()
            continue
        if name == "DUP":
            stack.append(stack[-1])
            continue
        # --- Everything below this line WOULD require executing code to
        # produce the real value. We intentionally never import the named
        # module/class or call the named/reduced callable — only an inert
        # placeholder is pushed. ---
        if name == "GLOBAL":
            stack.append(_Opaque(f"GLOBAL:{arg}"))
            continue
        if name == "STACK_GLOBAL":
            qualname, module = stack.pop(), stack.pop()
            stack.append(_Opaque(f"STACK_GLOBAL:{module}.{qualname}"))
            continue
        if name == "REDUCE":
            _args, callable_ = stack.pop(), stack.pop()
            stack.append(_Opaque(f"REDUCE:{callable_!r}"))
            continue
        if name == "NEWOBJ":
            _args, cls = stack.pop(), stack.pop()
            stack.append(_Opaque(f"NEWOBJ:{cls!r}"))
            continue
        if name == "NEWOBJ_EX":
            _kwargs, _args, cls = stack.pop(), stack.pop(), stack.pop()
            stack.append(_Opaque(f"NEWOBJ_EX:{cls!r}"))
            continue
        if name == "BUILD":
            _state = stack.pop()  # discarded — never applied to a real object
            continue
        if name == "INST":
            pop_to_mark()
            stack.append(_Opaque(f"INST:{arg}"))
            continue
        if name == "OBJ":
            items = pop_to_mark()
            cls = items[0] if items else None
            stack.append(_Opaque(f"OBJ:{cls!r}"))
            continue
        if name in ("PERSID", "BINPERSID"):
            if name == "BINPERSID":
                stack.pop()
            stack.append(_Opaque(f"{name}:{arg}"))
            continue
        if name in ("EXT1", "EXT2", "EXT4"):
            stack.append(_Opaque(f"{name}:{arg}"))
            continue
        if name == "STOP":
            result = stack.pop()
            continue
        raise UnsafePickleError(f"알 수 없는 pickle opcode: {name!r} — 안전하게 해석할 수 없습니다")

    return result


@dataclass(frozen=True)
class Bm25PickleSummary:
    """Just enough of `bm25.pkl`'s shape to run §4.1's record-count
    reconciliation and chunk-id consistency checks, without ever
    unpickling the embedded BM25Okapi object itself."""

    chunk_ids: list[str]
    record_count: int


def peek_bm25_pickle(data: bytes) -> Bm25PickleSummary:
    """Safely extract `chunk_ids` (and its length) from a `bm25.pkl` byte
    string written by `indexing_runtime.pipeline.run_pipeline`, without
    calling `pickle.load`.

    Raises `UnsafePickleError` if the file's top-level shape does not match
    the expected `{"chunk_ids": [...], ...}` dict — this deliberately does
    not fall back to a permissive guess; an unexpected shape is reported as
    a verification failure by the caller, not silently ignored.
    """
    top = _safe_peek(data)
    if not isinstance(top, dict) or "chunk_ids" not in top:
        raise UnsafePickleError(
            "bm25.pkl의 최상위 구조가 예상({'chunk_ids': [...], ...})과 다릅니다"
        )
    chunk_ids = top["chunk_ids"]
    if not isinstance(chunk_ids, list) or not all(isinstance(c, str) for c in chunk_ids):
        raise UnsafePickleError("bm25.pkl의 chunk_ids가 문자열 리스트가 아닙니다")
    return Bm25PickleSummary(chunk_ids=chunk_ids, record_count=len(chunk_ids))


BM25_JSON_FILENAME = "bm25.json"
BM25_PICKLE_FILENAME = "bm25.pkl"


def peek_bm25_json(data: bytes) -> Bm25PickleSummary:
    """Extract `chunk_ids` (and its length) from a `bm25.json` byte string —
    a plain `json.loads`, since the file cannot contain executable content
    by construction (D-054). Named/shaped to match `peek_bm25_pickle` so
    `peek_bm25_artifact` can treat both formats identically.

    Raises `UnsafePickleError` (reused, not a new exception type, so callers
    that already catch it for the legacy path do not need a second except
    clause) if the shape does not match."""
    try:
        top = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UnsafePickleError(f"bm25.json 파싱 실패: {exc}") from exc
    if not isinstance(top, dict) or "chunk_ids" not in top:
        raise UnsafePickleError(
            "bm25.json의 최상위 구조가 예상({'chunk_ids': [...], ...})과 다릅니다"
        )
    chunk_ids = top["chunk_ids"]
    if not isinstance(chunk_ids, list) or not all(isinstance(c, str) for c in chunk_ids):
        raise UnsafePickleError("bm25.json의 chunk_ids가 문자열 리스트가 아닙니다")
    return Bm25PickleSummary(chunk_ids=chunk_ids, record_count=len(chunk_ids))


def peek_bm25_artifact(index_dir: Path) -> tuple[Bm25PickleSummary, str]:
    """Resolve and safely peek whichever BM25 artifact is actually present
    under `index_dir` — `bm25.json` preferred, `bm25.pkl` as a legacy
    fallback (both read the same way regardless of the package's/index's
    provenance — see module docstring). Returns `(summary, format)` where
    `format` is `"json"` or `"pickle"`.

    Raises `UnsafePickleError` if neither file exists or the one found does
    not parse — callers report this as a verification failure, never a
    silent empty summary."""
    json_path = index_dir / BM25_JSON_FILENAME
    pkl_path = index_dir / BM25_PICKLE_FILENAME
    if json_path.is_file():
        return peek_bm25_json(json_path.read_bytes()), "json"
    if pkl_path.is_file():
        return peek_bm25_pickle(pkl_path.read_bytes()), "pickle"
    raise UnsafePickleError(
        f"{BM25_JSON_FILENAME}/{BM25_PICKLE_FILENAME} 둘 다 없습니다: {index_dir}"
    )
