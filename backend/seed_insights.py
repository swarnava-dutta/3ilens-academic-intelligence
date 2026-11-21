"""The set=insights sample dataset: POST /api/demo/seed?set=insights.

Creates (idempotently, with NO AI call, every row is_demo and labelled sample):
- rubrics 'NEET MCQ Practice - Mock 09 (sample)' (24 MCQs +4/-1 + 2 descriptive with marking schemes),
  'NEET MCQ Practice - Mock 10 (sample)' (24 parallel MCQs) and 'Oral answer - Genetics (sample)';
- batch 'NEET-C (sample)' (faculty lead 'Ms. K. Menon (sample)'); NEET-A / NEET-B get a sample
  faculty lead only when they exist and have none;
- 12 students with designed exam-behaviour archetypes (over-attempting, fatigue, memorisation,
  foundational gaps, strong): Mock 09 about 24 days ago, Mock 10 about 3 days ago;
- 24 intervention records (22 measured by Mock 10, 2 pending) through outcomes.build_record;
- one sample voice answer (Tanvi Shah, Hinglish transcript, no audio file stored);
- 6 Mock-09 results released by 'Ms. K. Menon (sample)'.

Answers are generated deterministically (hashlib-based uniforms, never hash()) and every result is
scored by the real engine: insights.build_evaluation_report (MCQ +4/-1, marking schemes),
ReportPayload validation and results_store.build_evaluation_result - the same code paths as live data.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

import insights
import marking
import outcomes
import seed
from ai_schemas import CriterionAward, EvaluationOutput, OcrAnswer, QuestionGrade
from database import (
    INPUT_VOICE,
    Batch,
    InterventionRecord,
    ReleaseStatus,
    Rubric,
    RubricStatus,
    StudentSubmission,
    SubmissionStatus,
    utc_iso,
    utcnow,
)
from hashing import student_ref_for
from results_store import build_evaluation_result
from rubric_store import create_rubric
from schemas import ReportPayload, RubricContentIn

RUBRIC_DIR = Path(__file__).resolve().parent / "rubrics"
MOCK09_FILE = RUBRIC_DIR / "neet_mcq_mock09_sample.json"
MOCK10_FILE = RUBRIC_DIR / "neet_mcq_mock10_sample.json"
ORAL_FILE = RUBRIC_DIR / "oral_genetics_sample.json"
RUBRIC_VERSION = "v1"

BATCH_NAME = "NEET-C (sample)"
BATCH_EXAM_TYPE = "Mock-09/10"
FACULTY = "Ms. K. Menon (sample)"
FACULTY_LEADS = {seed.BATCH_NAME: "Dr. A. Rao (demo)", seed.SECOND_BATCH_NAME: "Mr. S. Iyer (sample)"}
NOTE = "Synthetic sample record (insights sample set) - generated locally without any AI call."
TOPICS = (
    "Genetics", "Human Physiology", "Cell Biology", "Ecology", "Organic Chemistry", "Chemical Bonding",
    "Electrostatics", "Mechanics",
)
MOCK09_DAYS, MOCK10_DAYS, VOICE_DAYS = 24, 3, 5
APPLIED_DAYS, PENDING_DAYS = 21, 1
LATE_FROM = 18  # Mock 09 final third: Q18-Q26 (26 questions, k = 9)

# name -> archetype. base = P(correct); blank = P(blank | not correct); over = topics answered
# wrong (never blank); memoriser = K1/K2 up, K3 down; fatigue = P drop in Q18-Q26 (+ late_blank);
# strong = at least 2 of 3 right in every topic; gaps = topics left completely blank (cautious).
STUDENTS: dict[str, dict[str, Any]] = {
    "Aditi Rao": {"base": 0.86, "blank": 0.6, "strong": True},
    "Kunal Desai": {"base": 0.8, "blank": 0.0, "over": ("Organic Chemistry", "Electrostatics")},
    "Tanvi Shah": {"base": 0.8, "blank": 0.4, "fatigue": 0.55, "late_blank": 0.75},
    "Farhan Qureshi": {"base": 0.62, "blank": 0.35, "memoriser": True},
    "Ishita Ghosh": {"base": 0.66, "blank": 0.4},
    "Karan Malhotra": {"base": 0.66, "blank": 0.05, "over": ("Mechanics", "Chemical Bonding"), "fatigue": 0.5,
                       "late_blank": 0.5},
    "Lavanya Pillai": {"base": 0.62, "blank": 0.35, "memoriser": True},
    "Nikhil Sood": {"base": 0.74, "blank": 0.35, "fatigue": 0.55, "late_blank": 0.7},
    "Pooja Venkat": {"base": 0.66, "blank": 0.05, "over": ("Genetics", "Human Physiology")},
    "Rahul Bansal": {"base": 0.6, "blank": 0.1, "memoriser": True, "over": ("Organic Chemistry",)},
    "Sneha Kulkarni": {"base": 0.84, "blank": 0.6, "strong": True},
    "Vikram Chauhan": {"base": 0.25, "blank": 0.97, "cautious": True,
                       "topics": {"Ecology": 0.45, "Human Physiology": 0.3},
                       "gaps": ("Genetics", "Cell Biology", "Electrostatics", "Chemical Bonding")},
}
MEMORISER_LEVELS = {"K1": 0.35, "K2": 0.3, "K3": -0.6}
RELEASED = ("Aditi Rao", "Sneha Kulkarni", "Ishita Ghosh", "Farhan Qureshi", "Tanvi Shah", "Nikhil Sood")
REQUIRED_STEP_MISS = "Pooja Venkat"  # writes the numbers for Q25 without the method -> required step unmet

# (student, topic, kind, hours, compliance, action)
INTERVENTIONS: tuple[tuple[str, str, str, float, float, str], ...] = (
    ("Kunal Desai", "Organic Chemistry", "study_focus", 5, 0.9,
     "Untimed drill of 20 Organic Chemistry MCQs; answer only after eliminating two options"),
    ("Kunal Desai", "Electrostatics", "study_focus", 4, 0.6, "Field and potential problem set with worked checks"),
    ("Tanvi Shah", "Mechanics", "class_intervention", 4, 0.8, "Two full-length timed mocks; start one from the last section"),
    ("Tanvi Shah", "Chemical Bonding", "nudge", 2, 0.7, "VSEPR shapes flashcards plus 10 timed items"),
    ("Farhan Qureshi", "Genetics", "nudge", 3, 0.9, "Application set: pedigree and cross problems (K3)"),
    ("Farhan Qureshi", "Human Physiology", "study_focus", 4, 0.8, "Explain-your-reasoning drills on physiology mechanisms"),
    ("Ishita Ghosh", "Cell Biology", "nudge", 3, 0.5, "Mitosis vs meiosis comparison table, then 10 MCQs"),
    ("Ishita Ghosh", "Ecology", "class_intervention", 2, 0.6, "Class recap: energy flow and pyramids"),
    ("Karan Malhotra", "Mechanics", "study_focus", 5, 0.7, "Kinematics/energy drill, skip-threshold practice"),
    ("Karan Malhotra", "Chemical Bonding", "class_intervention", 3, 0.5, "Class session on hybridisation traps"),
    ("Lavanya Pillai", "Electrostatics", "nudge", 3, 0.8, "Gauss's-law application problems"),
    ("Lavanya Pillai", "Organic Chemistry", "study_focus", 4, 0.9, "Mechanism-reasoning set (SN1/SN2, stability)"),
    ("Nikhil Sood", "Human Physiology", "class_intervention", 3, 0.6, "Timed endurance block in class"),
    ("Nikhil Sood", "Genetics", "nudge", 2, 0.4, "Inheritance ratios quick quiz"),
    ("Pooja Venkat", "Genetics", "study_focus", 5, 0.9,
     "Untimed inheritance MCQ drill; answer only when two options are eliminated"),
    ("Pooja Venkat", "Human Physiology", "nudge", 3, 0.6, "Physiology recall-to-application ladder"),
    ("Rahul Bansal", "Organic Chemistry", "study_focus", 5, 0.8, "Organic MCQ drill with skip rule"),
    ("Rahul Bansal", "Cell Biology", "nudge", 2, 0.5, "Cell-cycle application questions"),
    ("Vikram Chauhan", "Cell Biology", "study_focus", 6, 0.7, "Rebuild cell basics: notes, then 15 MCQs"),
    ("Vikram Chauhan", "Genetics", "class_intervention", 3, 0.6, "Small-group Mendelian basics"),
    ("Aditi Rao", "Ecology", "nudge", 1, 1.0, "Maintain: weekly 10-item refresher"),
    ("Sneha Kulkarni", "Electrostatics", "nudge", 1, 0.9, "Maintain: capacitor numericals"),
)
PENDING: tuple[tuple[str, str, str, float, str], ...] = (
    ("Kunal Desai", "Organic Chemistry", "custom", 1, "Weekly skip-strategy check-in"),
    ("Vikram Chauhan", "Genetics", "study_focus", 4, "Genetics foundations week 2"),
)
# Designed Mock-10 mastery change (pts) per kind, scaled by (0.5 + 0.5 x compliance); untreated +4.
DESIGNED_EFFECT = {"study_focus": 22.0, "nudge": 12.0, "class_intervention": 8.0, "custom": 6.0}
UNTREATED_EFFECT = 3.0
NOISE_PTS = 6.0

VOICE_STUDENT = "Tanvi Shah"
VOICE_FILENAME = "sample_voice_answer_codominance.mp3"
VOICE_TRANSCRIPT = (
    "Synthetic sample transcript: Codominance मतलब जब heterozygote में दोनों alleles पूरी तरह express होते हैं, "
    "कोई blending नहीं होती। Example: ABO blood group - AB blood group वाले person की red cells पर A और B "
    "दोनों antigens होते हैं, इसलिए यह intermediate phenotype नहीं है जैसा incomplete dominance में होता है।"
)
VOICE_AWARDS = (1.0, 1.0, 1.0, 0.0)  # misses the I^A / I^B allele notation


# --------------------------------------------------------------------------- #
# Deterministic helpers
# --------------------------------------------------------------------------- #
def _u(*parts: Any) -> float:
    """A uniform number in [0, 1) from SHA-256 of the parts (stable across runs and platforms)."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(16 ** 12)


