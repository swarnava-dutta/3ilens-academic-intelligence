// Defensive batch / nudge / focus readers for normalize-roster.ts (older or partial payloads must
// never crash the page).
import { arr, num, numOrNull, obj, str } from "@/lib/coerce";
import type { Batch, FocusItem, Quadrant, TeachingNudge } from "@/lib/types";

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
