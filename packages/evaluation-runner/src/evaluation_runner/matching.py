"""Document-id ↔ citation matching rule (D-045, see open-decisions.md).

Since 2026-08-16 search-runtime *does* return the indexer's stable
`document_id` (§2.6/§3.12), so this module prefers it over the presentation
fields. But it still reduces it to a filename stem rather than comparing ids
exactly, and that is a deliberate decision worth stating plainly, because
"now that real ids exist, compare real ids" is the obvious move and it is
wrong here:

    document_id = f"{knowledge_id}:{relative_path}"

and `knowledge_id` in this repo is the **AssetVersion** id. An exact
comparison would therefore bake a specific Knowledge *version* into every
`expected_document_ids` entry — while `EvaluationDataset.knowledge_asset_id`
is the Asset id precisely so one dataset stays valid across versions of the
same Knowledge (see evaluation-dataset.schema.json). Exact matching would
break that on the first re-index, and every dataset would need rewriting for
every new version.

So the rule is: take the most authoritative source available for a
citation's document identity — `document_id` when the index has one,
otherwise `document_path`, otherwise `document_title` — and normalize it to
its lower-cased filename stem. The upgrade this brings is not a different id
space; it is that the identity no longer depends on display fields, which a
title edit or a missing `source_path` can change.

Evaluation Dataset authors keep writing `expected_document_ids` /
`forbidden_document_ids` as filename stems (e.g. "remote-work-policy" for a
source file named `remote-work-policy.md`); this module normalizes the
dataset side identically, so a fixture may write either form.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from evaluation_runner.search_client import Citation


def _normalize(raw: str) -> str:
    if not raw:
        return ""
    # PurePosixPath handles both '/' and already-bare names; strips exactly
    # one suffix (".md", ".txt", ...) if present, otherwise returns raw as-is.
    # A document_id's `{knowledge_id}:` prefix falls away with the rest of the
    # path here — `PurePosixPath("kv-1:documents/hr.md").stem == "hr"`.
    stem = PurePosixPath(raw.strip()).stem
    return stem.strip().lower()


def document_id_from_citation(citation: Citation) -> str:
    """Derive the document id an expected_document_ids entry should match.

    Preference order is authority, not convenience: the indexer's own
    `document_id` first, then the path, then the title. Falling through is
    normal for older indexes, not an error — see this module's docstring.
    """
    raw = citation.document_id or citation.document_path or citation.document_title or ""
    return _normalize(raw)


def normalize_expected_document_id(doc_id: str) -> str:
    """Normalize one dataset-authored expected/forbidden document id the same way."""
    return _normalize(doc_id)
