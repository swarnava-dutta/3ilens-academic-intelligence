// URL state, filtering and sorting for the /students roster. Pure functions: the table, the
// mobile cards and the CSV export all read the same filtered, sorted list.
import { URGENCY_LABELS } from "@/components/shared/urgency-badge";
import type { RosterRow, Urgency } from "@/lib/types";
import { WEAK_MASTERY } from "./format";

export type RosterView = "trend" | "technique" | "waiting" | "flagged" | "ungraded";
export type RosterSort = "priority" | "lowest" | "drop" | "gain" | "name" | "marks_lost";
export type ReleaseFilter = "unreleased" | "released";
export type StudentsTab = "students" | "topics";

export interface RosterParams {
  urgency: Urgency | null;
  view: RosterView | null;
  topic: string | null;
  q: string;
  sort: RosterSort;
  release: ReleaseFilter | null;
}

const URGENCIES: Urgency[] = ["at_risk", "needs_attention", "on_track"];
const VIEWS: RosterView[] = ["trend", "technique", "waiting", "flagged", "ungraded"];
const SORTS: RosterSort[] = ["priority", "lowest", "drop", "gain", "name", "marks_lost"];

export const SORT_LABELS: Record<RosterSort, string> = {
  priority: "Priority",
  lowest: "Lowest score",
  drop: "Biggest drop",
  gain: "Biggest gain",
  name: "Name",
  marks_lost: "Most marks lost",
};

export const VIEW_LABELS: Record<RosterView, string> = {
  trend: "moved 5+ pts since a comparable paper",
  technique: "exam technique flagged",
  waiting: "a sheet held, failed or being marked",
  flagged: "flagged to act on",
  ungraded: "not graded yet",
};

function pick<T extends string>(value: string | null, options: T[]): T | null {
  return value && (options as string[]).includes(value) ? (value as T) : null;
}

export function readRosterParams(params: { get(name: string): string | null }): RosterParams {
  const release = params.get("release");
  return {
    urgency: pick(params.get("urgency"), URGENCIES),
    view: pick(params.get("view"), VIEWS),
    topic: params.get("topic")?.trim() || null,
    q: params.get("q") ?? "",
    sort: pick(params.get("sort"), SORTS) ?? "priority",
    release: release === "unreleased" || release === "released" ? release : null,
  };
}

export function readTab(value: string | null): StudentsTab {
  return value === "topics" ? "topics" : "students";
}

