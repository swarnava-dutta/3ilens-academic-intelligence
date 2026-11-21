"""Deterministic Insights & Preparation ROI engine (Section 3, step 6). No AI calls.

Everything here is pure Python over the rubric, the OCR answers and the LLM grades, so
the same inputs always give the same report (seed.py also uses it for synthetic data).

* Marks: clamped to [0, max_marks] and rounded to the nearest 0.5; totals are summed
  here - LLM totals are never trusted. Wave 2: every question is scored through marking.py -
  MCQs by option letter (+max / -negative_marks / 0, the grader's marks are ignored),
  descriptive questions by the rubric's marking policy and per-step marking scheme. A wrong MCQ
  can make a total negative; mastery percentages are clamped to 0-100.
* Topic weightage = subject weight x topic marks / assessed marks of that subject
  (NEET subject weights: Physics 0.25, Chemistry 0.25, Biology 0.50).
* Preparation ROI (BRD formula) = weightage x gain_potential / effort_hours, where
  gain_potential = 100 - mastery. Mastered topics (>= 90%) are excluded; top 5 by ROI.
* Narrative (contract v2): per-question outcome (FULL / PARTIAL / ZERO / BLANK), topic
  outcome counts, a teach / practice / check intervention per priority (the AI's when it
  gave one, else a template built from the first missed grading criterion), 2-3 teaching
  nudges (AI, topped up from the priorities when the AI gave fewer than 2) and at most 3
  concept confusions. The helpers below also work on stored dicts, so analytics.py can
  fill the same fields for rows written by older builds.
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import Any

import bloom
import marking
from ai_schemas import EvaluationOutput, OcrAnswer

SUBJECT_WEIGHTS: dict[str, float] = {"Physics": 0.25, "Chemistry": 0.25, "Biology": 0.50}

MASTERED_THRESHOLD = 90.0
MAX_PRIORITIES = 5
MAX_INSIGHTS = 3
MIN_INSIGHTS = 2

MAX_NUDGES = 3
MIN_NUDGES = 2
MAX_NUDGE_LABEL_WORDS = 6
MAX_CONFUSIONS = 3
MAX_INTERVENTIONS = 5
MAX_UNCERTAIN_WORDS = 8
MAX_EVIDENCE_CHARS = 300

NO_EVALUATION_EVIDENCE = "No evaluation returned."
NOT_ATTEMPTED_GAP = "Not attempted"

OUTCOMES = ("FULL", "PARTIAL", "ZERO", "BLANK")
NUDGE_PRIORITIES = ("high", "medium", "low")
CHECK_TEMPLATE = ">=4/5 correct on fresh {topic} items; teacher checks the working"
MAINTENANCE_NUDGE = {
    "priority": "low",
    "label": "Maintain with mixed practice",
    "text": "No topic is below 90%: assign one timed mixed set of 5 unseen questions; check >=4/5.",
    "topic": None,
    "question_refs": [],
    "source": "template",
}

_MARKS_PREFIX = re.compile(r"^\s*\d+(?:\.\d+)?\s*marks?\s*(?:each\s*)?[:\-–—.)]\s*", re.IGNORECASE)
_WORD = re.compile(r"[a-z0-9]+")


class InsightsValidationError(ValueError):
    """LLM evaluation is inconsistent with the rubric (unknown/duplicate question, ...)."""


def calculate_roi(weightage: float, gain_potential: float, effort_hours: float) -> float:
    """BRD formula: ROI = (weightage * gain_potential) / effort_hours."""
    if effort_hours is None or not effort_hours > 0:
        raise ValueError("effort_hours must be greater than 0")
    return weightage * gain_potential / effort_hours


def build_evaluation_report(
    rubric_content: dict,
    answers: list[OcrAnswer],
    evaluation: EvaluationOutput,
) -> dict:
    """Return {total_score, total_marks, overall_mastery, topic_mastery, roi_recommendations,
    strengths_gaps, question_evaluations, summary, teaching_nudges, confusions} exactly as
    documented in API_CONTRACT.md (report dict)."""
    questions = _validated_questions(rubric_content)
    known = {q["question"] for q in questions}
    answers_by_q = _index_answers(answers, known)
    if isinstance(evaluation, dict):
        evaluation = EvaluationOutput.model_validate(evaluation)
    grades_by_q = _index_grades(evaluation, known)
    raw_by_q = _raw_questions(rubric_content)
    policy = marking.policy_for(rubric_content)
    levels = bloom.resolve_levels(rubric_content)

    question_evaluations = []
    for q in sorted(questions, key=lambda item: item["question"]):
        number, max_marks = q["question"], q["max_marks"]
        raw = raw_by_q.get(number, {})
        grade = grades_by_q.get(number)
        answer = answers_by_q.get(number)
        student_answer = answer.answer if answer else ""
        qtype = marking.question_type(raw)
        penalty, selected, correct, breakdown, note, demonstrated = 0.0, None, None, [], None, None
        if qtype == "mcq":
            # Deterministic: the option letter decides; any grade from the evaluation call is ignored.
            scored = marking.score_mcq(raw, student_answer, policy)
            marks, penalty, note = scored["marks"], scored["penalty"], scored["note"]
            selected, correct = scored["selected_option"], scored["correct_option"]
            evidence = f"Auto-scored MCQ: {note}"
            strengths, gaps = _mcq_strengths_gaps(selected, correct, penalty)
        elif grade is None:
            marks, evidence, strengths, gaps = 0.0, NO_EVALUATION_EVIDENCE, [], [NOT_ATTEMPTED_GAP]
        else:
            scored = marking.score_descriptive(
                raw,
                estimated_marks=grade.estimated_marks,
                criteria_awards=[a.model_dump() for a in grade.criteria_awards],
                policy=policy,
            )
            marks, breakdown, note = scored["marks"], scored["breakdown"], scored["note"]
            evidence = (grade.evidence or "").strip() or "No evidence provided."
            strengths, gaps = _clean_list(grade.strengths), _clean_list(grade.gaps)
            demonstrated = bloom.parse_level(grade.demonstrated_level)
        outcome = question_outcome(student_answer, marks, max_marks)
        level, level_source = levels.get(number, (None, None))
        question_evaluations.append(
            {
                "question": number,
                "topic": q["topic"],
                "estimated_marks": marks,
                "max_marks": max_marks,
                "evidence": evidence,
                "strengths": strengths,
                "gaps": gaps,
                "student_answer": student_answer,
                "confidence": _clamp01(answer.confidence) if answer else 0.0,
                "outcome": outcome,
                "source_pages": _clean_pages(answer.pages) if answer else [],
                "uncertain_words": _clean_uncertain_words(answer.uncertain_words) if answer else [],
                "corrected_by_faculty": bool(answer is not None and answer.source == "faculty"),
                "question_type": qtype,
                "bloom_level": level,
                "bloom_source": level_source,
                "demonstrated_level": None if outcome == "BLANK" else demonstrated,
                "concept": bloom.concept_key(raw) or q["topic"],
                "penalty": float(penalty or 0.0),
                "selected_option": selected if qtype == "mcq" else None,
                "correct_option": correct if qtype == "mcq" else None,
                "marking_breakdown": breakdown or [],
                "marking_note": note,
            }
        )

    total_marks = _clean_number(sum(q["max_marks"] for q in questions))
    total_score = _clean_number(sum(item["estimated_marks"] for item in question_evaluations))
    overall_mastery = max(0.0, _percent(total_score, total_marks))  # net totals may be negative (MCQ -1)

    topics = [q["topic"] for q in questions]
    topic_mastery = _topic_mastery(questions, question_evaluations)
    priorities = _roi_recommendations(topic_mastery)
    criteria_by_q = {q["question"]: q["grading_criteria"] for q in questions}
    ai_interventions = clean_interventions(
        [i.model_dump() for i in evaluation.topic_interventions], topics
    )
    for priority in priorities:
        priority["trigger_questions"] = trigger_questions(priority["topic"], question_evaluations)
        priority["intervention"] = topic_intervention(
            priority["topic"], question_evaluations, criteria_by_q, ai_interventions
        )

    nudges = clean_nudges([n.model_dump() for n in evaluation.teaching_nudges], topics, known)
    if len(nudges) < MIN_NUDGES:
        nudges = top_up_nudges(nudges, priorities, question_evaluations)

    return {
        "total_score": total_score,
        "total_marks": total_marks,
        "overall_mastery": overall_mastery,
        "topic_mastery": topic_mastery,
        "roi_recommendations": priorities,
        "strengths_gaps": _strengths_gaps(evaluation, question_evaluations),
        "question_evaluations": question_evaluations,
        "summary": " ".join((evaluation.summary or "").split()) or None,
        "teaching_nudges": nudges,
        "confusions": clean_confusions([c.model_dump() for c in evaluation.confusions], known),
    }


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def _validated_questions(rubric_content: dict) -> list[dict[str, Any]]:
    if not isinstance(rubric_content, dict):
        raise InsightsValidationError("Rubric content must be an object.")
    raw_questions = rubric_content.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        raise InsightsValidationError("Rubric has no questions.")
    default_subject = str(rubric_content.get("subject") or "").strip() or "General"

    questions: list[dict[str, Any]] = []
    seen: set[int] = set()
    for index, raw in enumerate(raw_questions, start=1):
        if not isinstance(raw, dict):
            raise InsightsValidationError(f"Rubric question #{index} is not an object.")
        number = _as_int(raw.get("question"))
        if number is None:
            raise InsightsValidationError(f"Rubric question #{index} has an invalid question number.")
        if number in seen:
            raise InsightsValidationError(f"Rubric question number {number} appears more than once.")
        seen.add(number)
        max_marks = _positive_number(raw.get("max_marks"))
        if max_marks is None:
            raise InsightsValidationError(f"Rubric question {number} must have max_marks greater than 0.")
        effort = _positive_number(raw.get("effort_hours"))
        if effort is None:
            raise InsightsValidationError(f"Rubric question {number} must have effort_hours greater than 0.")
        chapter = " ".join(str(raw.get("chapter") or "").split()) or None
        questions.append(
            {
                "question": number,
                "topic": str(raw.get("topic") or "").strip() or f"Question {number}",
                "subject": str(raw.get("subject") or "").strip() or default_subject,
                "max_marks": _clean_number(max_marks),
                "effort_hours": _clean_number(effort),
                "chapter": chapter,
                "grading_criteria": _clean_list(raw.get("grading_criteria") if isinstance(raw.get("grading_criteria"), list) else []),
            }
        )
    return questions


def _raw_questions(rubric_content: dict) -> dict[int, dict[str, Any]]:
    """The rubric's own question dicts by number (marking.py reads the wave-2 fields from them)."""
    out: dict[int, dict[str, Any]] = {}
    for raw in rubric_content.get("questions") or []:
        if isinstance(raw, dict):
            number = _as_int(raw.get("question"))
            if number is not None:
                out.setdefault(number, raw)
    return out


