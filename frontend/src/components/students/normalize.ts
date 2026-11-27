// Defensive defaults for GET /api/students rows (older or partial payloads must never crash the
// page). The batch / nudge / focus readers are shared with normalize-roster.ts.
import { arr, num, numOrNull, obj, str, strings } from "@/lib/coerce";
import type { Batch, FocusItem, Quadrant, RubricRef, StudentCard, TeachingNudge, TopicPoint, Urgency } from "@/lib/types";

const URGENCIES: Urgency[] = ["on_track", "needs_attention", "at_risk"];
const QUADRANTS: Quadrant[] = ["priority_focus", "maintain", "deprioritise", "no_action"];

export function batchOf(v: unknown): Batch {
  const b = obj(v);
  const mode = b?.strategy_mode;
  return {
    id: num(b?.id),
    name: str(b?.name, "Batch"),
    exam_type: str(b?.exam_type),
    exam: str(b?.exam, "NEET"),
    exam_date: typeof b?.exam_date === "string" ? b.exam_date : null,
    exam_date_assumed: b?.exam_date_assumed === true,
    days_to_exam: numOrNull(b?.days_to_exam),
    strategy_mode:
      mode === "broad" || mode === "focused" || mode === "revision" || mode === "consolidation" ? mode : null,
    faculty_lead: typeof b?.faculty_lead === "string" && b.faculty_lead.trim() ? b.faculty_lead : null,
  };
}

function testOf(v: unknown): RubricRef {
  const t = obj(v);
  return {
    id: num(t?.id),
    version: str(t?.version),
    name: str(t?.name, "Assessment"),
    total_marks: num(t?.total_marks),
    status: t?.status === "FACULTY_APPROVED" ? "FACULTY_APPROVED" : "AUTHOR_DRAFT",
    rubric_hash: str(t?.rubric_hash),
  };
}

export function nudgeOf(v: unknown): TeachingNudge | null {
  const n = obj(v);
  const text = str(n?.text).trim();
  const label = str(n?.label).trim();
  if (!text && !label) return null;
  return {
    priority: n?.priority === "high" || n?.priority === "low" ? n.priority : "medium",
    label,
    text,
    topic: typeof n?.topic === "string" && n.topic ? n.topic : null,
    question_refs: arr(n?.question_refs).filter((q): q is number => typeof q === "number"),
    source: n?.source === "ai" || n?.source === "faculty" ? n.source : "template",
  };
}

function pointOf(v: unknown): TopicPoint {
  const t = obj(v);
  return { topic: str(t?.topic, "Topic"), subject: str(t?.subject), mastery: num(t?.mastery) };
}

export function focusOf(v: unknown, i: number): FocusItem {
  const f = obj(v);
  const q = f?.quadrant;
  return {
    topic: str(f?.topic, "Topic"),
    roi: num(f?.roi),
    rank: num(f?.rank, i + 1),
    projected_gain_marks: numOrNull(f?.projected_gain_marks),
    quadrant: typeof q === "string" && (QUADRANTS as string[]).includes(q) ? (q as Quadrant) : "priority_focus",
  };
}

export function normalizeStudent(v: unknown): StudentCard | null {
  const s = obj(v);
  if (!s || typeof s.submission_id !== "number") return null;
  const status = s.status;
  const urgency = s.urgency;
  return {
    submission_id: s.submission_id,
    student_name: str(s.student_name, "Unnamed student"),
    student_ref: str(s.student_ref),
    batch: batchOf(s.batch),
    test: testOf(s.test),
    status:
      status === "PENDING" ||
      status === "PROCESSING" ||
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "HUMAN_REVIEW_REQUIRED"
        ? status
        : "PENDING",
    score: numOrNull(s.score),
    total_marks: num(s.total_marks),
    percentage: numOrNull(s.percentage),
    urgency: typeof urgency === "string" && (URGENCIES as string[]).includes(urgency) ? (urgency as Urgency) : null,
    strengths: strings(s.strengths),
    gaps: strings(s.gaps),
    nudges: arr(s.nudges)
      .map(nudgeOf)
      .filter((n): n is TeachingNudge => n !== null),
    topic_mastery: arr(s.topic_mastery).map(pointOf),
    top_focus: arr(s.top_focus).map(focusOf),
    release_status: s.release_status === "RELEASED" ? "RELEASED" : s.release_status === "PROVISIONAL" ? "PROVISIONAL" : null,
    is_demo: s.is_demo === true,
    created_at: str(s.created_at),
  };
}

export function normalizeStudents(v: unknown): StudentCard[] {
  return arr(v)
    .map(normalizeStudent)
    .filter((s): s is StudentCard => s !== null);
}
