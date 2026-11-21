"""Deterministic marking rules (FR-3.8 marking schemes, FR-4.8 MCQ negative marking).

Pure module: imports only math, re, typing and bloom (never schemas, database, analytics or
insights). insights.build_evaluation_report scores every question through here, so the same
inputs always give the same marks and the LLM never decides a total:

* MCQs are scored by option letter only (+max correct, -negative_marks wrong or multi-marked,
  0 blank or unreadable). The grading model never sees them.
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
# Per-question rubric fields that make a rubric "non-default" for marking_rule_text.
_MARKING_FIELDS = ("marking_scheme", "partial_credit", "mark_step", "negative_marks")

_TRIM = " .,;:!?-–—()[]{}'\""
_PREFIX = re.compile(
    r"^(?:the\s+)?(?:correct\s+)?(?:answer|ans|option|opt|choice)\s*(?:is\s*)?[:.\-=]?\s*", re.IGNORECASE
)
_SINGLE = re.compile(r"[\(\[]?\s*([a-f]|[1-6])\s*[\)\]\.]?")
_LIST_SEP = re.compile(r"\s*(?:,|/|&|\+|;|\band\b|\bor\b)\s*|\s+")
_LEADING = re.compile(r"^[\(\[]?\s*([a-f]|[1-6])\s*(?:[\)\]]\s*[.:\-–—]?|\.|\s*[-–—:])\s*(.+)$")


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


def normalise_option(raw: Any, n_options: int | None = None) -> str | None:
    """A letter A-F, MULTI (two or more different options), UNKNOWN (unreadable / out of range)
    or None (blank). Accepts 'b', '(B)', 'b)', 'b.', '[b]', 'option b', 'ans: d', 'answer: b',
    'b - mitochondria', '(b) mitochondria' and digits 1-6."""
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
    parts = [p for p in _LIST_SEP.split(body) if p and p.strip()]
    if len(parts) >= 2:
        tokens = [_single(p) for p in parts]
        if all(t is not None for t in tokens):
            letters = {_to_letter(t, n_options) for t in tokens if t is not None}
            if len(letters) >= 2:
                return MULTI
            return letters.pop()
    if re.fullmatch(r"[a-f]{2,6}", body):
        letters = {_to_letter(ch, n_options) for ch in body}
        return MULTI if len(letters) >= 2 else letters.pop()
    leading = _LEADING.match(body)
    if leading:
        return _to_letter(leading.group(1), n_options)
    return UNKNOWN


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
    """{marks, penalty, selected_option, correct_option, note} for one MCQ."""
    qp = question_policy(question, policy)
    max_marks = _number(question.get("max_marks")) or 0.0
    neg = float(qp["negative_marks"])
    options = question.get("options") if isinstance(question.get("options"), list) else []
    n_options = len(options) or None
    correct = normalise_option(question.get("correct_option"), n_options)
    correct = correct if correct not in (None, MULTI, UNKNOWN) else None
    selected = normalise_option(answer_text, n_options)

    if selected is None:
        return {"marks": 0.0, "penalty": 0.0, "selected_option": None, "correct_option": correct,
                "note": "Not attempted (0)"}
    if selected == UNKNOWN:
        return {"marks": 0.0, "penalty": 0.0, "selected_option": UNKNOWN, "correct_option": correct,
                "note": "Option not identifiable - no penalty applied; check the sheet"}
    if selected == MULTI:
        return {"marks": _clean(-neg), "penalty": _clean(neg), "selected_option": MULTI, "correct_option": correct,
                "note": f"More than one option marked - scored as wrong ({_signed(-neg)})"}
    if correct is not None and selected == correct:
        return {"marks": _clean(max_marks), "penalty": 0.0, "selected_option": selected, "correct_option": correct,
                "note": f"Correct option {correct} ({_signed(max_marks)})"}
    return {"marks": _clean(-neg), "penalty": _clean(neg), "selected_option": selected, "correct_option": correct,
            "note": f"Marked {selected}, correct {correct or '?'} ({_signed(-neg)})"}


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
    penalty 0, demonstrated_level None, marking_breakdown [], marking_note None."""
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
            correct = normalise_option(rq.get("correct_option"), len(options) or None)
            item.setdefault("correct_option", correct if correct not in (MULTI, UNKNOWN) else None)
            item.setdefault("selected_option", normalise_option(item.get("student_answer"), len(options) or None))
        else:
            item.setdefault("correct_option", None)
            item.setdefault("selected_option", None)
        item.setdefault("penalty", 0.0)
        item.setdefault("demonstrated_level", None)
        item.setdefault("marking_breakdown", [])
        item.setdefault("marking_note", None)
        out.append(item)
    return out
