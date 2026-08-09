"""Recursive chunking strategy (04-knowledge-platform.md §2.5 Recursive).

문단 → 줄 → 문장 → 공백 → 문자 순으로 분할한다. Size unit is *characters*
(UTF-8 code points), not whitespace tokens — see D-053 in
docs/implementation-spec/open-decisions.md for why characters were chosen
(Korean text is not well served by `str.split()` word counts).

Implementation note: splitting works on (start, end) *offsets* into the
original text rather than on copied/concatenated substrings. This makes
overlap trivial and exact (`content[chunk_end - overlap : chunk_end]` is, by
construction, a contiguous slice of the original document — never a
reassembled string that could silently drop or duplicate a separator), and
it lets Parent-Child (chunkers/parent_child.py) recover each parent's true
offset in the source document to look up its heading Title Path.
"""

from __future__ import annotations

import re

from indexing_runtime.chunkers.ids import make_child_id, make_parent_id

# Paragraph, line, sentence, whitespace, character — in that precedence order.
# "" is the terminal character-level fallback: list(text) always yields
# pieces of length 1, which guarantees the recursion below terminates even
# for chunk_size as small as the schema's floor of 64.
_SEPARATOR_LEVELS: tuple[str, ...] = ("\n\n", "\n", "SENTENCE", " ", "")

# Korean/Japanese full-width terminators included alongside ASCII ones.
_SENTENCE_SPLIT_RE = re.compile(r"([.!?。]+\s+)")


def _sentence_spans(text: str, base: int) -> list[tuple[int, int]]:
    """Split `text` into sentence spans, offset by `base` into the parent text.

    Every character of `text` is covered by exactly one span (the
    terminating punctuation + trailing whitespace stays attached to the
    sentence it ends) — no content is dropped.
    """
    parts = _SENTENCE_SPLIT_RE.split(text)
    spans: list[tuple[int, int]] = []
    buf_len = 0
    start = base
    for i, part in enumerate(parts):
        buf_len += len(part)
        if i % 2 == 1:  # this part is a punctuation+whitespace match: sentence ends here
            spans.append((start, start + buf_len))
            start += buf_len
            buf_len = 0
    if buf_len:
        spans.append((start, start + buf_len))
    if not spans:
        return [(base, base + len(text))] if text else []
    return spans


def _raw_split_spans(text: str, start: int, end: int, separator: str) -> list[tuple[int, int]]:
    """Split text[start:end] into contiguous, order-preserving spans.

    Every separator style keeps the separator attached to the *preceding*
    piece, so concatenating the spans' texts always reconstructs
    text[start:end] exactly — chunking never silently loses a character.
    """
    segment = text[start:end]
    if separator == "":
        return [(i, i + 1) for i in range(start, end)]
    if separator == "SENTENCE":
        return _sentence_spans(segment, start)

    pieces = segment.split(separator)
    if len(pieces) == 1:
        return [(start, end)]
    spans: list[tuple[int, int]] = []
    cursor = start
    for piece in pieces[:-1]:
        span_len = len(piece) + len(separator)
        spans.append((cursor, cursor + span_len))
        cursor += span_len
    if pieces[-1]:
        spans.append((cursor, end))
    return spans


def _atomize_spans(
    text: str, start: int, end: int, seps: tuple[str, ...], chunk_size: int
) -> list[tuple[int, int]]:
    """Recursively split text[start:end] until every span fits chunk_size
    (or no separator levels remain, which cannot happen once the char-level
    "" separator is reached)."""
    if end - start <= chunk_size or not seps:
        return [(start, end)]

    sep = seps[0]
    rest = seps[1:]
    spans = _raw_split_spans(text, start, end, sep)
    if len(spans) <= 1:
        # This separator did not actually split anything (e.g. no blank
        # lines in the segment) — fall through to the next level directly.
        return _atomize_spans(text, start, end, rest, chunk_size)

    result: list[tuple[int, int]] = []
    for s, e in spans:
        if e - s > chunk_size:
            result.extend(_atomize_spans(text, s, e, rest, chunk_size))
        else:
            result.append((s, e))
    return result


