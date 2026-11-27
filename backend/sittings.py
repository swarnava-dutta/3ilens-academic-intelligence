"""Test sittings and progress: one set of definitions for the cohort page, the owner dashboard
and the students page, so "latest test", "previous test", "one row per student" and "up 5+" mean
the same thing on every page.

- A *test* is an answer-key family: the root of the Rubric.parent_id chain, so key v1 and the
  v2 it was corrected into count as one test.
- A sheet is ordered by when it was sat: its upload time (submission.created_at), then its id.
  Never result.created_at: a re-grade archives the result and dates the new version now, and
  must not make an old test a student's latest. Every figure comes from the current result
  version (sub.result), so a re-grade changes the marks on every page and the order on none.
- A *sitting* is the pair (batch, test). Inside a sitting each student counts once: their
  latest completed sheet for that test (by `order`).
- A *class sitting* has at least MIN_CLASS_STUDENTS students. A one-student check (an oral
  answer, a single imported paper) can be opened explicitly but is never the default view and
  never the "previous test" a batch is compared with.
- *Progress* pairs a student's sheet with the graded sheet they sat just before it (`pairs`: any
  batch or test, never an oral answer). The pair is *comparable* (`comparable`, the one rule for
  every page) when both are the same test - a retake counts - or both are full papers
  (FULL_PAPER_QUESTIONS+ questions) over the same subjects. Only comparable pairs count: a
  student's change is after - before on the shown 1-dp percentages; mean_before / mean_after are
  exact half-up 1-dp means and mean_change = mean_after - mean_before, so the three shown numbers
  reconcile. A change of +BIG_CHANGE or more is "up 5+", -BIG_CHANGE or less "down 5+", anything
  in between "steady". Any other pair is "not comparable", never up or down.
"""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Sequence
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

import analytics
import voice
from database import Batch, Rubric, StudentSubmission, SubmissionStatus
from hashing import student_key

MIN_CLASS_STUDENTS = 3  # a smaller sitting is never a batch's main test or a progress pair
BIG_CHANGE = 5.0  # "up 5+" / "down 5+"; a smaller change is "steady"
FULL_PAPER_QUESTIONS = 10  # two different tests compare only as full papers (this many questions) over the same subjects

Pair = tuple[StudentSubmission, StudentSubmission]  # one student's (before, after) sheets


def is_completed(sub: StudentSubmission) -> bool:
    """COMPLETED with a usable result (what every report / PDF / card endpoint requires)."""
    result = sub.result
    return (
        sub.status == SubmissionStatus.COMPLETED
        and result is not None
        and bool(result.total_marks)
        and result.total_marks > 0
    )


def sat_at(sub: StudentSubmission) -> datetime:
    """When the sheet was sat: its upload time (a re-grade never moves it)."""
    return sub.created_at or sub.result.created_at


def order(sub: StudentSubmission) -> tuple[datetime, int]:
    """Oldest -> newest: (sat_at, submission id)."""
    return (sat_at(sub), sub.id)


def latest_per_student(subs: Iterable[StudentSubmission]) -> list[StudentSubmission]:
    """The newest completed sheet per student_key, by `order`. Non-completed rows are ignored.
    Order: newest first."""
    latest: dict[str, StudentSubmission] = {}
    for sub in subs:
        if not is_completed(sub):
            continue
        key = student_key(sub)
        current = latest.get(key)
        if current is None or order(sub) > order(current):
            latest[key] = sub
    return sorted(latest.values(), key=order, reverse=True)


