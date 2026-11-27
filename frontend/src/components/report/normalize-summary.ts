// Defaults for the report-redesign fields of GET /api/results/{id}: key_insights, score_band,
// focus_topics, the extended subject_rollup and the pattern additions. The server builds all of
// them; an older payload gets an empty list (key insights: never guessed in the browser) or the
// same counts read off the question rows, so the page still renders with one set of numbers.
import { AT_RISK_BELOW, ON_TRACK_FROM, URGENCIES, URGENCY_LABELS, urgencyOf } from "@/components/shared/urgency-badge";
import { arr, num, numOrNull, nums, obj, oneOf, str } from "@/lib/coerce";
import { plural } from "@/lib/format";
import type {
  BloomBucket,
  FatigueProfile,
  FocusAction,
  FocusTopicRow,
  FocusTopics,
  KeyInsight,
  KeyInsightEvidence,
  KeyInsightFigure,
  QuestionEvaluation,
  ScoreBand,
  ScoreBandRange,
  StudentPatterns,
  SubjectDiagnosis,
  SubjectPacing,
  SubjectRollup,
  TopicMastery,
  Urgency,
} from "@/lib/types";

/** The ROI engine's target mastery (backend analytics.TARGET_MASTERY). */
export const TARGET_MASTERY = 85;

type Rec = Record<string, unknown>;

/** 2 decimals: drops binary noise (0.85 x 180 = 152.99999...). */
const tidy = (n: number) => Math.round(n * 100) / 100;

/** max(0, 0.85 x max - score) on unrounded marks. */
export function gainToTarget(score: number, max: number): number {
  return Math.max(0, tidy((TARGET_MASTERY / 100) * max - score));
}

/** Question number -> subject, from the topic rows' question lists. */
export function subjectMap(topics: TopicMastery[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const t of topics) for (const n of t.questions) if (!map.has(n)) map.set(n, t.subject);
  return map;
}

/** Counts by result_kind for a set of questions. */
export function kindCounts(qs: QuestionEvaluation[]) {
  const k = (kind: QuestionEvaluation["result_kind"]) => qs.filter((q) => q.result_kind === kind).length;
  const right = k("right");
  const wrong = k("wrong");
  const partial = k("partial");
  const zero = k("zero");
  return {
    right,
    wrong,
    blank: k("blank"),
    bonus: k("bonus"),
    partial,
    zero,
    attempted: right + wrong + partial + zero,
    penalty: qs.reduce((s, q) => s + Math.max(0, q.penalty || 0), 0),
    bonusMarks: qs.filter((q) => q.result_kind === "bonus").reduce((s, q) => s + q.estimated_marks, 0),
  };
}

/** skipping (blanks >= 2x wrong), wrong_answers (wrong >= 2x blanks), mixed, or solid (>= 70%). */
export function diagnose(pct: number, wrong: number, blank: number): SubjectDiagnosis {
  if (pct >= ON_TRACK_FROM) return "solid";
  if (wrong + blank === 0) return "mixed";
  if (blank >= 2 * wrong) return "skipping";
  if (wrong >= 2 * blank) return "wrong_answers";
  return "mixed";
}

const DIAGNOSES: SubjectDiagnosis[] = ["skipping", "wrong_answers", "mixed", "solid"];

/**
 * The redesign's subject fields (right / wrong / blank / bonus, attempt rate, right-when-answered,
 * penalty, gain to 85%, band, diagnosis): the API's values when sent, else the same counts read off
 * the question rows.
 */