def _slug(name: str) -> str:
    return "_".join(name.lower().replace(".", "").split())


def _filename(name: str, mock: str) -> str:
    return f"sample_{_slug(name)}_neet_mcq_{mock}.pdf"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def name_collisions() -> list[str]:
    """NEET-C sample names that collide with an existing demo name (must be empty)."""
    existing = {name for name, _marks, _conf in seed.DEMO_STUDENTS}
    existing |= {seed.DEMO_REVIEW_STUDENT, *seed.HISTORY_STUDENTS}
    existing |= {f"Student {learner[0]}" for learner in seed.MIXED_LEARNERS}
    return sorted(set(STUDENTS) & existing)


# --------------------------------------------------------------------------- #
# Rubrics and batch
# --------------------------------------------------------------------------- #
def seed_sample_rubric(session: Session, path: Path) -> Rubric:
    """Load a sample rubric JSON as FACULTY_APPROVED v1 (reused on re-run)."""
    content = RubricContentIn.model_validate(_load(path))
    rubric = session.scalar(
        select(Rubric).where(Rubric.name == content.name, Rubric.version == RUBRIC_VERSION).order_by(Rubric.id)
    )
    if rubric is None:
        rubric = create_rubric(
            session, content, status=RubricStatus.FACULTY_APPROVED, version=RUBRIC_VERSION,
            change_note="Synthetic insights sample rubric - sample / illustrative content, not a real paper.",
        )
    return rubric


