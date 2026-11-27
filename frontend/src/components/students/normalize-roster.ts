// Defensive defaults for GET /api/students/roster (an older or partial payload must never crash
// the page: missing lists become [], missing numbers 0 / null, unknown enums a safe default).
import { URGENCIES } from "@/components/shared/urgency-badge";
import { arr, num, numOrNull, obj, oneOf, str, strings } from "@/lib/coerce";
import type {
  FocusItem,
  InterventionKind,
  NegativeMarkingBrief,
  OutcomeStatus,
  ReviewReason,
  RiskLevel,
  RosterAction,
  RosterNewer,
  RosterPaper,
  RosterPending,
  RosterPrevious,
  RosterRow,
  RosterSparkPoint,
  RosterSummary,
  RosterTopic,
  RosterTopicMastery,
  StudentRoster,
  SubjectScore,
  SubmissionStatus,
  TeachingNudge,
  Trend,
} from "@/lib/types";
import { shortTest } from "./format";
import { batchOf, focusOf, nudgeOf } from "./normalize";

const STATUSES: SubmissionStatus[] = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "HUMAN_REVIEW_REQUIRED"];
const REASONS: ReviewReason[] = [
  "low_confidence",
  "low_page_confidence",
  "no_answers",
  "mostly_blank",
  "paper_mismatch",
  "paper_reordered",
];
const KINDS: InterventionKind[] = ["nudge", "study_focus", "class_intervention", "custom"];
const OUTCOMES: OutcomeStatus[] = ["pending", "improved", "flat", "declined", "not_assessed"];
const RISKS: RiskLevel[] = ["low", "medium", "high"];
const TRENDS: Trend[] = ["improving", "steady", "slipping"];
const VERDICTS: NegativeMarkingBrief["verdict"][] = ["guessing", "skipping", "ok"];

function oneOfOrNull<T extends string>(v: unknown, options: T[]): T | null {
  return typeof v === "string" && (options as string[]).includes(v) ? (v as T) : null;
}

function paperOf(v: unknown): RosterPaper | null {
  const p = obj(v);
  if (!p || typeof p.submission_id !== "number") return null;
  const name = str(p.test_name, "Assessment");
  return {
    submission_id: p.submission_id,
    test_id: num(p.test_id),
    test_name: name,
    short_name: str(p.short_name) || shortTest(name),
    test_version: str(p.test_version),
    date: str(p.date),
    score: num(p.score),
    total_marks: num(p.total_marks),
    pct: num(p.pct),
    questions: num(p.questions),
    urgency: oneOf(p.urgency, URGENCIES, "needs_attention"),
    urgency_reasons: strings(p.urgency_reasons),
    release_status: p.release_status === "RELEASED" ? "RELEASED" : "PROVISIONAL",
  };
}

function pendingOf(v: unknown): RosterPending | null {
  const p = obj(v);
  if (!p || typeof p.submission_id !== "number") return null;
  return {
    submission_id: p.submission_id,
    status: oneOf(p.status, STATUSES, "PENDING"),
    review_reason: oneOfOrNull(p.review_reason, REASONS),
    date: str(p.date),
  };
}

function previousOf(v: unknown): RosterPrevious | null {
  const p = obj(v);
  if (!p || typeof p.submission_id !== "number") return null;
  const name = str(p.test_name, "Assessment");
  return {
    submission_id: p.submission_id,
    test_name: name,
    short_name: str(p.short_name) || shortTest(name),
    date: str(p.date),
    pct: num(p.pct),
    total_marks: num(p.total_marks),
    questions: num(p.questions),
    // An older payload has no flag: its trend was always computed, so treat the pair as comparable.
    comparable: p.comparable !== false,
  };
}

function newerOf(v: unknown): RosterNewer | null {
  const p = obj(v);
  if (!p || typeof p.submission_id !== "number") return null;
  const name = str(p.test_name, "Assessment");
  return { submission_id: p.submission_id, test_name: name, short_name: str(p.short_name) || shortTest(name), date: str(p.date), pct: num(p.pct) };
}

function sparkOf(v: unknown): RosterSparkPoint | null {
  const p = obj(v);
  if (!p || typeof p.pct !== "number" || !Number.isFinite(p.pct)) return null;
  const name = str(p.test_name);
  return { submission_id: num(p.submission_id), date: str(p.date), pct: p.pct, test_name: name, short_name: str(p.short_name) || shortTest(name) };
}

function subjectOf(v: unknown): SubjectScore | null {
  const s = obj(v);
  if (!s || !str(s.subject)) return null;
  return { subject: str(s.subject), score: num(s.score), max_marks: num(s.max_marks), pct: num(s.pct) };
}

function topicOf(v: unknown): RosterTopicMastery | null {
  const t = obj(v);
  if (!t || !str(t.topic)) return null;
  return { topic: str(t.topic), subject: str(t.subject), mastery: num(t.mastery), n: num(t.n), subject_level: t.subject_level === true };
}

function briefOf(v: unknown): NegativeMarkingBrief | null {
  const b = obj(v);
  if (!b) return null;
  const attempted = num(b.attempted);
  const blank = num(b.blank);
  return {
    scheme: str(b.scheme),
    break_even: num(b.break_even),
    items: num(b.items, attempted + blank),
    attempted,
    correct: num(b.correct),
    wrong: num(b.wrong),
    blank,
    accuracy: numOrNull(b.accuracy),
    marks_lost: num(b.marks_lost),
    risk: oneOf(b.risk, RISKS, "low"),
    under_attempting: b.under_attempting === true,
    recommendation: str(b.recommendation),
    verdict: oneOf(b.verdict, VERDICTS, b.under_attempting === true ? "skipping" : "ok"),
    headline: str(b.headline),
    risky_topics: strings(b.risky_topics),
  };
}