export function withSubjectExtras(
  rows: SubjectRollup[],
  raw: unknown,
  questions: QuestionEvaluation[],
  subjectOf: Map<number, string>,
): SubjectRollup[] {
  const given = new Map(arr(raw).map((r) => [str(obj(r)?.subject), obj(r) ?? {}] as const));
  return rows.map((row) => {
    const s = given.get(row.subject) ?? {};
    let qs = questions.filter((q) => subjectOf.get(q.question) === row.subject);
    if (!qs.length && rows.length === 1) qs = questions;
    const c = kindCounts(qs);
    const n = row.questions || qs.length;
    const right = num(s.right, c.right);
    const wrong = num(s.wrong, c.wrong);
    const blank = num(s.blank_scorable, c.blank);
    const bonus = num(s.bonus, c.bonus);
    const attempted = num(s.attempted, c.attempted);
    const pct = row.max_marks > 0 ? (row.score / row.max_marks) * 100 : 0;
    const scorable = n - bonus;
    // Rows built from topic rows without outcome counts: read them off the questions.
    const noCounts = row.full + row.partial + row.zero + row.blank === 0 && qs.length > 0;
    return {
      ...row,
      ...(noCounts ? { full: c.right + c.bonus, partial: c.partial, zero: c.zero + c.wrong, blank: c.blank } : {}),
      right,
      wrong,
      blank_scorable: blank,
      bonus,
      bonus_marks: num(s.bonus_marks, c.bonusMarks),
      attempted,
      attempt_rate: "attempt_rate" in s ? numOrNull(s.attempt_rate) : scorable > 0 ? attempted / scorable : null,
      accuracy_attempted:
        "accuracy_attempted" in s ? numOrNull(s.accuracy_attempted) : attempted > 0 ? right / attempted : null,
      penalty: num(s.penalty, c.penalty),
      marks_dropped: num(s.marks_dropped, tidy(row.max_marks - row.score)),
      gain_to_target: num(s.gain_to_target, gainToTarget(row.score, row.max_marks)),
      band: oneOf(s.band, URGENCIES, urgencyOf(pct)),
      diagnosis: DIAGNOSES.includes(s.diagnosis as SubjectDiagnosis)
        ? (s.diagnosis as SubjectDiagnosis)
        : diagnose(pct, wrong + c.zero, blank),
    };
  });
}

// --------------------------------------------------------------------------- //
// Key insights (server only)
// --------------------------------------------------------------------------- //

function normalizeFigure(raw: unknown): KeyInsightFigure | null {
  const f = obj(raw);
  if (!f) return null;
  const value = typeof f.value === "number" || typeof f.value === "string" ? f.value : null;
  if (value === null) return null;
  return {
    key: str(f.key),
    label: str(f.label, str(f.key)),
    value,
    unit: typeof f.unit === "string" ? f.unit : null,
    formula: typeof f.formula === "string" && f.formula.trim() ? f.formula : null,
  };
}