def seed_sample_batch(session: Session) -> Batch:
    institution, base_batch, _ = seed.seed_base(session)
    batch = session.scalar(
        select(Batch).where(Batch.name == BATCH_NAME, Batch.institution_id == institution.id).order_by(Batch.id)
    )
    if batch is None:
        batch = Batch(name=BATCH_NAME, exam_type=BATCH_EXAM_TYPE, institution_id=institution.id,
                      exam=base_batch.exam or "NEET", faculty_lead=FACULTY)
        session.add(batch)
        session.flush()
    for name, lead in FACULTY_LEADS.items():
        for row in session.scalars(
            select(Batch).where(Batch.name == name, Batch.institution_id == institution.id)
        ).all():
            if not row.faculty_lead:
                row.faculty_lead = lead
    return batch


# --------------------------------------------------------------------------- #
# Mock 09 answers (archetypes)
# --------------------------------------------------------------------------- #
def _mcqs(content: dict[str, Any]) -> list[dict[str, Any]]:
    return [q for q in content["questions"] if marking.question_type(q) == "mcq"]


def _p_correct(name: str, arch: dict[str, Any], q: dict[str, Any]) -> float:
    if q["topic"] in arch.get("over", ()) or q["topic"] in arch.get("gaps", ()):
        return 0.0
    p = arch["base"] + arch.get("topics", {}).get(q["topic"], 0.0)
    if arch.get("memoriser"):
        p += MEMORISER_LEVELS.get(q.get("bloom_level"), 0.0)
    if int(q["question"]) >= LATE_FROM:
        p -= arch.get("fatigue", 0.0)
    return max(0.02, min(0.98, p))


def _wrong_letter(q: dict[str, Any], *salt: Any) -> str:
    letters = [c for c in "ABCD"[: len(q.get("options") or "ABCD")] if c != q["correct_option"]]
    return letters[int(_u(*salt, "wrong") * len(letters))]