def _mcq_strengths_gaps(selected: str | None, correct: str | None, penalty: float) -> tuple[list[str], list[str]]:
    if selected is not None and correct is not None and selected == correct:
        return [f"Correct option {correct}"], []
    if selected is None:
        return [], [NOT_ATTEMPTED_GAP]
    if selected == marking.MULTI:
        return [], ["More than one option marked"]
    if selected == marking.UNKNOWN:
        return [], ["Option not identifiable - check the sheet"]
    lost = f"-{_fmt(penalty)}" if penalty else "0"
    return [], [f"Chose {selected}; correct {correct or '?'} ({lost})"]


def _index_answers(answers: Iterable[OcrAnswer | dict] | None, known: set[int]) -> dict[int, OcrAnswer]:
    indexed: dict[int, OcrAnswer] = {}
    for raw in answers or []:
        answer = raw if isinstance(raw, OcrAnswer) else OcrAnswer.model_validate(raw)
        if answer.question not in known:
            raise InsightsValidationError(f"Answer for question {answer.question} does not match any rubric question.")
        if answer.question in indexed:
            raise InsightsValidationError(f"Question {answer.question} has more than one answer.")
        indexed[answer.question] = answer
    return indexed


def _index_grades(evaluation: EvaluationOutput, known: set[int]) -> dict[int, Any]:
    indexed: dict[int, Any] = {}
    for grade in evaluation.evaluations:
        if grade.question not in known:
            raise InsightsValidationError(
                f"The evaluation graded question {grade.question}, which is not in the rubric."
            )
        if grade.question in indexed:
            raise InsightsValidationError(f"The evaluation graded question {grade.question} more than once.")
        indexed[grade.question] = grade
    return indexed


