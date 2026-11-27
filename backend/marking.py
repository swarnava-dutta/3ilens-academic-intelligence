"""Deterministic marking rules (FR-3.8 marking schemes, FR-4.8 MCQ negative marking).

Pure module: imports only math, re, typing and bloom (never schemas, database, analytics or
insights). insights.build_evaluation_report scores every question through here, so the same
inputs always give the same marks and the LLM never decides a total:

* MCQs are scored by option letter only (+max correct, -negative_marks wrong or multi-marked,
  0 blank or unreadable). The grading model never sees them. A key may accept several options
  (accepted_options: any of them scores full marks) or make the question a bonus (bonus: full
  marks to every student, whatever they marked).
* Descriptive questions keep the default rule (clamp, round half-up to 0.5) unless the rubric
  sets a marking policy, a per-question mode or a per-step marking scheme.
"""
from __future__ import annotations

import math
import re
from typing import Any

import bloom

OPTION_LETTERS = "ABCDEF"
MULTI = "MULTI"
UNKNOWN = "UNKNOWN"
BLANK_TOKENS = {
    "", "-", "--", "na", "n/a", "none", "nil", "skip", "skipped", "not attempted", "unattempted", "blank",
    "[illegible]", "illegible", "?",
}
PARTIAL_CREDIT_MODES = ("steps", "proportional", "all_or_nothing")
MARK_STEPS = (0.25, 0.5, 1.0, 2.0)
DEFAULT_POLICY: dict[str, Any] = {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 0.0, "scheme_name": None}
# Must equal analytics.MARKING_RULE (the default text, pinned by tests).
DEFAULT_MARKING_RULE = "Partial credit in 0.5-mark steps, clamped to each question max; totals summed server-side"
REQUIRED_STEP_SHARE = 0.5
# A rubric is "MCQ-heavy" (a printed objective paper, read by the tick reader) when at least this
# share of at least this many questions are MCQs.
MCQ_HEAVY_SHARE = 0.8
MCQ_HEAVY_MIN_QUESTIONS = 10
# Per-question rubric fields that make a rubric "non-default" for marking_rule_text.
_MARKING_FIELDS = ("marking_scheme", "partial_credit", "mark_step", "negative_marks")

_TRIM = " .,;:!?-–—()[]{}'\""
_PREFIX = re.compile(
    r"^(?:the\s+)?(?:correct\s+)?(?:answer|ans|option|opt|choice)\s*(?:is\s*)?[:.\-=]?\s*", re.IGNORECASE
)
_SINGLE = re.compile(r"[\(\[]?\s*([a-f]|[1-6])\s*[\)\]\.]?")
_LIST_SEP = re.compile(r"\s*(?:,|/|&|\+|;|\band\b|\bor\b)\s*|\s+")
_LEADING = re.compile(r"^[\(\[]?\s*([a-f]|[1-6])\s*(?:[\)\]]\s*[.:\-–—]?|\.|\s*[-–—:])\s*(.+)$")
# Option tokens written back to back with no separator: '(2)(3)', '(b)(c)', 'b)c)', '[a][d]'.
_ADJACENT = re.compile(r"(?:[\(\[]?(?:[a-f]|[1-6])[\)\]]){2,6}")
_ADJACENT_TOKEN = re.compile(r"[\(\[]?([a-f]|[1-6])[\)\]]")
BONUS_NOTE = "Bonus question - full marks to everyone"
BONUS_ANSWER = "Bonus question"
# Answer-key entries that make a question a bonus (dropped, or every option accepted).
_BONUS_TOKENS = {"*", "**", "***", "all", "any", "full marks", "full marks to all", "marks to all"}
# 'all options', 'all correct', 'all options correct', 'all are correct', 'any option is correct',
# 'all of the options are correct', 'all 4 options correct' (never 'all of the above': an option text)
_ALL_OPTIONS = re.compile(
    r"(?:all|any|every)(?:\s+of)?(?:\s+the)?(?:\s+(?:four|4))?(?:\s+(?:options?|answers?|choices?))?"
    r"(?:\s+(?:are|is))?(?:\s+(?:correct|right|accepted|valid))?"
)
_BONUS_WORDS = frozenset({"bonus", "grace", "dropped", "deleted", "cancelled", "canceled", "withdrawn"})
# Words that may sit next to a bonus word in a key cell ('4 or bonus', 'Bonus - marks to all', 'Q dropped').
# Anything else ('(b) dropped object') means the cell is an option and its text, never a bonus.
_BONUS_FILLER = frozenset({
    "or", "and", "question", "q", "marks", "mark", "to", "all", "everyone", "full", "given", "awarded", "is",
    "be", "will", "for", "the", "candidates", "students", "this",
})
_BONUS_WORD_TOKEN = re.compile(r"[a-z]+|\d+|\*+")


# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #
def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _valid_step(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and any(abs(number - s) < 1e-9 for s in MARK_STEPS) else None


def policy_for(rubric_content: dict[str, Any] | None) -> dict[str, Any]:
    """DEFAULT_POLICY overlaid with the valid keys of rubric_content['marking_policy']."""
    policy = dict(DEFAULT_POLICY)
    raw = (rubric_content or {}).get("marking_policy") if isinstance(rubric_content, dict) else None
    if not isinstance(raw, dict):
        return policy
    if raw.get("partial_credit") in PARTIAL_CREDIT_MODES:
        policy["partial_credit"] = raw["partial_credit"]
    step = _valid_step(raw.get("mark_step"))
    if step is not None:
        policy["mark_step"] = step
    neg = _number(raw.get("negative_marks"))
    if neg is not None and neg >= 0:
        policy["negative_marks"] = neg
    name = " ".join(str(raw.get("scheme_name") or "").split())
    if name:
        policy["scheme_name"] = name
    return policy


def question_policy(question: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    """The policy for one question: per-question partial_credit / mark_step override the rubric
    policy; negative_marks from the question when present, clamped to [0, max_marks]."""
    out = dict(policy)
    if question.get("partial_credit") in PARTIAL_CREDIT_MODES:
        out["partial_credit"] = question["partial_credit"]
    step = _valid_step(question.get("mark_step"))
    if step is not None:
        out["mark_step"] = step
    neg = _number(question.get("negative_marks"))
    if neg is None:
        neg = _number(policy.get("negative_marks")) or 0.0
    max_marks = _number(question.get("max_marks")) or 0.0
    out["negative_marks"] = min(max(neg, 0.0), max(max_marks, 0.0))
    return out


def question_type(question: dict[str, Any] | None) -> str:
    """'mcq' or 'descriptive'."""
    raw = str((question or {}).get("question_type") or "").strip().casefold() if isinstance(question, dict) else ""
    return "mcq" if raw == "mcq" else "descriptive"


# --------------------------------------------------------------------------- #
# Option letters
# --------------------------------------------------------------------------- #
def _to_letter(token: str, n_options: int | None) -> str:
    """'b' / '2' -> 'B' (UNKNOWN when beyond n_options)."""
    if token.isdigit():
        index = int(token) - 1
    else:
        index = OPTION_LETTERS.index(token.upper())
    if n_options is not None and index >= n_options:
        return UNKNOWN
    return OPTION_LETTERS[index]


def _single(token: str) -> str | None:
    match = _SINGLE.fullmatch(_PREFIX.sub("", token.strip(), count=1).strip())
    return match.group(1) if match else None


def _list_tokens(body: str) -> list[str] | None:
    """The option tokens of a body that names two or more options and nothing else: '2 or 3',
    'b/c', '(a), (d)', 'bc', and tokens written back to back - '(2)(3)', '(b)(c)', 'b)c)'; None
    otherwise ('(b) mitochondria' is one option and its text, read by _LEADING)."""
    body = body.strip().rstrip(".,;:!?")  # '(2) (3).' and '(2)(3),' name the same options
    if re.fullmatch(r"[a-f]{2,6}", body):
        return list(body)
    tokens: list[str] = []
    for part in (p.rstrip(".,;:") for p in _LIST_SEP.split(body) if p and p.strip()):
        one = _single(part)
        if one is not None:
            tokens.append(one)
        elif _ADJACENT.fullmatch(part):
            tokens.extend(_ADJACENT_TOKEN.findall(part))
        else:
            return None
    return tokens if len(tokens) >= 2 else None


def normalise_option(raw: Any, n_options: int | None = None) -> str | None:
    """A letter A-F, MULTI (two or more different options), UNKNOWN (unreadable / out of range)
    or None (blank). Accepts 'b', '(B)', 'b)', 'b.', '[b]', 'option b', 'ans: d', 'answer: b',
    'b - mitochondria', '(b) mitochondria' and digits 1-6; two or more options ('b, c', '2 or 3',
    and tokens back to back: '(2)(3)', 'b)c)') are MULTI."""
    if raw is None:
        return None
    text = " ".join(str(raw).split()).casefold()
    if text in BLANK_TOKENS or text.strip(_TRIM) in BLANK_TOKENS:
        return None
    if n_options is not None and n_options <= 0:
        n_options = None
    body = _PREFIX.sub("", text, count=1).strip()

    token = _single(body)
    if token is not None:
        return _to_letter(token, n_options)
    tokens = _list_tokens(body)
    if tokens:
        letters = {_to_letter(t, n_options) for t in tokens}
        return MULTI if len(letters) >= 2 else letters.pop()
    leading = _LEADING.match(body)
    if leading:
        return _to_letter(leading.group(1), n_options)
    return UNKNOWN


def option_letters(raw: Any, n_options: int | None = None) -> list[str]:
    """Every option letter raw names, distinct and in letter order: 'b' -> ['B'], '2 or 3' ->
    ['B', 'C'], '(a), (d)' -> ['A', 'D'], '(2)(3)' -> ['B', 'C']; [] when raw is blank, unreadable
    or names an option beyond n_options. Same token rules as normalise_option."""
    single = normalise_option(raw, n_options)
    if single is None or single == UNKNOWN:
        return []
    if single != MULTI:
        return [single]
    if n_options is not None and n_options <= 0:
        n_options = None
    body = _PREFIX.sub("", " ".join(str(raw).split()).casefold(), count=1).strip()
    letters = {_to_letter(t, n_options) for t in _list_tokens(body) or []}
    return [] if not letters or UNKNOWN in letters else sorted(letters)


def is_bonus_key(raw: Any) -> bool:
    """An answer-key entry that makes the question a bonus (full marks to everyone): 'Bonus',
    '*', 'Dropped', 'Deleted', 'Cancelled', 'Grace', 'All options correct', 'All are correct',
    'Any option'. Shared by parse_answer_key and the AI rubric draft (ai._draft_key)."""
    if raw is None or isinstance(raw, bool):
        return False
    text = " ".join(str(raw).split())
    if not text:
        return False
    if text in _BONUS_TOKENS:
        return True
    plain = text.casefold().strip(_TRIM)
    plain = _PREFIX.sub("", plain, count=1).strip(_TRIM) or plain
    if plain in _BONUS_TOKENS or _ALL_OPTIONS.fullmatch(plain) is not None:
        return True
    words = _BONUS_WORD_TOKEN.findall(plain)
    if not any(word in _BONUS_WORDS for word in words):
        return False
    return all(
        word in _BONUS_WORDS or word in _BONUS_FILLER or re.fullmatch(r"[a-f]|[1-6]|\*+", word) is not None
        for word in words
    )


def parse_answer_key(raw: Any, n_options: int | None = None) -> dict[str, Any] | None:
    """One answer-key entry -> {'correct_option': 'B'}, {'accepted_options': ['B', 'C']} (the key
    accepts two or more options: '2 or 3', 'B/C', '(1), (3)', '(2)(3)') or {'bonus': True}
    (is_bonus_key: 'Bonus', '*', 'dropped', 'All options correct'); None when it names no option."""
    if raw is None or isinstance(raw, bool):
        return None
    text = " ".join(str(raw).split())
    if is_bonus_key(text):
        return {"bonus": True}
    letters = option_letters(text, n_options)
    if len(letters) == 1:
        return {"correct_option": letters[0]}
    if len(letters) >= 2:
        return {"accepted_options": letters}
    return None


def is_bonus(question: dict[str, Any] | None) -> bool:
    """The rubric makes this MCQ a bonus: full marks to every student."""
    return isinstance(question, dict) and question.get("bonus") is True


def bonus_note(item: dict[str, Any] | None) -> bool:
    """A stored question evaluation scored by a bonus key: an MCQ whose marking_note starts with
    BONUS_NOTE (score_mcq writes it for every bonus question)."""
    return (
        isinstance(item, dict) and item.get("question_type", "mcq") == "mcq"
        and str(item.get("marking_note") or "").startswith(BONUS_NOTE)
    )


def bonus_scored(item: dict[str, Any] | None) -> bool:
    """A stored question evaluation scored by a bonus key at full marks (bonus_note): it counts as
    full credit (outcome FULL) even when the sheet left it blank."""
    if not isinstance(item, dict) or not bonus_note(item):
        return False
    marks, max_marks = _number(item.get("estimated_marks")), _number(item.get("max_marks"))
    return marks is not None and max_marks is not None and max_marks > 0 and marks >= max_marks


def accepted_options(question: dict[str, Any] | None, n_options: int | None = None) -> list[str]:
    """The letters an MCQ's key accepts when it accepts two or more options (letter order);
    [] when the key names one option (correct_option) or none."""
    raw = question.get("accepted_options") if isinstance(question, dict) else None
    if not isinstance(raw, list):
        return []
    letters = {
        letter for entry in raw
        if (letter := normalise_option(entry, n_options)) not in (None, MULTI, UNKNOWN)
    }
    return sorted(letters) if len(letters) >= 2 else []


def or_join(letters: list[str]) -> str:
    """['B', 'C'] -> 'B or C'; ['A', 'B', 'C'] -> 'A, B or C'."""
    if len(letters) <= 1:
        return "".join(letters)
    return f"{', '.join(letters[:-1])} or {letters[-1]}"


def plural(count: Any, word: str, plural: str | None = None) -> str:
    """'1 question', '3 questions'; an irregular plural is passed in: plural(2, 'copy', 'copies')."""
    return f"{count} {word if count == 1 else plural or word + 's'}"


def _correct_letter(question: dict[str, Any], n_options: int | None) -> str | None:
    correct = normalise_option(question.get("correct_option"), n_options)
    return correct if correct not in (None, MULTI, UNKNOWN) else None


def key_label(question: dict[str, Any] | None, n_options: int | None = None) -> str | None:
    """How the MCQ's key reads: 'B or C' (accepted options), 'B' (correct_option), None (no
    key). A bonus question keeps the label of any key it also carries."""
    if not isinstance(question, dict):
        return None
    accepted = accepted_options(question, n_options)
    return or_join(accepted) if accepted else _correct_letter(question, n_options)


def mcq_expected_answer(question: dict[str, Any] | None, n_options: int | None = None) -> str | None:
    """The expected_answer of an MCQ key: 'Bonus question', 'Option B or C', 'Option B'; None
    when the question has no key."""
    if is_bonus(question):
        return BONUS_ANSWER
    label = key_label(question, n_options)
    return f"Option {label}" if label else None


def has_key(question: dict[str, Any] | None, n_options: int | None = None) -> bool:
    """The MCQ can be scored: a correct option, two or more accepted options, or a bonus."""
    return is_bonus(question) or key_label(question, n_options) is not None


def accepted_letters(question: dict[str, Any] | None, n_options: int | None = None) -> list[str]:
    """Every option letter the MCQ's key accepts, in letter order: ['B', 'C'] for a key that accepts
    B or C, ['B'] for correct_option B, [] without a key (a bonus keeps any key it also carries)."""
    if not isinstance(question, dict):
        return []
    accepted = accepted_options(question, n_options)
    if accepted:
        return accepted
    correct = _correct_letter(question, n_options)
    return [correct] if correct is not None else []


RESULT_KINDS = ("right", "wrong", "blank", "bonus", "partial", "zero")


def result_kind(item: dict[str, Any] | None) -> str:
    """How a stored question evaluation reads to a student (one vocabulary everywhere):
    MCQ - 'bonus' (the key made it a bonus), 'blank' (no option marked, or none readable: no marks,
    no penalty), 'right' (full marks), else 'wrong' (a wrong or multi-marked option);
    descriptive - 'blank', 'right' (full marks), 'zero' or 'partial'."""
    if not isinstance(item, dict):
        return "blank"
    answer = str(item.get("student_answer") or "").strip()
    marks, max_marks = _number(item.get("estimated_marks")) or 0.0, _number(item.get("max_marks")) or 0.0
    if str(item.get("question_type") or "").casefold() == "mcq":
        if item.get("bonus") is True or bonus_note(item):
            return "bonus"
        selected = item.get("selected_option") if "selected_option" in item else normalise_option(answer)
        if not answer or selected is None or selected == UNKNOWN:
            return "blank"
        if max_marks > 0 and marks >= max_marks:
            return "right"
        return "wrong"
    if not answer:
        return "blank"
    if max_marks > 0 and marks >= max_marks:
        return "right"
    return "zero" if marks <= 0 else "partial"


def shown_correct_option(question: dict[str, Any], selected: str | None, n_options: int | None = None) -> str | None:
    """The correct_option reported on a question evaluation: the student's own option when it
    scored full marks (one of the accepted options, or any option of a bonus question), else the
    rubric's correct_option, else the first accepted option; None without a key."""
    accepted = accepted_options(question, n_options)
    if selected not in (None, MULTI, UNKNOWN) and (is_bonus(question) or selected in accepted):
        return selected
    correct = _correct_letter(question, n_options)
    return correct if correct is not None else (accepted[0] if accepted else None)


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def _fmt(value: float) -> str:
    rounded = round(float(value), 2)
    if rounded.is_integer():
        return str(int(rounded))
    return f"{rounded:.2f}".rstrip("0").rstrip(".")


def _signed(value: float) -> str:
    if value > 0:
        return f"+{_fmt(value)}"
    if value < 0:
        return f"-{_fmt(-value)}"
    return "0"


def _clean(value: float) -> float:
    out = float(round(float(value), 4))
    return 0.0 if out == 0 else out  # no -0.0


def round_to_step(value: float, step: float) -> float:
    """Nearest multiple of step, half up: floor(value / step + 0.5) * step, rounded to 4 dp."""
    if not step or step <= 0:
        return _clean(value)
    return _clean(math.floor(float(value) / step + 0.5) * step)


def score_mcq(question: dict[str, Any], answer_text: Any, policy: dict[str, Any]) -> dict[str, Any]:
    """{marks, penalty, selected_option, correct_option, note} for one MCQ. A bonus question scores
    full marks whatever was marked (blank too); with accepted_options any accepted option scores
    full marks and everything else follows the usual wrong / multi / blank rules. correct_option
    is shown_correct_option (the student's option when it scored full marks)."""
    qp = question_policy(question, policy)
    max_marks = _number(question.get("max_marks")) or 0.0
    neg = float(qp["negative_marks"])
    options = question.get("options") if isinstance(question.get("options"), list) else []
    n_options = len(options) or None
    selected = normalise_option(answer_text, n_options)
    correct = shown_correct_option(question, selected, n_options)
    letters = accepted_letters(question, n_options)

    def out(marks: float, penalty: float, chosen: str | None, note: str) -> dict[str, Any]:
        return {"marks": marks, "penalty": penalty, "selected_option": chosen, "correct_option": correct,
                "accepted_options": list(letters), "note": note}

    if is_bonus(question):
        return out(_clean(max_marks), 0.0, selected, f"{BONUS_NOTE} ({_signed(max_marks)})")
    if selected is None:
        return out(0.0, 0.0, None, "Not attempted (0)")
    if selected == UNKNOWN:
        return out(0.0, 0.0, UNKNOWN, "Option not identifiable - no penalty applied; check the sheet")
    if selected == MULTI:
        return out(_clean(-neg), _clean(neg), MULTI, f"More than one option marked - scored as wrong ({_signed(-neg)})")
    accepted = accepted_options(question, n_options)
    if accepted:
        if selected in accepted:
            return out(_clean(max_marks), 0.0, selected, f"Accepted options {or_join(accepted)} ({_signed(max_marks)})")
        return out(_clean(-neg), _clean(neg), selected, f"Marked {selected}, accepted {or_join(accepted)} ({_signed(-neg)})")
    if correct is not None and selected == correct:
        return out(_clean(max_marks), 0.0, selected, f"Correct option {correct} ({_signed(max_marks)})")
    return out(_clean(-neg), _clean(neg), selected, f"Marked {selected}, correct {correct or '?'} ({_signed(-neg)})")


def _awards_by_index(criteria_awards: list[Any] | None) -> dict[int, float]:
    out: dict[int, float] = {}
    for raw in criteria_awards or []:
        data = raw.model_dump() if hasattr(raw, "model_dump") else raw
        if not isinstance(data, dict):
            continue
        index = data.get("index")
        if isinstance(index, bool) or not isinstance(index, (int, float)) or int(index) != index:
            continue
        awarded = _number(data.get("awarded"))
        if awarded is None or int(index) in out:
            continue
        out[int(index)] = awarded
    return out


def score_descriptive(
    question: dict[str, Any],
    *,
    estimated_marks: Any,
    criteria_awards: list[Any] | None,
    policy: dict[str, Any],
) -> dict[str, Any]:
    """{marks, breakdown, note} for a descriptive question. With the default policy and no
    scheme this equals insights._bounded_marks(estimated_marks, max_marks)."""
    qp = question_policy(question, policy)
    max_marks = _number(question.get("max_marks")) or 0.0
    mode, step = qp["partial_credit"], float(qp["mark_step"])
    scheme = [s for s in (question.get("marking_scheme") or []) if isinstance(s, dict)]
    awards = _awards_by_index(criteria_awards)
    estimate = _number(estimated_marks) or 0.0
    breakdown: list[dict[str, Any]] = []
    note: str | None = None

    if scheme and awards:
        total = 0.0
        unmet: str | None = None
        for index, item in enumerate(scheme):
            step_marks = _number(item.get("marks")) or 0.0
            required = bool(item.get("required"))
            awarded = min(max(awards.get(index, 0.0), 0.0), step_marks)
            awarded = round_to_step(awarded, step) if mode == "steps" else round(awarded, 2)
            awarded = _clean(min(max(awarded, 0.0), step_marks))
            criterion = " ".join(str(item.get("criterion") or "").split()) or f"Step {index + 1}"
            breakdown.append({"criterion": criterion, "marks": _clean(step_marks), "awarded": awarded,
                              "required": required})
            total += awarded
            if required and unmet is None and awarded < REQUIRED_STEP_SHARE * step_marks:
                unmet = criterion
        if unmet is not None:
            total = 0.0
            note = f"Required step '{unmet}' not met -> 0"
    elif scheme:
        total = estimate
        note = "Marking scheme present but no per-step awards were returned - overall marks used"
    else:
        total = estimate

    total = min(max(total, 0.0), max_marks)
    if mode == "steps":
        total = min(max(round_to_step(total, step), 0.0), max_marks)
    elif mode == "proportional":
        total = round(total, 2)
    elif mode == "all_or_nothing":
        if total >= max_marks - 1e-9:
            total = max_marks
        else:
            if total > 0 and note is None:
                note = f"All-or-nothing: {_fmt(total)}/{_fmt(max_marks)} -> 0"
            total = 0.0
    return {"marks": _clean(total), "breakdown": breakdown, "note": note}


def score_question(
    question: dict[str, Any],
    *,
    answer_text: Any,
    estimated_marks: Any,
    criteria_awards: list[Any] | None,
    policy: dict[str, Any],
) -> dict[str, Any]:
    """{marks, penalty, question_type, selected_option, correct_option, breakdown, note}."""
    if question_type(question) == "mcq":
        s = score_mcq(question, answer_text, policy)
        return {"marks": s["marks"], "penalty": s["penalty"], "question_type": "mcq",
                "selected_option": s["selected_option"], "correct_option": s["correct_option"],
                "breakdown": [], "note": s["note"]}
    s = score_descriptive(question, estimated_marks=estimated_marks, criteria_awards=criteria_awards, policy=policy)
    return {"marks": s["marks"], "penalty": 0.0, "question_type": "descriptive", "selected_option": None,
            "correct_option": None, "breakdown": s["breakdown"], "note": s["note"]}


# --------------------------------------------------------------------------- #
# Human-readable rules
# --------------------------------------------------------------------------- #
def _mode_text(mode: str, step: float) -> str:
    if mode == "proportional":
        return "Proportional partial credit (2 dp)"
    if mode == "all_or_nothing":
        return "All-or-nothing"
    return f"Partial credit in {_fmt(step)}-mark steps"


def rule_for_question(question: dict[str, Any], policy: dict[str, Any]) -> str:
    """'+4 correct / -1 wrong / 0 blank', 'Partial credit in 0.5-mark steps', 'All-or-nothing',
    'Steps 1+1+1+1 (step 1 required)'."""
    qp = question_policy(question, policy)
    max_marks = _number(question.get("max_marks")) or 0.0
    if question_type(question) == "mcq":
        if is_bonus(question):
            return f"Bonus question: {_signed(max_marks)} to everyone"
        accepted = accepted_options(question)
        if accepted:
            return f"{_signed(max_marks)} for {or_join(accepted)} / {_signed(-qp['negative_marks'])} wrong / 0 blank"
        return f"{_signed(max_marks)} correct / {_signed(-qp['negative_marks'])} wrong / 0 blank"
    scheme = [s for s in (question.get("marking_scheme") or []) if isinstance(s, dict)]
    if scheme:
        text = "Steps " + "+".join(_fmt(_number(s.get("marks")) or 0) for s in scheme)
        required = [str(i + 1) for i, s in enumerate(scheme) if s.get("required")]
        if required:
            text += f" (step{'s' if len(required) > 1 else ''} {', '.join(required)} required)"
        if qp["partial_credit"] == "all_or_nothing":
            text += ", all-or-nothing"
        return text
    return _mode_text(qp["partial_credit"], qp["mark_step"])


def _ranges(numbers: list[int]) -> str:
    """[25, 26, 28] -> 'Q25-Q26, Q28'."""
    numbers = sorted(set(numbers))
    parts: list[str] = []
    start = prev = None
    for n in numbers + [None]:  # type: ignore[list-item]
        if n is not None and prev is not None and n == prev + 1:
            prev = n
            continue
        if start is not None:
            parts.append(f"Q{start}" if start == prev else f"Q{start}-Q{prev}")
        start = prev = n
    return ", ".join(parts)


def _questions(rubric_content: dict[str, Any] | None) -> list[dict[str, Any]]:
    raw = (rubric_content or {}).get("questions") if isinstance(rubric_content, dict) else None
    return [q for q in raw or [] if isinstance(q, dict)]


def _qnum(question: dict[str, Any]) -> int | None:
    try:
        return int(question.get("question"))
    except (TypeError, ValueError):
        return None


def mcq_heavy(rubric_content: dict[str, Any] | None) -> bool:
    """At least 10 questions and at least 80% of them MCQs (a printed objective paper)."""
    questions = _questions(rubric_content)
    if len(questions) < MCQ_HEAVY_MIN_QUESTIONS:
        return False
    mcqs = sum(1 for q in questions if question_type(q) == "mcq")
    return mcqs / len(questions) >= MCQ_HEAVY_SHARE


def mcq_option_counts(rubric_content: dict[str, Any] | None) -> dict[int, int | None]:
    """MCQ number -> its number of options (None when the rubric lists none)."""
    out: dict[int, int | None] = {}
    for question in _questions(rubric_content):
        number = _qnum(question)
        if number is not None and question_type(question) == "mcq":
            options = question.get("options") if isinstance(question.get("options"), list) else []
            out[number] = len(options) or None
    return out


def marking_rule_text(rubric_content: dict[str, Any] | None) -> str:
    """DEFAULT_MARKING_RULE for rubrics without MCQs or a policy; otherwise a composed sentence, scheme name first."""
    questions = _questions(rubric_content)
    has_policy = isinstance((rubric_content or {}).get("marking_policy"), dict)
    mcqs = [q for q in questions if question_type(q) == "mcq"]
    special = any(q.get(f) is not None for q in questions for f in _MARKING_FIELDS)
    if not has_policy and not mcqs and not special:
        return DEFAULT_MARKING_RULE
    policy = policy_for(rubric_content)
    parts: list[str] = []
    if mcqs:
        variants = {
            (_number(q.get("max_marks")) or 0.0, question_policy(q, policy)["negative_marks"]) for q in mcqs
        }
        if len(variants) == 1:
            max_marks, neg = variants.pop()
            parts.append(f"MCQs {_signed(max_marks)} correct, {_signed(-neg)} wrong, 0 blank")
        else:
            parts.append("MCQs scored per question (+marks correct, -negative marks wrong, 0 blank)")
        multi = [n for q in mcqs if not is_bonus(q) and accepted_options(q) and (n := _qnum(q)) is not None]
        if multi:
            parts.append(f"{_ranges(multi)} accept{'s' if len(multi) == 1 else ''} more than one option")
        bonus = [n for q in mcqs if is_bonus(q) and (n := _qnum(q)) is not None]
        if bonus:
            parts.append(f"bonus {_ranges(bonus)}: full marks to everyone")
    descriptive = [q for q in questions if question_type(q) != "mcq"]
    if descriptive:
        parts.append("descriptive " + _mode_text(policy["partial_credit"], policy["mark_step"]).lower())
        with_scheme = [n for q in descriptive if q.get("marking_scheme") and (n := _qnum(q)) is not None]
        overrides = []
        for q in descriptive:
            n = _qnum(q)
            if n is None:
                continue
            qp = question_policy(q, policy)
            if (qp["partial_credit"], qp["mark_step"]) != (policy["partial_credit"], policy["mark_step"]):
                overrides.append(f"Q{n} {_mode_text(qp['partial_credit'], qp['mark_step']).lower()}")
        if with_scheme:
            text = f"marking schemes on {_ranges(with_scheme)}"
            if overrides:
                text += f" ({', '.join(overrides)})"
            parts.append(text)
        elif overrides:
            parts.append(f"per-question rules: {', '.join(overrides)}")
    parts.append("totals summed server-side")
    sentence = "; ".join(parts)
    return f"{policy['scheme_name']}: {sentence}" if policy.get("scheme_name") else sentence[:1].upper() + sentence[1:]


# --------------------------------------------------------------------------- #
# Read-side annotation (legacy and seeded rows)
# --------------------------------------------------------------------------- #
def annotate_questions(items: list[dict[str, Any]], rubric_content: dict[str, Any] | None) -> list[dict[str, Any]]:
    """NEW dicts with the v3 question keys filled where MISSING (never re-scores):
    question_type, bloom_level/bloom_source, concept, correct_option and selected_option (MCQ),
    accepted_options (every letter the key accepts), penalty 0, demonstrated_level None,
    marking_breakdown [], marking_note None; result_kind is always recomputed (result_kind())."""
    by_number = {n: q for q in _questions(rubric_content) if (n := _qnum(q)) is not None}
    levels = bloom.resolve_levels(rubric_content)
    out: list[dict[str, Any]] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        try:
            number = int(item.get("question"))
        except (TypeError, ValueError):
            number = None
        rq = by_number.get(number) if number is not None else None
        qtype = question_type(rq)
        item.setdefault("question_type", qtype)
        level, source = levels.get(number, (None, None)) if number is not None else (None, None)
        if "bloom_level" not in item:
            item["bloom_level"] = level
            item["bloom_source"] = source
        item.setdefault("bloom_source", source if item.get("bloom_level") else None)
        item.setdefault("concept", bloom.concept_key(rq) if rq else (" ".join(str(item.get("topic") or "").split()) or None))
        options = rq.get("options") if rq and isinstance(rq.get("options"), list) else []
        if qtype == "mcq" and rq is not None:
            n_options = len(options) or None
            selected = (item["selected_option"] if "selected_option" in item
                        else normalise_option(item.get("student_answer"), n_options))
            item.setdefault("correct_option", shown_correct_option(rq, selected, n_options))
            item.setdefault("selected_option", selected)
            if not isinstance(item.get("accepted_options"), list):
                item["accepted_options"] = accepted_letters(rq, n_options) or (
                    [item["correct_option"]] if item.get("correct_option") else []
                )
        else:
            item.setdefault("correct_option", None)
            item.setdefault("selected_option", None)
            if not isinstance(item.get("accepted_options"), list):
                item["accepted_options"] = [item["correct_option"]] if item.get("correct_option") else []
        item.setdefault("penalty", 0.0)
        item.setdefault("demonstrated_level", None)
        item.setdefault("marking_breakdown", [])
        item.setdefault("marking_note", None)
        item["result_kind"] = result_kind(item)  # derived, never stored grading: always current rules
        out.append(item)
    return out