def _draw_mock09(name: str, content: dict[str, Any]) -> dict[int, str]:
    """{question: 'correct' | 'wrong' | 'blank'} for the 24 MCQs, after the archetype guards."""
    arch = STUDENTS[name]
    out: dict[int, str] = {}
    for q in _mcqs(content):
        n = int(q["question"])
        p = _p_correct(name, arch, q)
        if _u("m09", name, n, "correct") < p:
            out[n] = "correct"
            continue
        blank = arch.get("late_blank", arch["blank"]) if n >= LATE_FROM and arch.get("fatigue") else arch["blank"]
        if q["topic"] in arch.get("over", ()):
            blank = 0.0
        out[n] = "blank" if _u("m09", name, n, "blank") < blank else "wrong"

    by_topic: dict[str, list[dict[str, Any]]] = {}
    for q in _mcqs(content):
        by_topic.setdefault(q["topic"], []).append(q)
    for topic, items in by_topic.items():
        states = [out[int(q["question"])] for q in items]
        correct = states.count("correct")
        if arch.get("strong") and correct < 2:
            # Strong: at least 2 of the 3 items right in every topic (lowest draws flip first).
            for q in sorted(items, key=lambda q: _u("m09", name, q["question"], "correct"))[:2]:
                out[int(q["question"])] = "correct"
        elif arch.get("cautious") and correct < 2:
            # Cautious: never risks a wrong answer unless two of the topic's items are already right.
            for q in items:
                if out[int(q["question"])] == "wrong":
                    out[int(q["question"])] = "blank"
        elif topic not in arch.get("over", ()) and correct == 0 and states.count("wrong") >= 2:
            # Only the designed over-attempters lose 2+ marks in a topic with nothing right.
            first = True
            for q in items:
                if out[int(q["question"])] == "wrong":
                    if not first:
                        out[int(q["question"])] = "blank"
                    first = False
    return out


def _even_out_late_third(name: str, content: dict[str, Any], states: dict[int, str]) -> None:
    """Archetype guard for FR-4.10: students without the fatigue archetype must not look fatigued.
    Swaps a topic's final-third item with an earlier item of the same recall/transfer side (so the
    topic and transfer read-outs are unchanged) while the final third is weaker or blanker."""
    if STUDENTS[name].get("fatigue"):
        return
    by_topic: dict[str, list[dict[str, Any]]] = {}
    for q in _mcqs(content):
        by_topic.setdefault(q["topic"], []).append(q)
    rank = {"correct": 0, "wrong": 1, "blank": 2}
    for topic in sorted(by_topic, key=lambda t: _u("m09-even", name, t)):
        mcq_states = {n: st for n, st in states.items()}
        drop, jump = _drop(mcq_states, LATE_FROM)
        if drop <= 5 and jump <= 0.05:
            return
        items = sorted(by_topic[topic], key=lambda q: int(q["question"]))
        late = items[-1]
        nl = int(late["question"])
        side = late.get("bloom_level") in ("K3", "K4", "K5")
        for early in items[:-1]:
            ne = int(early["question"])
            if (early.get("bloom_level") in ("K3", "K4", "K5")) != side:
                continue
            if rank[states[ne]] < rank[states[nl]]:
                states[ne], states[nl] = states[nl], states[ne]
                break


def _descriptive_awards(name: str, content: dict[str, Any], states: dict[int, str]) -> dict[int, list[float] | None]:
    """Scheme awards per descriptive question (None = blank)."""
    arch = STUDENTS[name]
    out: dict[int, list[float] | None] = {}
    for q in content["questions"]:
        if marking.question_type(q) == "mcq":
            continue
        n = int(q["question"])
        p = _p_correct(name, arch, q)
        blank_rate = arch.get("late_blank", arch["blank"]) * 0.8 if arch.get("fatigue") else arch["blank"] * 0.3
        if _u("m09", name, n, "desc-blank") < blank_rate * (1 - p):
            out[n] = None
            continue
        awards = []
        for i, step in enumerate(q["marking_scheme"]):
            r = _u("m09", name, n, "step", i)
            marks = float(step["marks"])
            lift = 0.3 if step.get("required") else 0.1  # most students at least state the method
            awards.append(marks if r < p + lift else (marks / 2 if r < p + lift + 0.15 else 0.0))
        if name == REQUIRED_STEP_MISS and n == 25:
            awards = [0.0, 1.0, 1.0, 1.0]
        out[n] = awards
    return out