# --------------------------------------------------------------------------- #
# Per-question outcome
# --------------------------------------------------------------------------- #
def question_outcome(student_answer: Any, marks: Any, max_marks: Any) -> str:
    """BLANK without a student answer; FULL at max marks; ZERO when answered but 0; else PARTIAL."""
    if not str(student_answer or "").strip():
        return "BLANK"
    try:
        awarded, maximum = float(marks or 0), float(max_marks or 0)
    except (TypeError, ValueError):
        return "PARTIAL"
    if maximum > 0 and awarded >= maximum:
        return "FULL"
    if awarded <= 0:
        return "ZERO"
    return "PARTIAL"


def outcome_of(item: dict[str, Any]) -> str:
    """Outcome of a stored question evaluation (old rows lack the key)."""
    stored = item.get("outcome")
    if stored in OUTCOMES:
        return stored
    return question_outcome(item.get("student_answer"), item.get("estimated_marks"), item.get("max_marks"))


def _clean_pages(pages: Iterable[Any] | None) -> list[int]:
    return sorted({n for n in (_as_int(p) for p in pages or []) if n is not None and n > 0})


def _clean_uncertain_words(words: Iterable[Any] | None) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in words or []:
        data = raw.model_dump() if hasattr(raw, "model_dump") else raw
        if not isinstance(data, dict):
            continue
        text = " ".join(str(data.get("text") or "").split())
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        cleaned.append({"text": text, "confidence": round(_clamp01(data.get("confidence")), 3)})
        if len(cleaned) >= MAX_UNCERTAIN_WORDS:
            break
    return cleaned


