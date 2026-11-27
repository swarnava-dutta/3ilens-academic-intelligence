"""Answer-key cells: bonus words only make a bonus when the cell holds nothing else but option
tokens and filler ('4 or bonus'), never an option and its text ('(b) dropped object'); option
tokens followed by punctuation still name every option."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import marking  # noqa: E402


@pytest.mark.parametrize("cell", [
    "Bonus", "BONUS", "*", "Dropped", "Deleted", "Cancelled", "Grace", "4 or bonus", "4 or\nbonus",
    "Bonus (question dropped)", "Bonus - marks to all", "Q dropped", "All options correct", "All are correct",
    "All 4 are correct", "All four are correct", "All four options correct", "Any option", "full marks to all",
])
def test_bonus_cells(cell):
    assert marking.is_bonus_key(cell)
    assert marking.parse_answer_key(cell) == {"bonus": True}


@pytest.mark.parametrize("cell, expected", [
    ("(b) dropped object", {"correct_option": "B"}),
    ("(2) a body is dropped from a height", {"correct_option": "B"}),
    ("(c) cancelled cheque", {"correct_option": "C"}),
    ("(d) withdrawn reflex", {"correct_option": "D"}),
    ("all of the above", None),
])
def test_option_text_with_a_bonus_word_is_not_a_bonus(cell, expected):
    assert not marking.is_bonus_key(cell)
    got = marking.parse_answer_key(cell, 4)
    assert got == expected if expected is not None else not got or "bonus" not in got


@pytest.mark.parametrize("cell", ["(2) (3).", "(2)(3).", "(2)(3),", "2, 3.", "(b), (c);", "b)c)."])
def test_option_tokens_followed_by_punctuation_name_every_option(cell):
    assert marking.option_letters(cell, 4) == ["B", "C"]
    assert marking.normalise_option(cell, 4) == marking.MULTI
    assert marking.parse_answer_key(cell, 4) == {"accepted_options": ["B", "C"]}


def test_single_option_with_text_or_period_stays_single():
    assert marking.normalise_option("(b) mitochondria.", 4) == "B"
    assert marking.normalise_option("b.", 4) == "B"
    assert marking.normalise_option("(3).", 4) == "C"