const fold = (text: string) => text.normalize("NFKD").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** The report's attempts insight flags the paper: wrong answers costing marks, or blanks
 * holding the score back (the same verdict the student's report shows). */
export function techniqueFlagged(row: RosterRow): boolean {
  const verdict = row.negative_marking?.verdict;
  return verdict === "guessing" || verdict === "skipping";
}

/** A sheet in scope is held for review, failed or still being marked (summary.waiting_students). */
export function waitingOnFaculty(row: RosterRow): boolean {
  return row.waiting.length > 0;
}

/** A comparable-paper change of 5+ points (the Moving tile's up / down counts). */
export function moved(row: RosterRow): boolean {
  return row.trend === "improving" || row.trend === "slipping";
}

export function weakIn(row: RosterRow, topic: string): boolean {
  const wanted = fold(topic);
  return row.topics.some((t) => fold(t.topic) === wanted && t.mastery < WEAK_MASTERY);
}

export function filterRows(rows: RosterRow[], p: RosterParams): RosterRow[] {
  const q = fold(p.q);
  return rows.filter((r) => {
    if (p.urgency && r.latest?.urgency !== p.urgency) return false;
    switch (p.view) {
      case "trend":
        if (!moved(r)) return false;
        break;
      case "technique":
        if (!techniqueFlagged(r)) return false;
        break;
      case "waiting":
        if (!waitingOnFaculty(r)) return false;
        break;
      case "flagged":
        if (r.priority.tier === null) return false;
        break;
      case "ungraded":
        if (r.latest) return false;
        break;
    }
    if (p.topic && !weakIn(r, p.topic)) return false;
    if (p.release === "released" && r.latest?.release_status !== "RELEASED") return false;
    if (p.release === "unreleased" && (!r.latest || r.latest.release_status === "RELEASED")) return false;
    if (q && !fold(r.student_name).includes(q) && !fold(r.student_ref).includes(q)) return false;
    return true;
  });
}

const byName = (a: RosterRow, b: RosterRow) =>
  a.student_name.localeCompare(b.student_name, undefined, { sensitivity: "base" }) ||
  a.student_ref.localeCompare(b.student_ref) ||
  Number(a.is_demo) - Number(b.is_demo);

/** null sorts last whatever the direction. */
function nullsLast(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

/** Priority order (the server's): tier 1-4 first, then by score, ungraded last. */
function byPriority(a: RosterRow, b: RosterRow): number {
  return (
    Number(!a.latest) - Number(!b.latest) ||
    (a.priority.tier ?? 99) - (b.priority.tier ?? 99) ||
    (a.latest?.pct ?? 0) - (b.latest?.pct ?? 0) ||
    byName(a, b)
  );
}

export function sortRows(rows: RosterRow[], sort: RosterSort, view: RosterView | null): RosterRow[] {
  const compare = (a: RosterRow, b: RosterRow): number => {
    switch (sort) {
      case "lowest":
        return nullsLast(a.latest?.pct ?? null, b.latest?.pct ?? null, 1) || byName(a, b);
      case "drop":
        return nullsLast(a.delta_pct, b.delta_pct, 1) || byPriority(a, b);
      case "gain":
        return nullsLast(a.delta_pct, b.delta_pct, -1) || byPriority(a, b);
      case "name":
        return byName(a, b);
      case "marks_lost":
        return (
          nullsLast(a.negative_marking?.marks_lost ?? null, b.negative_marking?.marks_lost ?? null, -1) ||
          byPriority(a, b)
        );
      default:
        return byPriority(a, b);
    }
  };
  const out = [...rows];
  if (view === "trend" && sort === "priority") {
    // Slipping first (biggest drop first), then improving (biggest gain first).
    const down = (r: RosterRow) => (r.trend === "slipping" ? 0 : 1);
    out.sort(
      (a, b) =>
        down(a) - down(b) ||
        (a.trend === "slipping" ? (a.delta_pct ?? 0) - (b.delta_pct ?? 0) : (b.delta_pct ?? 0) - (a.delta_pct ?? 0)) ||
        byPriority(a, b),
    );
  } else if (view === "waiting" && sort === "priority") {
    // Students with nothing graded first (the sheet is all there is), then the rest by priority.
    out.sort((a, b) => Number(!!a.latest) - Number(!!b.latest) || compare(a, b));
  } else {
    out.sort(compare);
  }
  return out;
}

/** Segment counts for the status control under every other active filter (view, topic, release,
 * search), so a segment's number is always the number of rows it shows. */
export function segmentCounts(rows: RosterRow[], p: RosterParams): Record<"all" | Urgency | "ungraded", number> {
  const base = filterRows(rows, { ...p, urgency: null, view: p.view === "ungraded" ? null : p.view });
  const count = (u: Urgency) => base.filter((r) => r.latest?.urgency === u).length;
  return {
    all: base.length,
    at_risk: count("at_risk"),
    needs_attention: count("needs_attention"),
    on_track: count("on_track"),
    ungraded: base.filter((r) => !r.latest).length,
  };
}

/** "At risk · Electrostatics below 60% · matching “riya”" for the narrowed-roster line. */
export function describeNarrowing(p: RosterParams): string[] {
  const parts: string[] = [];
  if (p.urgency) parts.push(URGENCY_LABELS[p.urgency]);
  if (p.view) parts.push(VIEW_LABELS[p.view]);
  if (p.topic) parts.push(`${p.topic} below ${WEAK_MASTERY}%`);
  if (p.release) parts.push(p.release === "released" ? "released" : "not released");
  if (p.q.trim()) parts.push(`matching “${p.q.trim()}”`);
  return parts;
}

export function isNarrowed(p: RosterParams): boolean {
  return describeNarrowing(p).length > 0;
}

/** Rows to act on first: flagged rows (tier 1-4) in priority order. */
export function actFirstRows(rows: RosterRow[]): RosterRow[] {
  return rows.filter((r) => r.priority.tier !== null).sort(byPriority);
}