function normalizeEvidence(raw: unknown): KeyInsightEvidence | null {
  const e = obj(raw);
  if (!e) return null;
  const anchor = str(e.anchor).replace(/^#/, "").trim();
  const kind = e.kind === "subject" || e.kind === "topic" ? e.kind : "questions";
  return {
    kind,
    filter: e.filter === "wrong" || e.filter === "blank" ? e.filter : null,
    refs: nums(e.refs),
    subject: typeof e.subject === "string" ? e.subject : null,
    topic: typeof e.topic === "string" ? e.topic : null,
    anchor: anchor || (kind === "questions" ? "questions" : kind === "subject" ? "subjects" : "focus"),
  };
}

/** At most three server insights with a headline; an older payload has none ([]). */
export function normalizeKeyInsights(raw: unknown): KeyInsight[] {
  return arr(raw)
    .map((item): KeyInsight | null => {
      const i = obj(item);
      const headline = str(i?.headline).trim();
      if (!i || !headline) return null;
      return {
        id: str(i.id, "insight"),
        tone: i.tone === "good" || i.tone === "warn" ? i.tone : "neutral",
        headline,
        detail: str(i.detail).trim(),
        figures: arr(i.figures)
          .map(normalizeFigure)
          .filter((f): f is KeyInsightFigure => f !== null),
        evidence: normalizeEvidence(i.evidence),
        highlight: str(i.highlight).trim() || null,
      };
    })
    .filter((i): i is KeyInsight => i !== null)
    .slice(0, 3);
}

// --------------------------------------------------------------------------- //
// Score band
// --------------------------------------------------------------------------- //

/** The modal max marks of a non-bonus question (4 on a +4/-1 paper). */
export function modalMarks(questions: QuestionEvaluation[]): number {
  const counts = new Map<number, number>();
  for (const q of questions) if (!q.bonus && q.max_marks > 0) counts.set(q.max_marks, (counts.get(q.max_marks) ?? 0) + 1);
  let best = 0;
  let seen = 0;
  for (const [marks, n] of counts) if (n > seen) [best, seen] = [marks, n];
  return best;
}

function bandRanges(total: number): ScoreBandRange[] {
  const lo = tidy((AT_RISK_BELOW / 100) * total);
  const hi = tidy((ON_TRACK_FROM / 100) * total);
  return [
    { key: "at_risk", label: URGENCY_LABELS.at_risk, from_marks: 0, to_marks: lo, from_pct: 0, to_pct: AT_RISK_BELOW },
    {
      key: "needs_attention",
      label: URGENCY_LABELS.needs_attention,
      from_marks: lo,
      to_marks: hi,
      from_pct: AT_RISK_BELOW,
      to_pct: ON_TRACK_FROM,
    },
    { key: "on_track", label: URGENCY_LABELS.on_track, from_marks: hi, to_marks: total, from_pct: ON_TRACK_FROM, to_pct: 100 },
  ];
}

/** The server's score_band, else the same rule (urgency cut points, target = the On track line). */
export function normalizeScoreBand(
  raw: unknown,
  ctx: { score: number; total: number; urgency: Urgency; questions: QuestionEvaluation[] },
): ScoreBand | null {
  if (!(ctx.total > 0)) return null;
  const b = obj(raw);
  const derivedRanges = bandRanges(ctx.total);
  const ranges = arr(b?.thresholds)
    .map((r): ScoreBandRange | null => {
      const t = obj(r);
      if (!t || typeof t.from_marks !== "number" || typeof t.to_marks !== "number") return null;
      const key = oneOf(t.key, URGENCIES, "needs_attention");
      return {
        key,
        label: str(t.label, URGENCY_LABELS[key]),
        from_marks: t.from_marks,
        to_marks: t.to_marks,
        from_pct: num(t.from_pct, (t.from_marks / ctx.total) * 100),
        to_pct: num(t.to_pct, (t.to_marks / ctx.total) * 100),
      };
    })
    .filter((r): r is ScoreBandRange => r !== null)
    .sort((a, c) => a.from_marks - c.from_marks);
  const target = num(b?.target_marks, tidy((ON_TRACK_FROM / 100) * ctx.total));
  const toTarget = num(b?.marks_to_target, Math.max(0, tidy(target - ctx.score)));
  const per = modalMarks(ctx.questions);
  const key = oneOf(b?.key, URGENCIES, ctx.urgency);
  return {
    key,
    label: str(b?.label, URGENCY_LABELS[key]),
    pct: num(b?.pct, (ctx.score / ctx.total) * 100),
    thresholds: ranges.length >= 2 ? ranges : derivedRanges,
    target_marks: target,
    target_pct: num(b?.target_pct, (target / ctx.total) * 100),
    target_source: b?.target_source === "batch_target" ? "batch_target" : "on_track_line",
    marks_to_target: toTarget,
    right_answers_to_target: num(b?.right_answers_to_target, per > 0 ? Math.ceil(toTarget / per) : 0),
    batch_median_marks: numOrNull(b?.batch_median_marks),
  };
}

// --------------------------------------------------------------------------- //
// Focus list
// --------------------------------------------------------------------------- //

const ACTIONS: FocusAction[] = ["learn", "drill", "fix_errors", "review"];

/** learn (low and mostly unseen), drill (more wrong than blank), review (>= 70%). */
function focusAction(mastery: number, wrong: number, blank: number): FocusAction {
  if (mastery >= ON_TRACK_FROM) return "review";
  if (wrong > blank) return "drill";
  return "learn";
}

function studySentence(action: FocusAction, wrong: number, blank: number): string {
  if (action === "review") {
    return wrong + blank
      ? `Quick review: go back over the ${plural(wrong + blank, "question")} you missed.`
      : "Quick review to keep it at this level.";
  }
  if (action === "learn") {
    const parts = [
      blank ? `work through the ${plural(blank, "question")} you left blank` : "",
      wrong ? `re-solve the ${plural(wrong, "wrong answer")}` : "",
    ].filter(Boolean);
    return parts.length ? `Learn the basics, then ${parts.join(" and ")}.` : "Learn the basics of this chapter.";
  }
  return `Re-solve the ${plural(wrong, "wrong answer")} and find the step that went wrong${
    blank ? `, then try the ${plural(blank, "question")} you left blank` : ""
  }.`;
}

/** Wrong first, then blank, each in paper order. */
function missedRefs(qs: QuestionEvaluation[]): number[] {
  const sorted = [...qs].sort((a, b) => a.question - b.question);
  return [
    ...sorted.filter((q) => q.result_kind === "wrong" || q.result_kind === "zero" || q.result_kind === "partial"),
    ...sorted.filter((q) => q.result_kind === "blank"),
  ].map((q) => q.question);
}

function normalizeFocusRow(raw: unknown): FocusTopicRow | null {
  const r = obj(raw);
  const topic = str(r?.topic).trim();
  if (!r || !topic) return null;
  const score = num(r.score);
  const max = num(r.max_marks);
  const mastery = num(r.mastery, max > 0 ? (score / max) * 100 : 0);
  const wrong = num(r.wrong);
  const blank = num(r.blank);
  const action = ACTIONS.includes(r.action as FocusAction) ? (r.action as FocusAction) : focusAction(mastery, wrong, blank);
  const n = num(r.n);
  return {
    topic,
    subject: str(r.subject),
    n,
    score,
    max_marks: max,
    mastery,
    right: num(r.right),
    wrong,
    blank,
    marks_dropped: num(r.marks_dropped, tidy(max - score)),
    gain: num(r.gain, gainToTarget(score, max)),
    action,
    what_to_study: str(r.what_to_study).trim() || studySentence(action, wrong, blank),
    question_refs: nums(r.question_refs),
    ...(Array.isArray(r.wrong_refs) ? { wrong_refs: nums(r.wrong_refs) } : {}),
    ...(Array.isArray(r.blank_refs) ? { blank_refs: nums(r.blank_refs) } : {}),
    low_evidence: typeof r.low_evidence === "boolean" ? r.low_evidence : n > 0 && n < 3,
  };
}

/** True when the topic rows are chapters inside subjects, not the subjects themselves. */
export function chapterLevel(topics: TopicMastery[]): boolean {
  return topics.length >= 2 && topics.some((t) => t.topic !== t.subject);
}

/** The server's focus list, else the same gain rule over chapters (or subjects when no chapters were read). */
export function normalizeFocusTopics(
  raw: unknown,
  ctx: { topics: TopicMastery[]; subjects: SubjectRollup[]; questions: QuestionEvaluation[] },
): FocusTopics {
  const f = obj(raw);
  if (f && Array.isArray(f.rows)) {
    const level = f.level === "chapter" ? "chapter" : "subject";
    return {
      level,
      chapters_available: typeof f.chapters_available === "boolean" ? f.chapters_available : level === "chapter",
      reason: str(f.reason),
      target_pct: num(f.target_pct, 85),
      rows: f.rows
        .map(normalizeFocusRow)
        .filter((r): r is FocusTopicRow => r !== null)
        .slice(0, 5),
      keep_warm: arr(f.keep_warm)
        .map((item) => {
          const w = obj(item);
          const topic = str(w?.topic).trim();
          return w && topic ? { topic, subject: str(w.subject), mastery: num(w.mastery) } : null;
        })
        .filter((w): w is { topic: string; subject: string; mastery: number } => w !== null),
      keep_warm_more: num(f.keep_warm_more),
    };
  }
  const byNumber = new Map(ctx.questions.map((q) => [q.question, q]));
  const chapters = chapterLevel(ctx.topics);
  const units = chapters
    ? ctx.topics.map((t) => ({
        topic: t.topic,
        subject: t.subject,
        score: t.score,
        max: t.max_marks,
        qs: t.questions.map((n) => byNumber.get(n)).filter((q): q is QuestionEvaluation => !!q),
      }))
    : ctx.subjects.map((s) => {
        const owners = new Set(ctx.topics.filter((t) => t.subject === s.subject).flatMap((t) => t.questions));
        return {
          topic: s.subject,
          subject: s.subject,
          score: s.score,
          max: s.max_marks,
          qs: ctx.questions.filter((q) => owners.has(q.question) || ctx.subjects.length === 1),
        };
      });
  const rows = units
    .map((u): FocusTopicRow => {
      const c = kindCounts(u.qs);
      const mastery = u.max > 0 ? (u.score / u.max) * 100 : 0;
      const wrong = c.wrong + c.zero + c.partial;
      const action = focusAction(mastery, wrong, c.blank);
      return {
        topic: u.topic,
        subject: u.subject,
        n: u.qs.length,
        score: u.score,
        max_marks: u.max,
        mastery,
        right: c.right,
        wrong,
        blank: c.blank,
        marks_dropped: tidy(u.max - u.score),
        gain: gainToTarget(u.score, u.max),
        action,
        what_to_study: studySentence(action, wrong, c.blank),
        question_refs: missedRefs(u.qs),
        low_evidence: u.qs.length > 0 && u.qs.length < 3,
      };
    })
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain || a.mastery - b.mastery || a.topic.localeCompare(b.topic))
    .slice(0, 5);
  return {
    level: chapters ? "chapter" : "subject",
    chapters_available: chapters,
    reason: chapters ? "" : "This sheet was graded before chapters were read from the paper.",
    rows,
  };
}