class Families:
    """Answer-key families for one request: rubric id -> family root, and each family's versions
    (oldest first). One query over the (small) rubrics table."""

    def __init__(self, db: Session) -> None:
        rows = db.execute(select(Rubric.id, Rubric.parent_id, Rubric.name, Rubric.version, Rubric.total_marks)).all()
        self._parent: dict[int, int | None] = {r.id: r.parent_id for r in rows}
        self._info: dict[int, Any] = {r.id: r for r in rows}
        self._root: dict[int, int] = {}
        self.members: dict[int, list[int]] = {}
        for rid in self._parent:
            self.members.setdefault(self.root(rid), []).append(rid)
        for ids in self.members.values():
            ids.sort()  # a corrected version is always created after (so with a higher id than) its parent

    def root(self, rubric_id: int) -> int:
        if rubric_id in self._root:
            return self._root[rubric_id]
        seen: list[int] = []
        current = rubric_id
        while True:
            seen.append(current)
            parent = self._parent.get(current)
            if parent is None or parent not in self._parent or parent in seen:
                break
            current = parent
        for rid in seen:
            self._root[rid] = current
        return current

    def versions(self, rubric_id: int) -> list[int]:
        """Every version id of rubric_id's family, oldest first."""
        return list(self.members.get(self.root(rubric_id), [rubric_id]))

    def latest(self, rubric_id: int) -> int:
        return self.versions(rubric_id)[-1]

    def name(self, rubric_id: int) -> str:
        info = self._info.get(self.latest(rubric_id))
        return str(info.name) if info is not None else f"Test {rubric_id}"

    def version_label(self, rubric_id: int) -> str:
        info = self._info.get(rubric_id)
        return str(info.version) if info is not None else ""

    def total_marks(self, rubric_id: int) -> float | None:
        info = self._info.get(self.latest(rubric_id))
        return float(info.total_marks) if info is not None and info.total_marks else None

    def known(self, rubric_id: int) -> bool:
        return rubric_id in self._parent


def test_family_id(db: Session, rubric: Rubric | int, families: Families | None = None) -> int:
    """Root of the Rubric.parent_id chain (pass `families` to reuse one per request)."""
    rid = rubric if isinstance(rubric, int) else rubric.id
    return (families or Families(db)).root(rid)


_SUFFIX = re.compile(r"\s*\((?:sample|demo)\)\s*$", re.IGNORECASE)


def short_test_name(name: str) -> str:
    """'NEET MCQ Practice - Mock 09 (sample)' -> 'Mock 09'; 'Biology - Genetics' stays whole (its
    last part names a chapter, not the test). Used where the test is named mid-sentence."""
    text = _SUFFIX.sub("", " ".join((name or "").split()))
    if " - " in text:
        last = text.rsplit(" - ", 1)[1].strip()
        if re.search(r"\d", last):
            return last
    return text


# --------------------------------------------------------------------------- #
# Rounding (half-up 1 dp, exact on the shown values)
# --------------------------------------------------------------------------- #
def _exact(value: float | Decimal) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(repr(float(value)))