def _cap_memorisation(name: str, content: dict[str, Any], states: dict[int, str], awards: dict[int, Any]) -> None:
    """Archetype guard for FR-4.11: memorisers show memorisation in >= 3 concepts, everyone else in
    at most 2 (flip one transfer item right / one recall item for a memoriser)."""
    import patterns  # the same classification rule the read side uses

    arch = STUDENTS[name]
    by_topic: dict[str, dict[str, list[tuple[dict[str, Any], float]]]] = {}
    for q in content["questions"]:
        n = int(q["question"])
        side = "transfer" if q.get("bloom_level") in ("K3", "K4", "K5") else "recall"
        if marking.question_type(q) == "mcq":
            marks = float(q["max_marks"]) if states[n] == "correct" else 0.0
        else:
            raw = awards.get(n)
            marks = 0.0 if raw is None else (
                float(q["max_marks"]) if sum(raw) >= float(q["max_marks"]) else (
                    0.0 if q.get("partial_credit") == "all_or_nothing" else sum(raw)
                )
            )
        by_topic.setdefault(q["topic"], {"recall": [], "transfer": []})[side].append((q, marks))

    def cls(sides: dict[str, list[tuple[dict[str, Any], float]]]) -> str:
        def pct(items: list[tuple[dict[str, Any], float]]) -> float:
            return sum(m for _, m in items) / sum(float(q["max_marks"]) for q, _ in items) * 100

        return patterns.classify_transfer(pct(sides["recall"]), pct(sides["transfer"]))

    memo = sorted((t for t, s in by_topic.items() if cls(s) == "memorisation"), key=lambda t: _u("memo", name, t))
    if not arch.get("memoriser"):
        for topic in memo[2:]:
            q = next(q for q, _ in by_topic[topic]["transfer"] if marking.question_type(q) == "mcq")
            states[int(q["question"])] = "correct"
        return
    if len(memo) >= 3:
        return
    candidates = sorted(
        (t for t in by_topic if t not in memo and t not in arch.get("over", ())), key=lambda t: _u("memo+", name, t)
    )
    for topic in candidates[: 3 - len(memo)]:
        for q, _ in by_topic[topic]["recall"]:
            if marking.question_type(q) == "mcq":
                states[int(q["question"])] = "correct"
        for q, _ in by_topic[topic]["transfer"]:
            if marking.question_type(q) == "mcq":
                states[int(q["question"])] = "wrong"


Q25_TEXT = {
    0: "Energy conservation: mgh = 1/2 mv^2, so v^2 = 2gh",
    1: "v^2 = 2 x 10 x 3.2 = 64",
    2: "v = 8",
    3: "m/s",
}
Q26_TEXT = {4.0: "2C2H6 + 7O2 -> 4CO2 + 6H2O", 3.0: "C2H6 + 3O2 -> 2CO2 + 3H2O", 2.0: "C2H6 + O2 -> CO2 + H2O"}


def _descriptive_answer(n: int, awards: list[float]) -> str:
    if n == 25:
        parts = [Q25_TEXT[i] for i, a in enumerate(awards) if a > 0]
        if awards[2] > 0 and awards[3] > 0:
            parts = [p for p in parts if p not in (Q25_TEXT[2], Q25_TEXT[3])] + ["v = 8 m/s"]
        return "; ".join(parts) or "v = 6.4 m/s"
    total = sum(awards)
    return Q26_TEXT.get(total, Q26_TEXT[3.0] if total > 2 else Q26_TEXT[2.0] if total > 0 else "C2H6 burns to give CO2")


def mock09_inputs(name: str, content: dict[str, Any]) -> tuple[list[OcrAnswer], EvaluationOutput]:
    """Synthetic OCR letters + descriptive scheme awards for one student's Mock 09 sheet."""
    states = _draw_mock09(name, content)
    awards = _descriptive_awards(name, content, states)
    _cap_memorisation(name, content, states, awards)
    _even_out_late_third(name, content, states)
    answers: list[OcrAnswer] = []
    grades: list[QuestionGrade] = []
    for q in content["questions"]:
        n = int(q["question"])
        page = 1 if n <= 13 else 2
        conf = round(0.9 + 0.07 * _u("conf", name, n), 2)
        if marking.question_type(q) == "mcq":
            state = states[n]
            if state == "correct":
                text = q["correct_option"]
            elif state == "wrong":
                text = _wrong_letter(q, "m09", name, n)
                if name == "Karan Malhotra" and n == 16:
                    text = f"{text}, {q['correct_option']}"  # two options marked -> MULTI, scored as wrong
            else:
                text = ""
            answers.append(OcrAnswer(question=n, answer=text, confidence=conf, pages=[page]))
            continue
        raw = awards.get(n)
        if raw is None:  # left blank: nothing to grade
            answers.append(OcrAnswer(question=n, answer="", confidence=conf, pages=[page]))
            continue
        steps = q["marking_scheme"]
        met = [s["criterion"] for s, a in zip(steps, raw) if a >= float(s["marks"])]
        missed = [s["criterion"] for s, a in zip(steps, raw) if a < float(s["marks"])]
        answers.append(OcrAnswer(question=n, answer=f"Synthetic sample answer: {_descriptive_answer(n, raw)}",
                                 confidence=conf, pages=[page]))
        grades.append(QuestionGrade(
            question=n,
            estimated_marks=sum(raw),
            evidence=f"Synthetic sample grading against the marking scheme: {len(met)} of {len(steps)} steps fully met.",
            strengths=met[:2],
            gaps=[f"Missing: {m}" for m in missed[:2]],
            criteria_awards=[CriterionAward(index=i, awarded=a) for i, a in enumerate(raw)],
            demonstrated_level=q.get("bloom_level") if sum(raw) >= float(q["max_marks"]) - 1 else "K1",
        ))
    return answers, _evaluation(grades, content, answers)


