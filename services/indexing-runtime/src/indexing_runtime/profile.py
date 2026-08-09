"""Indexing Profile resolution (D-053).

There is no Indexing Profile Registry yet (same D-034-family gap as the
missing Agent/Prompt/Service registries: the Knowledge manifest carries
`indexing_profile_ref: {name, version}`, but nothing resolves that reference
to an actual profile body today). `run_pipeline` therefore accepts an
optional, possibly-partial profile dict shaped like a subset of
packages/schemas/profiles/indexing-profile.schema.json, merges it over
DEFAULT_PROFILE, and validates only the chunking-relevant fields.

Full schema validation (via ai_asset_schemas.validator) is deliberately NOT
used here: the schema's `required` fields (name, version,
embedding_model_alias) describe a *named, registered* profile, which is a
different, larger concern than "what chunking behavior should this one
pipeline run use" — see docs/implementation-spec/open-decisions.md D-053 for
the full reasoning and the registry follow-up this defers.
"""

from __future__ import annotations

# Keep these bounds in sync with
# packages/schemas/profiles/indexing-profile.schema.json — duplicated
# (rather than reading the schema file at runtime) because this module only
# ever sees a partial dict that would fail the schema's `required` check;
# see the module docstring.
_CHUNK_SIZE_BOUNDS = (64, 4096)
_CHUNK_OVERLAP_BOUNDS = (0, 512)
_PARENT_CHUNK_SIZE_MIN = 256
_MINIMUM_SIZE_BOUNDS = (1, 4096)
_STRATEGIES = frozenset({"recursive", "markdown", "parent_child"})

# D-053: unit is characters (UTF-8 code points), not whitespace tokens — see
# indexing-profile.schema.json descriptions and chunkers/recursive.py.
# `chunk_size`/`chunk_overlap` reuse the values the schema already declared
# as defaults (512/64). `parent_chunk_size` is new here; 2048 keeps the
# previous ~4:1 parent:child ratio (old hardcoded parent_size=1024 words /
# child_size=256 words) after the word->character unit change, rather than
# attempting to reproduce the exact old character count (word-based sizing
# for Korean text was itself the defect being fixed).
#
# Reconsidered 2026-08-07 after a production regression (see
# chunkers/parent_child.py module docstring): these two sizes were briefly
# suspected as the root cause (they are large relative to real Korean
# policy documents in this repo — e.g. `remote-work-policy.md`'s `##`
# sections are 50-70 characters, its whole body 193). They are kept
# unchanged. Reasoning:
#   * With chunkers/parent_child.py now splitting at heading boundaries
#     *before* applying these sizes, chunk_size/parent_chunk_size act only
#     as a ceiling on how large a single section is allowed to grow before
#     it gets further subdivided — not as the thing that decides where a
#     chunk starts. For every real document in this repo (`remote-work-policy.md`
#     sections 11-69 chars, `langchain_ollama_agent.md` sections up to ~973
#     chars), both defaults comfortably exceed section size, so each `##`
#     section still becomes exactly one parent and one child, reproducing
#     the pre-regression section-level granularity exactly (verified:
#     re-chunking `remote-work-policy.md` with these unchanged defaults
#     plus the heading-boundary fix produces 4 chunks, matching the
#     pre-regression count, with `section` set to the specific heading).
#   * Lowering them would not have prevented the regression (the whole
#     193-character document was smaller than even the *child* size, so a
#     smaller ceiling alone cannot restore section boundaries) and would
#     needlessly fragment the handful of long, code-heavy sections seen in
#     `langchain_ollama_agent.md` into more pieces than necessary.
#   * They still matter as a genuine ceiling for structured documents with
#     unusually long sections (regulations with long clauses), which is
#     exactly what parent_chunk_size/chunk_size are for per §2.5.
DEFAULT_PROFILE: dict = {
    "chunking_strategy": "parent_child",
    "chunk_size": 512,
    "chunk_overlap": 64,
    "parent_chunk_size": 2048,
    "minimum_size": 64,
    "language": "ko",
}

_MERGEABLE_KEYS = (
    "chunking_strategy",
    "chunk_size",
    "chunk_overlap",
    "parent_chunk_size",
    "minimum_size",
    "language",
)


def resolve_profile(profile: dict | None) -> dict:
    """Merge a possibly-partial profile dict over DEFAULT_PROFILE and validate it.

    Omitting `profile` (or passing None) reproduces DEFAULT_PROFILE exactly —
    this is what every caller today (portal-api's `_trigger_indexing`, the
    CLI) does, so existing behavior is unchanged unless a caller opts in.
    """
    resolved = dict(DEFAULT_PROFILE)
    if profile:
        for key in _MERGEABLE_KEYS:
            if key in profile and profile[key] is not None:
                resolved[key] = profile[key]

    if resolved["chunking_strategy"] not in _STRATEGIES:
        raise ValueError(
            f"Unknown chunking_strategy: {resolved['chunking_strategy']!r}; "
            f"expected one of {sorted(_STRATEGIES)}"
        )

    _check_range("chunk_size", resolved["chunk_size"], _CHUNK_SIZE_BOUNDS)
    _check_range("chunk_overlap", resolved["chunk_overlap"], _CHUNK_OVERLAP_BOUNDS)
    _check_range("minimum_size", resolved["minimum_size"], _MINIMUM_SIZE_BOUNDS)
    if resolved["parent_chunk_size"] < _PARENT_CHUNK_SIZE_MIN:
        raise ValueError(f"parent_chunk_size must be >= {_PARENT_CHUNK_SIZE_MIN}")
    if resolved["chunk_overlap"] >= resolved["chunk_size"]:
        raise ValueError("chunk_overlap must be smaller than chunk_size")

    return resolved


def _check_range(name: str, value: int, bounds: tuple[int, int]) -> None:
    lo, hi = bounds
    if not (lo <= value <= hi):
        raise ValueError(f"{name}={value} out of range [{lo}, {hi}]")
