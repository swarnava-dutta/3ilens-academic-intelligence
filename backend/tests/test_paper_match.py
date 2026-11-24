"""Same-paper check (paper_match.compare): printed question stems and paper codes against a rubric.
Deterministic and offline - synthetic questions only."""
from __future__ import annotations

import random

import pytest

import paper_match
from schemas import RubricMatch
from tests.test_contract import check_interface

QUESTIONS = [
    "From a disc of radius R and mass M a circular hole of diameter R is cut; find the moment of inertia.",
    "A square loop carrying current is placed near a long straight conductor carrying current I.",
    "The magnetic susceptibility is negative for diamagnetic materials only.",
    "A siren emitting sound of frequency 800 Hz moves away from an observer towards a cliff.",
    "A capacitor of 2 microfarad is charged and the switch is turned to position 2.",
    "In a diffraction pattern due to a single slit of width a the first minimum is at 30 degrees.",
    "At what height from the surface of earth is the gravitation potential minus 5.4 x 10^7 J/kg?",
    "Which accelerating charge can be used to produce a propagating electromagnetic wave?",
    "Two identical charged spheres suspended from a common point by strings of length l are leaking charge.",
    "A uniform rope of length L and mass m1 hangs vertically from a rigid support carrying a block.",
    "A refrigerator works between 4 degree Celsius and 30 degree Celsius removing 600 calories each second.",
    "An air column closed at one end resonates with a tuning fork at the smallest length of 50 cm.",
    "Natural rubber is a polymer of isoprene units with all cis configuration about double bonds.",
    "The electronic configurations of europium, gadolinium and terbium atomic numbers 63, 64 and 65.",
    "In a protein molecule various amino acids are linked together by peptide bonds.",
    "A typical fat molecule is made up of one glycerol and three fatty acid molecules.",
]
OTHER_PAPER = [
    "Consider a water tank with one wall at x equal to L, very wide in the z direction.",
    "A microscope has an objective of focal length 2 cm and an eyepiece of focal length 4 cm.",
    "An electron moving with speed c/100 is injected into a magnetic field perpendicular to its motion.",
    "There are two inclined surfaces of equal length with the same angle of inclination 45 degrees.",
    "The kinetic energies of two similar cars A and B are 100 J and 225 J respectively.",
    "The output Y of the given logic implementation is similar to the output of a NOR gate.",
    "A ball of mass 0.5 kg is dropped from a height of 40 m and rises to 10 m.",
    "A 2 amp current flows through two small circular copper coils with radii ratio 1 : 2.",
    "In a certain camera four similar thin convex lenses are arranged axially in contact.",
    "Two cities X and Y are connected by a regular bus service with a bus going in either direction.",
    "The diameter of a spherical object is measured with vernier callipers of least count 0.01 cm.",
    "A pipe open at both ends has a fundamental frequency f in air and is half dipped in water.",
    "Two identical point masses suspended from massless springs oscillate vertically with equal amplitude.",
    "The energy of a photon equals the kinetic energy of an electron of de Broglie wavelength lambda.",
    "A metallic wire of resistance 20 ohm is stretched to double its length uniformly.",
    "A convex mirror forms an image one third the size of the object placed 30 cm away.",
]


def rubric(prompts: list[str], name: str = "NEET mock", **extra) -> dict:
    return {
        "name": name,
        "questions": [
            {"question": n, "topic": "T", "max_marks": 4, "question_type": "mcq", "options": ["a", "b", "c", "d"],
             "correct_option": "A", "prompt": prompt}
            for n, prompt in enumerate(prompts, start=1)
        ],
        **extra,
    }


def stems(prompts: list[str], words: int = 12) -> dict[int, str]:
    return {n: " ".join(prompt.split()[:words]) for n, prompt in enumerate(prompts, start=1)}


def shuffled(prompts: list[str], seed: int = 3) -> list[str]:
    out = prompts[:]
    rng = random.Random(seed)
    while any(a == b for a, b in zip(out, prompts)):
        rng.shuffle(out)
    return out


# --------------------------------------------------------------------------- #
# Verdicts
# --------------------------------------------------------------------------- #
def test_the_same_paper_matches():
    result = paper_match.compare(stems(QUESTIONS), rubric(QUESTIONS))
    assert isinstance(result, RubricMatch)
    assert (result.verdict, result.compared, result.matched, result.moved) == ("match", 16, 16, 0)
    assert result.message == "The sheet's printed questions match the rubric (16 of 16 compared)."
    assert result.examples == []
    check_interface(result.model_dump(mode="json"), "RubricMatch")