def _evaluation(grades: list[QuestionGrade], content: dict[str, Any], answers: list[OcrAnswer]) -> EvaluationOutput:
    by_q = {a.question: a.answer for a in answers}
    topic_right: dict[str, int] = {}
    for q in content["questions"]:
        if marking.question_type(q) == "mcq" and by_q.get(int(q["question"])) == q["correct_option"]:
            topic_right[q["topic"]] = topic_right.get(q["topic"], 0) + 1
    ranked = sorted(TOPICS, key=lambda t: (-topic_right.get(t, 0), t))
    return EvaluationOutput(
        evaluations=grades,
        overall_strengths=[f"{t}: most items right (sample)" for t in ranked[:2] if topic_right.get(t)] or
                          ["Attempted the paper (sample)"],
        overall_gaps=[f"{t}: few items right (sample)" for t in ranked[-2:]],
        summary="",
    )


# --------------------------------------------------------------------------- #
# Mock 10 (effects of the interventions)
# --------------------------------------------------------------------------- #
LEVELS10 = [(c, w, max(0.0, 4 * c - w) / 12 * 100) for c in range(4) for w in range(4 - c)]
MOCK10_LATE_FROM = 17  # 24 questions, k = 8


def _allowed(arch: dict[str, Any], c: int, w: int) -> bool:
    if arch.get("strong") and c < 2:
        return False
    return not (arch.get("cautious") and w > 0 and c < 2)


def plan_mock10(
    baselines: dict[str, dict[str, float]], treated: dict[str, dict[str, tuple[str, float]]]
) -> dict[str, dict[str, tuple[int, int]]]:
    """{student: {topic: (correct, wrong)}} for Mock 10. Each topic aims at baseline + designed effect
    (+ noise); levels are quantised (3 items), so the choice is error-diffused per group (each
    intervention kind, and the untreated topics) to keep the group means near the designed effects."""
    realised: dict[str, float] = {}
    target: dict[str, float] = {}
    plan: dict[str, dict[str, tuple[int, int]]] = {}
    for name, arch in STUDENTS.items():
        plan[name] = {}
        for topic in TOPICS:
            base = baselines.get(name, {}).get(topic, 50.0)
            kind, compliance = treated.get(name, {}).get(topic, (None, 0.0))
            effect = DESIGNED_EFFECT[kind] * (0.5 + 0.5 * compliance) if kind else UNTREATED_EFFECT
            group = kind or "untreated"
            wanted = max(0.0, min(100.0, base + effect + NOISE_PTS * (2 * _u("m10", name, topic, "noise") - 1)))
            target[group] = target.get(group, 0.0) + wanted - base
            options = [lv for lv in LEVELS10 if _allowed(arch, lv[0], lv[1])]
            done, goal = realised.get(group, 0.0), target[group]
            c, w, m = min(options, key=lambda lv: (abs(done + lv[2] - base - goal) + 1.5 * lv[1], -lv[0]))
            realised[group] = done + m - base
            plan[name][topic] = (c, w)
    return plan


def _drop(states: dict[int, str], late_from: int) -> tuple[float, float]:
    """(raw accuracy drop in pts, blank-rate jump) of an MCQ-only sheet."""
    early = [s for n, s in states.items() if n < late_from]
    late = [s for n, s in states.items() if n >= late_from]

    def share(items: list[str], state: str) -> float:
        return sum(1 for x in items if x == state) / len(items)

    return (share(early, "correct") - share(late, "correct")) * 100, share(late, "blank") - share(early, "blank")


def mock10_inputs(name: str, content: dict[str, Any], plan: dict[str, tuple[int, int]]) -> tuple[list[OcrAnswer], EvaluationOutput]:
    """Mock 10 letters from the planned per-topic (correct, wrong) counts. Within a topic the right
    items are placed by level (memorisers miss K3) and, for students without the fatigue archetype,
    shifted so the final third is not weaker (topic mastery is unchanged by the swaps)."""
    arch = STUDENTS[name]
    by_topic: dict[str, list[dict[str, Any]]] = {}
    for q in _mcqs(content):
        by_topic.setdefault(q["topic"], []).append(q)
    states: dict[int, str] = {}
    for topic, items in by_topic.items():
        correct, wrong = plan.get(topic, (1, 0))
        if arch.get("memoriser"):
            order = sorted(items, key=lambda q: (q.get("bloom_level") == "K3", _u("m10", name, q["question"])))
        else:
            order = sorted(items, key=lambda q: _u("m10", name, q["question"]))
        for i, q in enumerate(order):
            states[int(q["question"])] = "correct" if i < correct else ("wrong" if i < correct + wrong else "blank")
    if not arch.get("fatigue"):
        for topic in sorted(by_topic, key=lambda t: _u("m10-swap", name, t)):
            drop, jump = _drop(states, MOCK10_LATE_FROM)
            if drop <= 0 and jump <= 0:
                break
            items = sorted(by_topic[topic], key=lambda q: int(q["question"]))
            late = items[-1]
            for early in items[:-1]:
                if arch.get("memoriser") and "K3" in (early.get("bloom_level"), late.get("bloom_level")):
                    continue
                ne, nl = int(early["question"]), int(late["question"])
                if (states[ne], states[nl]) in (("correct", "wrong"), ("correct", "blank"), ("wrong", "blank")):
                    states[ne], states[nl] = states[nl], states[ne]
                    break
    answers = []
    for q in _mcqs(content):
        n = int(q["question"])
        text = q["correct_option"] if states[n] == "correct" else (
            _wrong_letter(q, "m10", name, n) if states[n] == "wrong" else ""
        )
        answers.append(OcrAnswer(question=n, answer=text, confidence=round(0.9 + 0.07 * _u("conf10", name, n), 2),
                                 pages=[1 if n <= 12 else 2]))
    return answers, _evaluation([], content, answers)