# --------------------------------------------------------------------------- #
# Topic mastery & ROI
# --------------------------------------------------------------------------- #
def _topic_mastery(questions: list[dict[str, Any]], evaluations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    marks_by_q = {item["question"]: item["estimated_marks"] for item in evaluations}
    outcome_by_q = {item["question"]: item["outcome"] for item in evaluations}

    subject_totals: dict[str, float] = {}
    for q in questions:
        subject_totals[q["subject"]] = subject_totals.get(q["subject"], 0.0) + q["max_marks"]
    lookup = {name.lower(): weight for name, weight in SUBJECT_WEIGHTS.items()}
    default_weight = 1.0 / len(subject_totals)

    topics: dict[str, dict[str, Any]] = {}  # insertion order = rubric order
    for q in sorted(questions, key=lambda item: item["question"]):
        topic = topics.setdefault(
            q["topic"],
            {"subject": q["subject"], "score": 0.0, "max_marks": 0.0, "effort_hours": 0.0, "chapter": None,
             "questions": []},
        )
        topic["score"] += marks_by_q[q["question"]]
        topic["max_marks"] += q["max_marks"]
        topic["effort_hours"] = max(topic["effort_hours"], q["effort_hours"])
        topic["chapter"] = topic["chapter"] or q["chapter"]
        topic["questions"].append(q["question"])

    # Rubric order of first appearance (questions above are sorted, so re-key by rubric order).
    order = list(dict.fromkeys(q["topic"] for q in questions))
    result = []
    for name in order:
        topic = topics[name]
        subject = topic["subject"]
        subject_weight = lookup.get(subject.lower(), default_weight)
        weightage = subject_weight * topic["max_marks"] / subject_totals[subject]
        outcomes = [outcome_by_q[n] for n in topic["questions"]]
        result.append(
            {
                "topic": name,
                "subject": subject,
                "score": _clean_number(topic["score"]),
                "max_marks": _clean_number(topic["max_marks"]),
                "mastery": min(100.0, max(0.0, _percent(topic["score"], topic["max_marks"]))),
                "weightage": round(weightage, 4),
                "effort_hours": _clean_number(topic["effort_hours"]),
                "chapter": topic["chapter"],
                "questions": list(topic["questions"]),
                "n": len(topic["questions"]),
                "full": outcomes.count("FULL"),
                "partial": outcomes.count("PARTIAL"),
                "zero": outcomes.count("ZERO"),
                "blank": outcomes.count("BLANK"),
            }
        )
    return result


def _roi_recommendations(topic_mastery: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priorities = []
    for topic in topic_mastery:
        mastery = topic["mastery"]
        if mastery >= MASTERED_THRESHOLD:
            continue
        gain = round(100.0 - mastery, 1)
        # Computed from the rounded, displayed values so the UI numbers reproduce the ROI.
        roi = round(calculate_roi(topic["weightage"], gain, topic["effort_hours"]), 2)
        priorities.append(
            {
                "topic": topic["topic"],
                "subject": topic["subject"],
                "roi": roi,
                "weightage": topic["weightage"],
                "gain_potential": gain,
                "effort_hours": topic["effort_hours"],
                "rationale": _rationale(topic, gain, roi),
                "mastery": mastery,
            }
        )
    priorities.sort(key=lambda p: (-p["roi"], -p["gain_potential"], p["topic"]))
    return priorities[:MAX_PRIORITIES]


def _rationale(topic: dict[str, Any], gain: float, roi: float) -> str:
    mastery = topic["mastery"]
    if mastery < 40:
        level = "Foundational gap"
    elif mastery < 70:
        level = "Partial understanding"
    else:
        level = "Close to mastery"
    hours = topic["effort_hours"]
    return (
        f"{level}: mastery is {_fmt(mastery)}% ({_fmt(topic['score'])}/{_fmt(topic['max_marks'])} marks). "
        f"It carries {_fmt(round(topic['weightage'] * 100, 2))}% of the overall exam weight ({topic['subject']}), "
        f"so closing the {_fmt(gain)}-point gap in about {_fmt(hours)} study hour{'s' if hours != 1 else ''} "
        f"gives an ROI of {roi:.2f}."
    )


# --------------------------------------------------------------------------- #
# Interventions (teach / practice / check) - also used by analytics for old rows
# --------------------------------------------------------------------------- #
def trigger_questions(topic: str, question_evaluations: Iterable[dict[str, Any]]) -> list[int]:
    """The topic's questions where marks were lost (marks < max), in question order."""
    out = []
    for q in question_evaluations or []:
        if not isinstance(q, dict) or str(q.get("topic")) != str(topic):
            continue
        number = _as_int(q.get("question"))
        if number is None:
            continue
        try:
            if float(q.get("estimated_marks") or 0) < float(q.get("max_marks") or 0):
                out.append(number)
        except (TypeError, ValueError):
            continue
    return sorted(out)


def strip_marks_prefix(criterion: str) -> str:
    """'1 mark: names the Meselson and Stahl experiment' -> 'names the Meselson and Stahl experiment'."""
    return " ".join(_MARKS_PREFIX.sub("", str(criterion or "")).split())


def _stems(text: str) -> set[str]:
    """Crude stems (first 5 letters of words with 4+ letters): 'parental' ~ 'parent'."""
    return {w[:5] for w in _WORD.findall(str(text).casefold()) if len(w) >= 4}


def missed_criterion(question_eval: dict[str, Any], criteria: list[str] | None) -> str | None:
    """Best guess at the first grading criterion the student missed on this question: walking
    the grader's gaps in order, the first criterion that clearly matches a gap (most shared
    word stems, no tie); else the criterion at the position the awarded marks reach (criteria
    are listed in mark order)."""
    criteria = [c for c in (criteria or []) if str(c).strip()]
    if not criteria:
        return None
    criterion_stems = [_stems(strip_marks_prefix(c)) for c in criteria]
    for gap in question_eval.get("gaps") or []:
        text = str(gap).strip()
        if not text or text == NOT_ATTEMPTED_GAP:
            continue
        stems = _stems(text)
        overlaps = [len(stems & cs) for cs in criterion_stems]
        best = max(overlaps)
        if best >= 1 and overlaps.count(best) == 1:
            return criteria[overlaps.index(best)]
    try:
        marks = float(question_eval.get("estimated_marks") or 0)
        max_marks = float(question_eval.get("max_marks") or 0)
    except (TypeError, ValueError):
        marks, max_marks = 0.0, 0.0
    per = max_marks / len(criteria) if max_marks > 0 else 0.0
    index = int(marks // per) if per > 0 else 0
    return criteria[min(max(index, 0), len(criteria) - 1)]


def template_intervention(topic: str, criterion: str | None) -> dict[str, Any]:
    phrase = strip_marks_prefix(criterion or "")
    short = phrase.split(" (")[0].strip().rstrip(".") if phrase else ""
    teach = f"Re-teach {topic}: {phrase}" if phrase else f"Re-teach {topic} from the missed questions"
    practice = (
        f"5 unseen {topic} questions, including {short}" if short else f"5 unseen {topic} questions"
    )
    return {
        "teach": teach,
        "practice": practice,
        "check_criterion": CHECK_TEMPLATE.format(topic=topic),
        "source": "template",
    }


def topic_intervention(
    topic: str,
    question_evaluations: Iterable[dict[str, Any]],
    criteria_by_q: dict[int, list[str]],
    ai_interventions: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """The AI intervention for this topic when the grader gave one, else a template built from
    the first missed grading criterion of the topic's first question with lost marks."""
    ai_item = (ai_interventions or {}).get(str(topic).casefold())
    if ai_item:
        return {**ai_item, "source": "ai"}
    questions = [q for q in question_evaluations or [] if isinstance(q, dict)]
    lost = trigger_questions(topic, questions)
    if not lost:
        return None
    first = next(q for q in questions if _as_int(q.get("question")) == lost[0])
    return template_intervention(topic, missed_criterion(first, criteria_by_q.get(lost[0])))


def clean_interventions(raw: Iterable[Any] | None, topics: Iterable[str]) -> dict[str, dict[str, Any]]:
    """AI topic interventions keyed by casefolded rubric topic (unknown topics dropped, max 5)."""
    canonical = {str(t).casefold(): str(t) for t in topics}
    out: dict[str, dict[str, Any]] = {}
    for item in raw or []:
        data = item.model_dump() if hasattr(item, "model_dump") else item
        if not isinstance(data, dict):
            continue
        key = " ".join(str(data.get("topic") or "").split()).casefold()
        if key not in canonical or key in out:
            continue
        fields = {f: " ".join(str(data.get(f) or "").split()) for f in ("teach", "practice", "check_criterion")}
        if not all(fields.values()):
            continue
        out[key] = {**fields, "source": "ai"}
        if len(out) >= MAX_INTERVENTIONS:
            break
    return out


# --------------------------------------------------------------------------- #
# Teaching nudges & confusions
# --------------------------------------------------------------------------- #
def _short_label(text: str) -> str:
    words = " ".join(str(text or "").split()).split(" ")
    return " ".join(words[:MAX_NUDGE_LABEL_WORDS]).strip()


def clean_nudges(raw: Iterable[Any] | None, topics: Iterable[str], known_questions: Iterable[int]) -> list[dict[str, Any]]:
    """AI nudges: whitespace stripped, label <= 6 words, topic mapped to a rubric topic (else
    None), question refs limited to rubric questions, deduplicated, at most 3."""
    canonical = {str(t).casefold(): str(t) for t in topics}
    known = set(known_questions)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw or []:
        data = item.model_dump() if hasattr(item, "model_dump") else item
        if not isinstance(data, dict):
            continue
        label = _short_label(data.get("label") or "")
        text = " ".join(str(data.get("text") or "").split())
        if not label or not text or label.casefold() in seen:
            continue
        seen.add(label.casefold())
        priority = str(data.get("priority") or "").strip().lower()
        topic = canonical.get(" ".join(str(data.get("topic") or "").split()).casefold())
        refs = sorted({n for n in (_as_int(r) for r in data.get("question_refs") or []) if n in known})
        out.append(
            {
                "priority": priority if priority in NUDGE_PRIORITIES else "medium",
                "label": label,
                "text": text,
                "topic": topic,
                "question_refs": refs,
                "source": data.get("source") if data.get("source") in ("ai", "template", "faculty") else "ai",
            }
        )
        if len(out) >= MAX_NUDGES:
            break
    return out


def _first_gap(question_eval: dict[str, Any]) -> str:
    for gap in question_eval.get("gaps") or []:
        text = " ".join(str(gap).split())
        if text:
            return text.rstrip(".")
    try:
        lost = float(question_eval.get("max_marks") or 0) - float(question_eval.get("estimated_marks") or 0)
    except (TypeError, ValueError):
        lost = 0.0
    return f"Lost {_fmt(lost)} of {_fmt(float(question_eval.get('max_marks') or 0))} marks"


def top_up_nudges(
    nudges: list[dict[str, Any]],
    priorities: Iterable[dict[str, Any]],
    question_evaluations: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fill up to 3 nudges deterministically: one per top priority with a gap ('Re-teach <topic>'),
    then other questions with gaps, then a maintenance nudge when nothing is left to fix."""
    out = [dict(n) for n in nudges][:MAX_NUDGES]
    covered = {str(n.get("topic") or "").casefold() for n in out if n.get("topic")}
    labels = {str(n.get("label") or "").casefold() for n in out}
    questions = [q for q in question_evaluations or [] if isinstance(q, dict)]

    def add(topic: str, q: dict[str, Any], rank: int) -> None:
        number = _as_int(q.get("question"))
        label = _short_label(f"Re-teach {topic}")
        if label.casefold() in labels:
            return
        labels.add(label.casefold())
        covered.add(topic.casefold())
        out.append(
            {
                "priority": NUDGE_PRIORITIES[min(rank, len(NUDGE_PRIORITIES) - 1)],
                "label": label,
                "text": f"{_first_gap(q)} (Q{number}). Assign 5 unseen {topic} questions; check >=4/5.",
                "topic": topic,
                "question_refs": [number] if number is not None else [],
                "source": "template",
            }
        )

    for rank, priority in enumerate(priorities or []):
        if len(out) >= MAX_NUDGES:
            break
        topic = str(priority.get("topic") or "")
        if not topic or topic.casefold() in covered:
            continue
        lost = trigger_questions(topic, questions)
        if lost:
            add(topic, next(q for q in questions if _as_int(q.get("question")) == lost[0]), rank)
    if len(out) < MIN_NUDGES:
        ranked = sorted(
            (q for q in questions if outcome_of(q) != "FULL"),
            key=lambda q: (float(q.get("estimated_marks") or 0) - float(q.get("max_marks") or 0), _as_int(q.get("question")) or 0),
        )
        for q in ranked:
            if len(out) >= MAX_NUDGES:
                break
            topic = str(q.get("topic") or "")
            if topic and topic.casefold() not in covered:
                add(topic, q, len(out))
    if len(out) < MIN_NUDGES and MAINTENANCE_NUDGE["label"].casefold() not in labels:
        out.append(dict(MAINTENANCE_NUDGE))
    return out[:MAX_NUDGES]


def clean_confusions(raw: Iterable[Any] | None, known_questions: Iterable[int]) -> list[dict[str, Any]]:
    """At most 3 two-concept confusions; question refs outside the rubric become None."""
    known = set(known_questions)
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw or []:
        data = item.model_dump() if hasattr(item, "model_dump") else item
        if not isinstance(data, dict):
            continue
        a = " ".join(str(data.get("concept_a") or "").split())
        b = " ".join(str(data.get("concept_b") or "").split())
        if not a or not b or a.casefold() == b.casefold():
            continue
        key = tuple(sorted((a.casefold(), b.casefold())))
        if key in seen:
            continue
        seen.add(key)
        question = _as_int(data.get("question"))
        evidence = " ".join(str(data.get("evidence") or "").split())
        out.append(
            {
                "concept_a": a,
                "concept_b": b,
                "question": question if question in known else None,
                "evidence": evidence[:MAX_EVIDENCE_CHARS],
            }
        )
        if len(out) >= MAX_CONFUSIONS:
            break
    return out


# --------------------------------------------------------------------------- #
# Strengths & gaps
# --------------------------------------------------------------------------- #
def _strengths_gaps(evaluation: EvaluationOutput, question_evaluations: list[dict[str, Any]]) -> dict[str, list[str]]:
    return {
        "strengths": _insights(evaluation.overall_strengths, question_evaluations, "strengths"),
        "gaps": _insights(evaluation.overall_gaps, question_evaluations, "gaps"),
    }


def _insights(overall: list[str], question_evaluations: list[dict[str, Any]], key: str) -> list[str]:
    items = _clean_list(overall)[:MAX_INSIGHTS]
    if len(items) >= MIN_INSIGHTS:
        return items
    seen = {item.casefold() for item in items}
    for qe in question_evaluations:
        for text in qe[key]:
            candidate = f"Q{qe['question']} ({qe['topic']}): {text}"
            if text.casefold() in seen or candidate.casefold() in seen:
                continue
            seen.add(candidate.casefold())
            items.append(candidate)
            if len(items) >= MAX_INSIGHTS:
                return items
    return items


def _clean_list(values: Iterable[Any] | None) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        text = " ".join(str(value).split()) if value is not None else ""
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        cleaned.append(text)
    return cleaned


# --------------------------------------------------------------------------- #
# Number helpers
# --------------------------------------------------------------------------- #
def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number) or number <= 0:
        return None
    return number


def _bounded_marks(value: Any, max_marks: float) -> float:
    """Clamp to [0, max_marks], round to the nearest 0.5 (half up), and re-clamp."""
    try:
        marks = float(value)
    except (TypeError, ValueError):
        marks = 0.0
    if math.isnan(marks):
        marks = 0.0
    marks = min(max(marks, 0.0), max_marks)
    marks = math.floor(marks * 2 + 0.5) / 2
    return _clean_number(min(marks, max_marks))


bounded_marks = _bounded_marks  # public alias (consistency check re-grades through the same rule)


def _clamp01(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(number):
        return 0.0
    return min(1.0, max(0.0, number))


def _percent(score: float, total: float) -> float:
    return round(100.0 * score / total, 1) if total > 0 else 0.0


def _clean_number(value: float) -> float:
    """Round away float noise (sums of halves, etc.) while keeping a float type."""
    return float(round(float(value), 4))


def _fmt(value: float) -> str:
    """Compact human formatting: 4.0 -> '4', 12.5 -> '12.5', 0.125 -> '0.13'."""
    rounded = round(float(value), 2)
    if rounded.is_integer():
        return str(int(rounded))
    return f"{rounded:.2f}".rstrip("0").rstrip(".")