// --------------------------------------------------------------------------- //
// Patterns
// --------------------------------------------------------------------------- //

function normalizeBloom(raw: unknown): { buckets: BloomBucket[]; informative: boolean | null } {
  const asObject = obj(raw);
  const items = Array.isArray(raw) ? raw : arr(asObject?.buckets ?? asObject?.levels ?? asObject?.rows);
  const buckets = items
    .map((b) => obj(b))
    .filter((b): b is Rec => !!b && typeof b.level === "string")
    .map((b) => ({
      level: b.level as BloomBucket["level"],
      questions: num(b.questions),
      marks: num(b.marks),
      max_marks: num(b.max_marks),
      accuracy: numOrNull(b.accuracy),
      marks_before_penalty: numOrNull(b.marks_before_penalty),
    }));
  return { buckets, informative: typeof asObject?.informative === "boolean" ? asObject.informative : null };
}

/** First half vs second half of each subject's section, on answered (non-bonus) questions only. */
export function subjectPacing(questions: QuestionEvaluation[], subjectOf: Map<number, string>): SubjectPacing[] {
  const groups = new Map<string, QuestionEvaluation[]>();
  for (const q of [...questions].sort((a, b) => a.question - b.question)) {
    const s = subjectOf.get(q.question);
    if (s) groups.set(s, [...(groups.get(s) ?? []), q]);
  }
  return [...groups].flatMap(([subject, qs]) => {
    if (qs.length < 4) return [];
    const cut = Math.ceil(qs.length / 2);
    const half = (part: QuestionEvaluation[]) => {
      const answered = part.filter((q) => q.result_kind === "right" || q.result_kind === "wrong");
      const right = answered.filter((q) => q.result_kind === "right").length;
      return { right, attempted: answered.length, accuracy: answered.length ? right / answered.length : null };
    };
    const a = half(qs.slice(0, cut));
    const b = half(qs.slice(cut));
    return [
      {
        subject,
        first_from: qs[0].question,
        first_to: qs[cut - 1].question,
        second_from: qs[cut].question,
        second_to: qs[qs.length - 1].question,
        first_right: a.right,
        first_attempted: a.attempted,
        second_right: b.right,
        second_attempted: b.attempted,
        first_accuracy: a.accuracy,
        second_accuracy: b.accuracy,
        change_pts: a.accuracy !== null && b.accuracy !== null ? tidy((b.accuracy - a.accuracy) * 100) : null,
      },
    ];
  });
}