# --------------------------------------------------------------------------- #
# Rows
# --------------------------------------------------------------------------- #
def _submission(
    *,
    name: str,
    filename: str,
    batch: Batch,
    rubric: Rubric,
    answers: list[OcrAnswer],
    evaluation: EvaluationOutput,
    created_at: datetime,
    voice: bool = False,
) -> StudentSubmission:
    report = insights.build_evaluation_report(rubric.content, answers, evaluation)
    ReportPayload.model_validate(report)  # same contract check as the live pipeline
    confidences = [a.confidence for a in answers if a.answer]
    ocr_confidence = round(sum(confidences) / len(confidences), 2) if confidences else 0.0
    score, out_of = float(report["total_score"]), float(report["total_marks"])
    if voice:
        steps = [
            ("Ingestion", NOTE),
            ("Transcription", "Synthetic sample transcript (Hinglish: hi, en) - no audio stored, no transcription call."),
            ("Rubric Evaluation", "Synthetic marking-scheme awards for Q1 (1 + 1 + 1 + 0)."),
        ]
    else:
        steps = [
            ("Ingestion", NOTE),
            ("Pre-processing", "Simulating Deskew and 300 DPI Contrast Enhancement."),
            ("OCR & Parse", f"Synthetic option letters for {len(answers)} answers; overall OCR confidence {ocr_confidence:.2f}."),
            ("Rubric Evaluation", "MCQs auto-scored +4/-1 by the deterministic engine; synthetic scheme awards for descriptive items."),
        ]
    steps += [
        ("Insights & ROI", "Topic mastery and Preparation ROI computed by the deterministic engine."),
        ("Persistence", f"Saved to the governed results store: {score:g}/{out_of:g} marks."),
    ]
    sub = StudentSubmission(
        student_name=name,
        file_path="",
        original_filename=filename,
        mime_type="audio/mpeg" if voice else "application/pdf",
        status=SubmissionStatus.COMPLETED,
        ocr_confidence=ocr_confidence,
        current_step="Completed",
        processing_log=seed._demo_log(created_at, steps),
        is_demo=True,
        batch_id=batch.id,
        rubric_id=rubric.id,
        created_at=created_at,
        updated_at=created_at + timedelta(seconds=36),
        student_ref=student_ref_for(name),
        language_hints=["hi", "en"] if voice else ["en"],
        page_count=None if voice else 2,
        started_at=created_at + timedelta(seconds=6),
        completed_at=created_at + timedelta(seconds=36),
        input_kind=INPUT_VOICE if voice else "document",
        audio_seconds=48.0 if voice else None,
        voice_question=1 if voice else None,
        detected_languages=["hi", "en"] if voice else [],
    )
    sub.result = build_evaluation_result(report, rubric=rubric, created_at=created_at + timedelta(seconds=36))
    return sub


def _release(sub: StudentSubmission) -> None:
    assert sub.result is not None
    reviewed_at = sub.created_at + timedelta(hours=6 + int(_u("release", sub.student_name) * 24))
    sub.result.release_status = ReleaseStatus.RELEASED
    sub.result.reviewed_by = FACULTY
    sub.result.reviewed_at = reviewed_at
    sub.result.review_note = "Sample sign-off: marks checked against the rubric."
    sub.processing_log = [
        *(sub.processing_log or []),
        {"step": "Faculty sign-off", "message": f"Released by {FACULTY} - faculty sign-off recorded (synthetic sample).",
         "timestamp": utc_iso(reviewed_at)},
    ]


def _topic_mastery(sub: StudentSubmission) -> dict[str, float]:
    return {str(t["topic"]): float(t["mastery"]) for t in sub.result.topic_mastery or [] if isinstance(t, dict)}