function actionOf(v: unknown): RosterAction | null {
  const a = obj(v);
  if (!a || typeof a.id !== "number") return null;
  return {
    id: a.id,
    topic: str(a.topic, "Topic"),
    kind: oneOf(a.kind, KINDS, "custom"),
    applied_at: str(a.applied_at),
    applied_by: str(a.applied_by),
    outcome_status: oneOf(a.outcome_status, OUTCOMES, "pending"),
    mastery_change: numOrNull(a.mastery_change),
  };
}

function nonNull<T>(items: (T | null)[]): T[] {
  return items.filter((x): x is T => x !== null);
}

export function normalizeRow(v: unknown): RosterRow | null {
  const r = obj(v);
  if (!r || !str(r.student_ref)) return null;
  const actions = obj(r.actions);
  const priority = obj(r.priority);
  const tier = numOrNull(priority?.tier);
  return {
    student_ref: str(r.student_ref),
    student_name: str(r.student_name, "Unnamed student"),
    is_demo: r.is_demo === true,
    batch: batchOf(r.batch),
    latest: paperOf(r.latest),
    pending: pendingOf(r.pending),
    waiting: nonNull(arr(r.waiting).map(pendingOf)),
    newer: newerOf(r.newer),
    previous: previousOf(r.previous),
    delta_pct: numOrNull(r.delta_pct),
    trend: oneOfOrNull(r.trend, TRENDS),
    spark: nonNull(arr(r.spark).map(sparkOf)),
    papers_count: num(r.papers_count),
    subjects: nonNull(arr(r.subjects).map(subjectOf)),
    topics: nonNull(arr(r.topics).map(topicOf)).sort((a, b) => a.mastery - b.mastery),
    weak_count: num(r.weak_count),
    very_weak_count: num(r.very_weak_count),
    negative_marking: briefOf(r.negative_marking),
    nudges: nonNull(arr(r.nudges).map(nudgeOf)) as TeachingNudge[],
    focus: arr(r.focus).map(focusOf) as FocusItem[],
    actions: {
      count: num(actions?.count),
      since_latest: num(actions?.since_latest),
      last: actionOf(actions?.last),
    },
    priority: { tier: tier !== null && tier >= 1 && tier <= 4 ? tier : null, reason: str(priority?.reason) },
  };
}

function topicSummaryOf(v: unknown): RosterTopic | null {
  const t = obj(v);
  if (!t || !str(t.topic)) return null;
  return {
    topic: str(t.topic),
    subject: str(t.subject),
    tested: num(t.tested),
    below_60: num(t.below_60),
    mean_mastery: numOrNull(t.mean_mastery),
    marks_lost: num(t.marks_lost),
    actions_logged: num(t.actions_logged),
    actions_improved: num(t.actions_improved),
    subject_level: t.subject_level === true,
    students_below: nonNull(
      arr(t.students_below).map((s) => {
        const x = obj(s);
        if (!x || !str(x.student_ref)) return null;
        return {
          student_ref: str(x.student_ref),
          is_demo: x.is_demo === true,
          student_name: str(x.student_name, "Unnamed student"),
          mastery: num(x.mastery),
        };
      }),
    ),
  };
}

function summaryOf(v: unknown, rows: RosterRow[]): RosterSummary {
  const s = obj(v);
  const counts = obj(s?.urgency_counts);
  const nm = obj(s?.negative_marking);
  const graded = rows.filter((r) => r.latest).length;
  return {
    students: num(s?.students, rows.length),
    graded: num(s?.graded, graded),
    sheets: num(s?.sheets),
    urgency_counts: {
      on_track: num(counts?.on_track),
      needs_attention: num(counts?.needs_attention),
      at_risk: num(counts?.at_risk),
    },
    held: num(s?.held),
    failed: num(s?.failed),
    processing: num(s?.processing),
    ungraded: num(s?.ungraded, rows.length - graded),
    improving: num(s?.improving),
    slipping: num(s?.slipping),
    steady: num(s?.steady),
    with_trend: num(s?.with_trend),
    different_test: num(s?.different_test),
    waiting_students: num(s?.waiting_students, rows.filter((r) => r.waiting.length > 0).length),
    newer_outside: num(s?.newer_outside),
    at_risk_without_action: num(s?.at_risk_without_action),
    flagged: num(s?.flagged),
    provisional_latest: num(s?.provisional_latest),
    released_latest: num(s?.released_latest),
    demo_students: num(s?.demo_students),
    real_students: num(s?.real_students),
    negative_marking: {
      profiled: num(nm?.profiled),
      guessing_risk: num(nm?.guessing_risk),
      under_attempting: num(nm?.under_attempting),
      flagged: num(nm?.flagged),
      marks_lost_total: num(nm?.marks_lost_total),
      marks_lost_per_paper: num(nm?.marks_lost_per_paper),
      risky_topic_students: num(nm?.risky_topic_students),
    },
  };
}

export function normalizeRoster(v: unknown): StudentRoster {
  const r = obj(v);
  const rows = nonNull(arr(r?.rows).map(normalizeRow));
  const scope = obj(r?.scope);
  return {
    scope: {
      batch_id: numOrNull(scope?.batch_id),
      rubric_id: numOrNull(scope?.rubric_id),
      demo: typeof scope?.demo === "boolean" ? scope.demo : null,
    },
    summary: summaryOf(r?.summary, rows),
    rows,
    topics: nonNull(arr(r?.topics).map(topicSummaryOf)),
    generated_at: str(r?.generated_at),
  };
}
