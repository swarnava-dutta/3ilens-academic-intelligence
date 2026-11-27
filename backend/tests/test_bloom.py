"""bloom.py: Bloom K1-K5 parsing, the verb heuristic and level resolution (FR-3.9)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import bloom

RUBRICS = Path(__file__).resolve().parents[1] / "rubrics"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("K3", "K3"), ("k3", "K3"), ("3", "K3"), (3, "K3"), (" K1 ", "K1"),
        ("remember", "K1"), ("Knowledge", "K1"), ("understand", "K2"), ("comprehension", "K2"),
        ("apply", "K3"), ("Application", "K3"), ("analyse", "K4"), ("analyze", "K4"), ("analysis", "K4"),
        ("evaluate", "K5"), ("evaluation", "K5"),
        ("K9", None), ("6", None), ("", None), (None, None), (True, None), ("create", None),
    ],
)
def test_parse_level(raw, expected):
    assert bloom.parse_level(raw) == expected


def test_genetics_rubric_heuristic_levels_are_pinned():
    content = json.loads((RUBRICS / "biology_genetics_v1.json").read_text(encoding="utf-8"))
    levels = bloom.resolve_levels(content)
    assert levels == {
        1: ("K3", "heuristic"), 2: ("K2", "heuristic"), 3: ("K2", "heuristic"),
        4: ("K3", "heuristic"), 5: ("K1", "heuristic"),
    }


def test_heuristic_highest_level_wins_and_defaults_to_k2():
    level, rationale = bloom.heuristic_level({"prompt": "State the law and justify your choice."})
    assert level == "K5" and rationale == "Verb 'justify' -> K5 Evaluate (heuristic)"
    assert bloom.heuristic_level({"prompt": "Why is the pyramid of energy upright?"})[0] == "K4"
    assert bloom.heuristic_level({"prompt": "Work out the ratio."})[0] == "K3"
    # whole words only: "showcase" is not "show", "named" is not "name"
    assert bloom.heuristic_level({"prompt": "The showcase named plants."}) == (
        "K2", "No level verb found - defaulted to K2 Understand (heuristic)",
    )
    assert bloom.heuristic_level({}) [0] == "K2"
    assert bloom.heuristic_level(None)[0] == "K2"


def test_resolve_levels_prefers_rubric_levels():
    content = {"questions": [
        {"question": 1, "prompt": "Define osmosis.", "bloom_level": "K4"},
        {"question": 2, "prompt": "Define osmosis.", "bloom_level": "apply", "bloom_source": "ai"},
        {"question": 3, "prompt": "Define osmosis.", "bloom_level": "K9"},
        {"question": 4, "prompt": "Define osmosis.", "bloom_level": "K2", "bloom_source": "heuristic"},
    ]}
    assert bloom.resolve_levels(content) == {
        1: ("K4", "faculty"), 2: ("K3", "ai"), 3: ("K1", "heuristic"), 4: ("K2", "faculty"),
    }
    assert bloom.resolve_levels(None) == {}


def test_concept_key_order_and_transfer():
    assert bloom.concept_key({"concept": " Mendel's  laws ", "chapter": "Genetics", "topic": "Cross"}) == "Mendel's laws"
    assert bloom.concept_key({"chapter": "Genetics", "topic": "Cross"}) == "Genetics"
    assert bloom.concept_key({"topic": "Monohybrid  Cross"}) == "Monohybrid Cross"
    assert bloom.concept_key(None) == ""
    assert [bloom.is_transfer(level) for level in bloom.LEVELS] == [False, False, True, True, True]
    assert bloom.label("k4") == "K4 Analyse" and bloom.label("x") == ""
    assert set(bloom.GUIDANCE) == set(bloom.LEVELS)


def test_heuristic_is_cached_per_normalised_prompt():
    bloom._heuristic_for_prompt.cache_clear()
    first = bloom.heuristic_level({"prompt": "Calculate  the\nratio."})
    assert bloom.heuristic_level({"prompt": "Calculate the ratio.", "question": 9}) == first
    info = bloom._heuristic_for_prompt.cache_info()
    assert (info.hits, info.misses) == (1, 1) and first[0] == "K3"