def _merge_spans(
    spans: list[tuple[int, int]], chunk_size: int, chunk_overlap: int
) -> list[tuple[int, int]]:
    """Greedily merge atomic spans into <=chunk_size windows, carrying the
    trailing `chunk_overlap` characters of each window into the next one."""
    if not spans:
        return []

    chunks: list[tuple[int, int]] = []
    cur_start, cur_end = spans[0][0], spans[0][0]
    for s, e in spans:
        if cur_end > cur_start and (e - cur_start) > chunk_size:
            chunks.append((cur_start, cur_end))
            cur_start = max(cur_end - chunk_overlap, 0) if chunk_overlap > 0 else cur_end
        cur_end = e
    chunks.append((cur_start, cur_end))
    return chunks


def _merge_short_tail(
    text: str, spans: list[tuple[int, int]], minimum_size: int
) -> list[tuple[int, int]]:
    """§2.5: '너무 짧은 마지막 청크는 앞 청크와 병합 가능' — merge a trailing
    chunk shorter than minimum_size into the previous one."""
    if len(spans) < 2:
        return spans
    last_start, last_end = spans[-1]
    if (last_end - last_start) < minimum_size:
        prev_start, _prev_end = spans[-2]
        return [*spans[:-2], (prev_start, last_end)]
    return spans


def recursive_split_spans(
    text: str, chunk_size: int, chunk_overlap: int, minimum_size: int
) -> list[tuple[int, int]]:
    """Return non-strip()'d (start, end) offsets into `text` for each chunk.

    Exposed (not just the string-returning `recursive_split`) so
    Parent-Child can recover each parent's true document offset for heading
    lookup — see chunkers/parent_child.py.
    """
    if not text:
        return []
    atoms = _atomize_spans(text, 0, len(text), _SEPARATOR_LEVELS, chunk_size)
    merged = _merge_spans(atoms, chunk_size, chunk_overlap)
    merged = _merge_short_tail(text, merged, minimum_size)
    return [(s, e) for s, e in merged if text[s:e].strip()]


def recursive_split(
    text: str, chunk_size: int, chunk_overlap: int, minimum_size: int
) -> list[str]:
    """String-returning convenience wrapper around recursive_split_spans."""
    spans = recursive_split_spans(text, chunk_size, chunk_overlap, minimum_size)
    return [text[s:e].strip() for s, e in spans]


def recursive_chunk_document(
    doc: dict, knowledge_id: str, chunk_size: int, chunk_overlap: int, minimum_size: int
) -> list[dict]:
    """Recursive strategy — flat chunks, no Parent Store.

    §2.5 Recursive has no Parent-Child hierarchy, so no `parents.jsonl`
    entry is written and chunks carry no `parent_id` metadata (search-runtime
    treats a missing `parent_id` as "no parent to expand into", which is
    exactly correct here). To still satisfy the §2.6 formula
    "chunk_id = parent_id + ..." uniformly across strategies, a synthetic,
    unpersisted per-document anchor is derived with the same
    `make_parent_id` helper Parent-Child uses for real parents — it never
    appears in any output file, it only feeds the chunk_id hash.
    """
    content = doc["content"]
    document_id = doc["document_id"]
    meta = doc["metadata"]

    unit_id = make_parent_id(document_id, 0, "", content)
    pieces = recursive_split(content, chunk_size, chunk_overlap, minimum_size)

    children: list[dict] = []
    for idx, text in enumerate(pieces):
        chunk_id = make_child_id(unit_id, idx, "", text)
        children.append(
            {
                "id": chunk_id,
                "text": text,
                "metadata": {
                    "knowledge_id": knowledge_id,
                    "document_id": document_id,
                    "source_path": meta.get("source_path", ""),
                    "title": meta.get("title", ""),
                    "section": "",
                    "page": 1,
                    "chunk_type": "recursive",
                },
            }
        )
    return children
