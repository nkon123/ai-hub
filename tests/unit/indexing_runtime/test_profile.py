"""Indexing Profile resolution (D-053) — no I/O, pure merge/validation."""

from __future__ import annotations

import pytest
from indexing_runtime.profile import DEFAULT_PROFILE, resolve_profile


def test_none_profile_resolves_to_default():
    assert resolve_profile(None) == DEFAULT_PROFILE


def test_empty_dict_profile_resolves_to_default():
    assert resolve_profile({}) == DEFAULT_PROFILE


def test_default_reproduces_todays_behavior_parent_child_strategy():
    """Every existing caller (portal-api's _trigger_indexing, the CLI) omits
    `profile` entirely — the default must keep them on `parent_child`
    chunking, unchanged."""
    resolved = resolve_profile(None)
    assert resolved["chunking_strategy"] == "parent_child"


def test_partial_override_merges_over_defaults():
    resolved = resolve_profile({"chunking_strategy": "recursive", "chunk_size": 1000})

    assert resolved["chunking_strategy"] == "recursive"
    assert resolved["chunk_size"] == 1000
    # Untouched fields keep their default.
    assert resolved["chunk_overlap"] == DEFAULT_PROFILE["chunk_overlap"]
    assert resolved["minimum_size"] == DEFAULT_PROFILE["minimum_size"]


def test_none_values_in_profile_dict_do_not_override_defaults():
    resolved = resolve_profile({"chunk_size": None})
    assert resolved["chunk_size"] == DEFAULT_PROFILE["chunk_size"]


@pytest.mark.parametrize("strategy", ["recursive", "markdown", "parent_child"])
def test_all_three_strategies_are_accepted(strategy: str):
    resolved = resolve_profile({"chunking_strategy": strategy})
    assert resolved["chunking_strategy"] == strategy


def test_unknown_strategy_is_rejected():
    with pytest.raises(ValueError, match="chunking_strategy"):
        resolve_profile({"chunking_strategy": "langgraph_canvas"})


@pytest.mark.parametrize("chunk_size", [1, 63, 4097, 100000])
def test_chunk_size_out_of_schema_bounds_is_rejected(chunk_size: int):
    with pytest.raises(ValueError, match="chunk_size"):
        resolve_profile({"chunk_size": chunk_size})


def test_chunk_overlap_out_of_schema_bounds_is_rejected():
    with pytest.raises(ValueError, match="chunk_overlap"):
        resolve_profile({"chunk_overlap": 513})


def test_parent_chunk_size_below_minimum_is_rejected():
    with pytest.raises(ValueError, match="parent_chunk_size"):
        resolve_profile({"parent_chunk_size": 100})


def test_overlap_must_be_smaller_than_chunk_size():
    with pytest.raises(ValueError, match="overlap"):
        resolve_profile({"chunk_size": 100, "chunk_overlap": 100})