function normalizePacing(raw: unknown): SubjectPacing[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((p) => obj(p))
    .filter((p): p is Rec => !!p && typeof p.subject === "string")
    .map((p) => {
      const first = numOrNull(p.first_accuracy);
      const second = numOrNull(p.second_accuracy);
      return {
        subject: str(p.subject),
        first_from: num(p.first_from),
        first_to: num(p.first_to),
        second_from: num(p.second_from),
        second_to: num(p.second_to),
        first_right: num(p.first_right),
        first_attempted: num(p.first_attempted),
        second_right: num(p.second_right),
        second_attempted: num(p.second_attempted),
        first_accuracy: first,
        second_accuracy: second,
        change_pts: numOrNull(p.change_pts) ?? (first !== null && second !== null ? tidy((second - first) * 100) : null),
      };
    });
}

/** Patterns with defaults: Bloom informative flag, pacing within each subject (answered questions only). */
export function normalizePatterns(raw: unknown, questions: QuestionEvaluation[], subjectOf?: Map<number, string>): StudentPatterns {
  const p = obj(raw);
  const bloom = normalizeBloom(p?.bloom_profile);
  const levels = new Set(questions.map((q) => q.bloom_level).filter(Boolean));
  const allHeuristic = questions.length > 0 && questions.every((q) => q.bloom_source === "heuristic" || !q.bloom_source);
  const informative =
    typeof p?.bloom_informative === "boolean"
      ? p.bloom_informative
      : (bloom.informative ?? (bloom.buckets.length >= 2 && levels.size >= 2 && !allHeuristic));
  const fatigueRaw = obj(p?.fatigue) as (FatigueProfile & Rec) | null;
  const fatigue: FatigueProfile | null = fatigueRaw
    ? {
        ...fatigueRaw,
        series: arr(fatigueRaw.series) as FatigueProfile["series"],
        reasons: arr(fatigueRaw.reasons).filter((r): r is string => typeof r === "string"),
        within_subject:
          normalizePacing(fatigueRaw.within_subject) ?? (subjectOf ? subjectPacing(questions, subjectOf) : null),
        within_subject_change_pts: numOrNull(fatigueRaw.within_subject_change_pts),
        confounded_by_section:
          typeof fatigueRaw.confounded_by_section === "boolean" ? fatigueRaw.confounded_by_section : null,
      }
    : null;
  return {
    negative_marking: (obj(p?.negative_marking) as StudentPatterns["negative_marking"]) ?? null,
    fatigue,
    transfer: (obj(p?.transfer) as StudentPatterns["transfer"]) ?? null,
    bloom_profile: bloom.buckets,
    notes: arr(p?.notes).filter((n): n is string => typeof n === "string"),
    bloom_informative: informative,
  };
}