def r1(value: float | Decimal) -> float:
    """Half-up to 1 dp: 71.25 -> 71.3 (round() would give 71.2), never float noise."""
    return float(_exact(value).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def mean1(values: Iterable[float]) -> float | None:
    """Exact mean of shown (1-dp) values, half-up to 1 dp: 62.65 -> 62.7 (never float noise)."""
    exact = [_exact(v) for v in values]
    return r1(sum(exact) / len(exact)) if exact else None


def median1(values: Iterable[float]) -> float | None:
    """Exact median of shown (1-dp) values, half-up to 1 dp: (63.5 + 64.6) / 2 -> 64.1."""
    exact = sorted(_exact(v) for v in values)
    if not exact:
        return None
    mid = len(exact) // 2
    return r1(exact[mid] if len(exact) % 2 else (exact[mid - 1] + exact[mid]) / 2)


# --------------------------------------------------------------------------- #
# Sittings
# --------------------------------------------------------------------------- #
def urgency_counts(subs: Iterable[StudentSubmission]) -> dict[str, int]:
    """on_track / needs_attention / at_risk over these sheets (pass one sheet per student)."""
    counts = {level: 0 for level in analytics.URGENCY_LEVELS}
    for sub in subs:
        counts[analytics.result_urgency(sub.result)[0]] += 1
    return counts


def sitting_stats(subs: list[StudentSubmission]) -> dict[str, Any]:
    """average / median of the rounded percentages and the urgency split of a student set."""
    pcts = [analytics.percentage(s.result) for s in subs]
    return {
        "average_pct": mean1(pcts),
        "median_pct": median1(pcts),
        "urgency_counts": urgency_counts(subs),
    }


def class_sittings(
    db: Session,
    subs: Iterable[StudentSubmission],
    min_students: int = MIN_CLASS_STUDENTS,
    families: Families | None = None,
) -> list[dict[str, Any]]:
    """Every (batch, test family) sitting in `subs` (completed sheets only), newest first:
    {batch_id, batch_name, test_id, rubric_ids, latest_rubric_id, key_versions, test_name,
    short_name, total_marks, date, students, sheets, average_pct, median_pct, urgency_counts,
    is_class, comparable_previous, subs}. comparable_previous: whether a class sitting's class
    average compares with the batch's previous class sitting (`comparable` on their newest sheets;
    None without one). date = the newest sheet's sat_at. `subs` is the per-student set, newest
    first (internal; not part of the API shape)."""
    families = families or Families(db)
    groups: dict[tuple[int, int], list[StudentSubmission]] = {}
    for sub in subs:
        if is_completed(sub):
            groups.setdefault((sub.batch_id, families.root(sub.rubric_id)), []).append(sub)
    batches: dict[int, str] = {}
    out = []
    for (batch_id, root), group in groups.items():
        if batch_id not in batches:
            batch = db.get(Batch, batch_id)
            batches[batch_id] = batch.name if batch is not None else f"Batch {batch_id}"
        students = latest_per_student(group)
        used = Counter(s.rubric_id for s in group)
        name = families.name(root)
        out.append({
            "batch_id": batch_id,
            "batch_name": batches[batch_id],
            "test_id": root,
            "rubric_ids": sorted(used),
            "latest_rubric_id": families.latest(root),
            "key_versions": [
                {"rubric_id": rid, "version": families.version_label(rid), "sheets": used[rid],
                 "latest": rid == families.latest(root)}
                for rid in families.versions(root) if used.get(rid)
            ],
            "test_name": name,
            "short_name": short_test_name(name),
            "total_marks": families.total_marks(root),
            "date": sat_at(students[0]),
            "students": len(students),
            "sheets": len(group),
            **sitting_stats(students),
            "is_class": len(students) >= min_students,
            "subs": students,
        })
    out.sort(key=lambda s: (order(s["subs"][0]), s["batch_id"], s["test_id"]), reverse=True)
    for sitting in out:
        before = previous_class_sitting(out, sitting) if sitting["is_class"] else None
        sitting["comparable_previous"] = (
            comparable(before["subs"][0], sitting["subs"][0], families) if before is not None else None
        )
    return out


def previous_class_sitting(sittings: list[dict[str, Any]], current: dict[str, Any]) -> dict[str, Any] | None:
    """The newest class sitting of the same batch before `current` (a different test)."""
    earlier = [
        s for s in sittings
        if s["batch_id"] == current["batch_id"] and s["is_class"] and s["test_id"] != current["test_id"]
        and order(s["subs"][0]) < order(current["subs"][0])
    ]
    return max(earlier, key=lambda s: order(s["subs"][0])) if earlier else None


def latest_class_sitting(sittings: list[dict[str, Any]], batch_id: int | None = None) -> dict[str, Any] | None:
    """The newest class sitting (of batch_id, or of any batch)."""
    return next(
        (s for s in sittings if s["is_class"] and (batch_id is None or s["batch_id"] == batch_id)), None
    )


# --------------------------------------------------------------------------- #
# Progress (same students, an earlier sheet vs a later one)
# --------------------------------------------------------------------------- #
def change_pts(before: float, after: float) -> float:
    """after - before on the shown 1-dp percentages (60.0 - 55.2 = 4.8, never 4.799...)."""
    return r1(_exact(after) - _exact(before))


def movement(change: float) -> str:
    """'up' (+5 or more), 'down' (-5 or less) or 'steady'."""
    return "up" if change >= BIG_CHANGE else ("down" if change <= -BIG_CHANGE else "steady")


def question_count(sub: StudentSubmission) -> int:
    result = sub.result
    items = result.question_evaluations if result is not None else None
    return len([q for q in items or [] if isinstance(q, dict)])


def subject_set(sub: StudentSubmission) -> frozenset[str]:
    """The subjects a sheet covers (the report's subject rollup), case-folded."""
    questions = analytics._question_items(sub.result)
    topic_items = analytics._topic_items(sub.result, questions, sub.rubric)
    return frozenset(
        analytics.norm(s["subject"])
        for s in analytics._subject_rollup(topic_items, questions) if s.get("subject")
    )


def not_comparable_reason(a: StudentSubmission, b: StudentSubmission, families: Families) -> str | None:
    """None when a change between two sheets is progress: the same test (answer-key family; a retake
    counts), or two full papers (FULL_PAPER_QUESTIONS+ questions) over the same subjects. Else why not."""
    if families.root(a.rubric_id) == families.root(b.rubric_id):
        return None
    if subject_set(a) != subject_set(b):
        return "different subjects"
    if min(question_count(a), question_count(b)) < FULL_PAPER_QUESTIONS:
        return f"a short test (under {FULL_PAPER_QUESTIONS} questions)"
    return None


def comparable(a: StudentSubmission, b: StudentSubmission, families: Families) -> bool:
    """The one comparability rule of the owner, cohort and students pages."""
    return not_comparable_reason(a, b, families) is None


def person_key(sub: StudentSubmission) -> tuple[str, bool]:
    """A student: (student_key, is_demo); a real student and a demo namesake never pair."""
    return student_key(sub), bool(sub.is_demo)


def history(db: Session, subs: Iterable[StudentSubmission]) -> list[StudentSubmission]:
    """Every completed sheet of these sheets' students (any batch or test): where `pairs` finds
    each one's earlier sheet."""
    people = {person_key(s) for s in subs}
    if not people:
        return []
    rows = db.scalars(
        select(StudentSubmission)
        .options(selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric))
        .where(
            StudentSubmission.status == SubmissionStatus.COMPLETED,
            or_(StudentSubmission.student_ref.in_(sorted({ref for ref, _demo in people})),
                StudentSubmission.student_ref.is_(None)),
        )
    ).all()
    return [s for s in rows if person_key(s) in people]