def test_a_shortened_paraphrase_in_the_rubric_still_matches():
    paraphrased = [" ".join(p.replace(" the ", " ").split()[:9]) for p in QUESTIONS]
    printed = {n: "Q. " + stem.upper() for n, stem in stems(QUESTIONS).items()}  # case and noise ignored
    assert paper_match.compare(printed, rubric(paraphrased)).verdict == "match"


def test_another_code_of_the_paper_is_reordered():
    result = paper_match.compare(stems(shuffled(QUESTIONS)), rubric(QUESTIONS))
    assert result.verdict == "reordered" and result.matched == 0 and result.moved == 16
    sheet_q, rubric_q = 1, QUESTIONS.index(shuffled(QUESTIONS)[0]) + 1
    assert result.message == (
        f"The sheet has the rubric's questions in a different order (e.g. sheet Q{sheet_q} is rubric "
        f"Q{rubric_q}) - probably another code or set of this paper; grade it with the rubric for that version."
    )
    assert len(result.examples) == 3 and result.examples[0].startswith(f"Sheet Q1 '") and result.examples[0].endswith(
        f"' is rubric Q{rubric_q}.")


def test_a_different_paper_is_a_mismatch():
    result = paper_match.compare(stems(OTHER_PAPER), rubric(QUESTIONS))
    assert (result.verdict, result.compared, result.matched) == ("mismatch", 16, 0)
    assert result.message == (
        "The sheet's printed questions do not match the rubric (0 of 16 compared) - it looks like a different paper."
    )
    assert len(result.examples) == 3 and result.examples[0].startswith("Q1: sheet 'Consider a water tank")
    assert all(len(line) < 140 for line in result.examples)


def test_too_little_text_is_unknown():
    result = paper_match.compare(dict(list(stems(OTHER_PAPER).items())[:5]), rubric(QUESTIONS))
    assert (result.verdict, result.compared) == ("unknown", 5)
    assert result.message == "Too little printed question text to check the sheet against the rubric (5 questions compared)."


def test_a_partial_match_is_unknown():
    printed = stems(QUESTIONS[:7] + OTHER_PAPER[7:])  # 7 of 16 the same (44%)
    result = paper_match.compare(printed, rubric(QUESTIONS))
    assert (result.verdict, result.matched) == ("unknown", 7)
    assert result.message == (
        "The sheet's printed questions only partly match the rubric (7 of 16 compared) - check that it is the same "
        "paper and version."
    )


def test_short_or_generic_stems_are_not_compared():
    printed = {n: "Which of the following statements is correct?" for n in range(1, 17)}
    printed[1] = "Natural rubber has"
    result = paper_match.compare(printed, rubric(QUESTIONS))
    assert result.compared == 0 and result.verdict == "unknown"


def test_a_rubric_without_question_text_is_unknown():
    no_prompts = rubric(QUESTIONS)
    for question in no_prompts["questions"]:
        question.pop("prompt")
        question["options"] = []
    result = paper_match.compare(stems(QUESTIONS), no_prompts)
    assert result.verdict == "unknown" and result.compared == 0
    assert result.message == "The rubric has no question text to check the sheet's printed questions against."


def test_string_keys_and_junk_are_tolerated():
    printed = {str(n): stem for n, stem in stems(QUESTIONS).items()}
    printed.update({"x": "junk", "0": "zero", "17": None})  # type: ignore[dict-item]
    result = paper_match.compare(printed, rubric(QUESTIONS))  # type: ignore[arg-type]
    assert result.verdict == "match" and result.compared == 16
    assert paper_match.compare({}, {}).verdict == "unknown"
    assert paper_match.compare({1: "a b c"}, {"questions": "nope"}).verdict == "unknown"  # type: ignore[dict-item]


def test_options_count_as_rubric_text():
    content = rubric(["Natural rubber has" for _ in range(10)])
    for number, question in enumerate(content["questions"], start=1):
        question["options"] = [f"isoprene unit{number} polymer", f"chloroprene chain{number}", "cis", "trans"]
    printed = {n: f"Natural rubber has isoprene unit{n} polymer chloroprene chain{n}" for n in range(1, 11)}
    assert paper_match.compare(printed, content).verdict == "match"