def _ensure_record(
    session: Session, sub: StudentSubmission, existing: set[tuple[str, str, str]], *, topic: str, kind: str,
    hours: float, compliance: float | None, action: str, applied_at: datetime,
) -> int:
    key = (sub.student_ref or "", topic.casefold(), action)
    if key in existing:
        return 0
    row = outcomes.build_record(
        sub, topic=topic, kind=kind, action=action, applied_by=FACULTY, source="faculty", applied_at=applied_at,
        hours=hours, compliance=compliance, note="Sample intervention (insights sample set).", now=applied_at,
    )
    row.is_demo = True
    session.add(row)
    existing.add(key)
    return 1


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def seed_insights_demo(session: Session) -> int:
    """Seed the insights sample set; returns the number of submissions created (25, then 0)."""
    collisions = name_collisions()
    if collisions:
        raise RuntimeError(f"NEET-C sample names collide with existing demo names: {', '.join(collisions)}")
    batch = seed_sample_batch(session)
    mock09 = seed_sample_rubric(session, MOCK09_FILE)
    mock10 = seed_sample_rubric(session, MOCK10_FILE)
    oral = seed_sample_rubric(session, ORAL_FILE)
    session.flush()
    existing = {
        (s.original_filename, s.rubric_id): s
        for s in session.scalars(select(StudentSubmission).where(StudentSubmission.is_demo.is_(True))).all()
    }
    now = utcnow()
    created = 0
    names = list(STUDENTS)

    m09_subs: dict[str, StudentSubmission] = {}
    for position, name in enumerate(names):
        sub = existing.get((_filename(name, "mock09"), mock09.id))
        if sub is None:
            answers, evaluation = mock09_inputs(name, mock09.content)
            sub = _submission(
                name=name, filename=_filename(name, "mock09"), batch=batch, rubric=mock09, answers=answers,
                evaluation=evaluation, created_at=now - timedelta(days=MOCK09_DAYS, minutes=-7 * position),
            )
            if name in RELEASED:
                _release(sub)
            session.add(sub)
            created += 1
        m09_subs[name] = sub
    session.flush()

    records = {
        (r.student_ref, r.topic.casefold(), r.action)
        for r in session.scalars(select(InterventionRecord).where(InterventionRecord.is_demo.is_(True))).all()
    }
    treated: dict[str, dict[str, tuple[str, float]]] = {}
    for name, topic, kind, hours, compliance, action in INTERVENTIONS:
        treated.setdefault(name, {})[topic] = (kind, compliance)
        applied = now - timedelta(days=APPLIED_DAYS, minutes=-11 * names.index(name))
        _ensure_record(session, m09_subs[name], records, topic=topic, kind=kind, hours=hours, compliance=compliance,
                       action=action, applied_at=applied)

    plan = plan_mock10({name: _topic_mastery(sub) for name, sub in m09_subs.items()}, treated)
    m10_subs: dict[str, StudentSubmission] = {}
    for position, name in enumerate(names):
        sub = existing.get((_filename(name, "mock10"), mock10.id))
        if sub is None:
            answers, evaluation = mock10_inputs(name, mock10.content, plan[name])
            sub = _submission(
                name=name, filename=_filename(name, "mock10"), batch=batch, rubric=mock10, answers=answers,
                evaluation=evaluation, created_at=now - timedelta(days=MOCK10_DAYS, minutes=-7 * position),
            )
            session.add(sub)
            created += 1
        m10_subs[name] = sub
    session.flush()

    for name, topic, kind, hours, action in PENDING:
        _ensure_record(session, m10_subs[name], records, topic=topic, kind=kind, hours=hours, compliance=None,
                       action=action, applied_at=now - timedelta(days=PENDING_DAYS))

    if (VOICE_FILENAME, oral.id) not in existing:
        question = oral.content["questions"][0]
        grade = QuestionGrade(
            question=1,
            estimated_marks=sum(VOICE_AWARDS),
            evidence="Synthetic sample grading of a spoken answer: defines codominance and gives the AB example; "
                     "no I^A / I^B allele notation.",
            strengths=["Defines codominance correctly", "Uses the AB blood group example"],
            gaps=["Missing: allele notation I^A and I^B"],
            criteria_awards=[CriterionAward(index=i, awarded=a) for i, a in enumerate(VOICE_AWARDS)],
            demonstrated_level="K2",
        )
        answers = [OcrAnswer(question=int(question["question"]), answer=VOICE_TRANSCRIPT, confidence=0.85, source="voice")]
        session.add(_submission(
            name=VOICE_STUDENT, filename=VOICE_FILENAME, batch=batch, rubric=oral, answers=answers,
            evaluation=EvaluationOutput(evaluations=[grade], overall_strengths=["Clear spoken definition (sample)"],
                                        overall_gaps=["Allele notation (sample)"], summary=""),
            created_at=now - timedelta(days=VOICE_DAYS), voice=True,
        ))
        created += 1

    session.commit()
    return created