def pairs(after: Iterable[StudentSubmission], earlier: Iterable[StudentSubmission]) -> list[Pair]:
    """(before, after) for each sheet in `after` whose student has a completed sheet in `earlier`
    sat before it: the newest such sheet, never an oral answer. In `after` order."""
    by_person: dict[tuple[str, bool], list[StudentSubmission]] = {}
    for sub in earlier:
        if is_completed(sub) and not voice.is_voice(sub):
            by_person.setdefault(person_key(sub), []).append(sub)
    out = []
    for sub in after:
        before = max((s for s in by_person.get(person_key(sub), []) if order(s) < order(sub)), key=order, default=None)
        if before is not None:
            out.append((before, sub))
    return out


def progress(paired: Sequence[Pair], families: Families) -> dict[str, Any]:
    """{students, mean_before, mean_after, mean_change, improved (up 5+), declined (down 5+),
    steady} of the comparable pairs, and not_comparable = the number of other pairs (the module
    docstring's rules)."""
    other = sum(1 for b, a in paired if not comparable(b, a, families))
    paired = [(b, a) for b, a in paired if comparable(b, a, families)]
    if not paired:
        return {"students": 0, "mean_before": None, "mean_after": None, "mean_change": None,
                "improved": 0, "declined": 0, "steady": 0, "not_comparable": other}
    before = mean1(analytics.percentage(b.result) for b, _a in paired)
    after = mean1(analytics.percentage(a.result) for _b, a in paired)
    assert before is not None and after is not None
    moves = Counter(
        movement(change_pts(analytics.percentage(b.result), analytics.percentage(a.result))) for b, a in paired
    )
    return {
        "students": len(paired),
        "mean_before": before,
        "mean_after": after,
        "mean_change": change_pts(before, after),
        "improved": moves["up"],
        "declined": moves["down"],
        "steady": moves["steady"],
        "not_comparable": other,
    }