# --------------------------------------------------------------------------- #
# Paper codes
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Code A", "A"), ("code a", "A"), ("CODE - 45", "45"), ("CODE \n- 45\nCAREER INSTITUTE", "45"),
        ("Test Booklet Code: P", "P"), ("Paper Code A/P/W", "A/P/W"), ("A / P / W", "A/P/W"), ("045", "45"),
        ("Set 2", "2"), ("SET - B", "B"), ("Set No. 3", "3"), ("NEET 2016 Code a", "A"), ("NEET 2024 Code Q1", "Q1"),
        ("Physics Paper+With+Answer Code-45-1", "45"), ("", None), (None, None), ("NEET 2023 Question Paper", None),
        ("Code 2016", None), ("Pin Code 324005", None), ("Mock set of physics", None), ("Code: 1 2 3 4", None),
    ],
)
def test_normalise_code(value, expected):
    assert paper_match.normalise_code(value) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Match the columns.\nCode:\nA B C D\n(1) iii iv ii i",
        "Code: \n(iii) Extraction of Al",
        "Code:\nA\nB\nC\nD\n",
        "Code :\n a b c d",
        "Take a set of 4 resistors. The genetic code is universal.",
    ],
)
def test_question_text_is_not_a_paper_code(text):
    assert paper_match.find_code(text) is None


def test_the_most_frequent_code_wins_and_labels_name_it():
    text = "Set 2\nPage 1\nCODE - 45\nq1\nCODE - 45\nq2"
    assert paper_match.find_code(text) == "45"
    assert paper_match.code_label(text) == "Code 45"
    assert paper_match.code_label("Paper Set B\n1. Question") == "Set B"
    assert paper_match.code_label("nothing here") is None


def test_rubric_code_from_the_field_or_the_name():
    assert paper_match.rubric_code({"name": "NEET 2016", "paper_code": "Code P"}) == "P"
    assert paper_match.rubric_code({"name": "NEET 2016 Code A/P/W"}) == "A/P/W"
    assert paper_match.rubric_code({"name": "NEET mock"}) is None
    assert paper_match.rubric_code(None) is None  # type: ignore[arg-type]


def test_codes_differ_only_with_nothing_in_common():
    assert paper_match.codes_differ("B", "A")
    assert not paper_match.codes_differ("A", "A/P/W")
    assert not paper_match.codes_differ(None, "A") and not paper_match.codes_differ("A", None)


def test_differing_codes_make_an_unknown_text_verdict_a_mismatch():
    result = paper_match.compare({}, rubric(QUESTIONS, paper_code="Code A"), sheet_code="Code B")
    assert (result.verdict, result.sheet_code, result.rubric_code) == ("mismatch", "B", "A")
    assert result.message == (
        "The sheet's printed paper code (B) differs from the rubric's (A) - it looks like another version of the "
        "paper; grade it with the rubric for code B."
    )


def test_differing_codes_hold_even_when_the_text_matches():
    # Some versions shuffle only the options: same question text, another key -> held as another version.
    matched = paper_match.compare(stems(QUESTIONS), rubric(QUESTIONS, name="NEET Code A"), sheet_code="CODE - B")
    assert matched.verdict == "reordered" and matched.verdict in paper_match.HOLD_VERDICTS
    assert matched.message == (
        "The sheet's printed questions match the rubric (16 of 16 compared), but its paper code (B) differs from the "
        "rubric's (A) - it looks like another version of the paper (options may be in another order); grade it with "
        "the rubric for code B."
    )
    reordered = paper_match.compare(stems(shuffled(QUESTIONS)), rubric(QUESTIONS, paper_code="A"), sheet_code="B")
    assert reordered.verdict == "reordered" and "and its paper code (B) differs from the rubric's (A) - " in reordered.message


def test_same_codes_change_nothing():
    result = paper_match.compare(stems(QUESTIONS), rubric(QUESTIONS, paper_code="A/P/W"), sheet_code="Code P")
    assert result.verdict == "match" and result.message.endswith("(16 of 16 compared).")
    few = paper_match.compare({}, rubric(QUESTIONS, paper_code="A"), sheet_code="A")
    assert few.verdict == "unknown"


def test_typed_summary_prompts_never_hold_the_right_paper():
    summaries = ["Moment of inertia", "Force on loop", "Susceptibility sign", "Doppler echo", "Capacitor energy",
                 "Single slit", "Gravitational potential", "EM waves", "Charged spheres", "Rope wave"] * 2
    result = paper_match.compare(stems(QUESTIONS), rubric(summaries[:16]))
    assert result.verdict == "unknown"


def test_one_subject_block_in_another_order_is_held():
    # 16 Physics questions in order, 8 Biology questions in another order: 67% match overall, but the
    # Biology block on its own is another version.
    prompts = QUESTIONS + OTHER_PAPER[:8]
    content = rubric(prompts)
    for q in content["questions"]:
        q["subject"] = "Physics" if q["question"] <= 16 else "Biology"
    sheet_order = QUESTIONS + shuffled(OTHER_PAPER[:8])
    result = paper_match.compare(stems(sheet_order), content)
    assert result.verdict == "reordered" and " in Biology " in result.message
