// Defensive defaults for GET /api/results/{id}. Older API builds omit newer fields and older rows
// predate contract v2, so every field the report reads is defaulted here; components can then
// trust the shape (arrays are arrays, objects exist) without crashing the demo.
import type {
  Batch,
  BloomLevel,
  BloomSource,
  CalendarBlock,
  CalendarDay,
  CostSummary,
  Custody,
  Delivery,
  Deprioritised,
  EffortFlag,
  EvaluationVersion,
  Extraction,
  HistoryEntry,
  MarkingAward,
  OutcomeCounts,
  PlanTopic,
  Priority,
  QuestionEvaluation,
  QuestionOutcome,
  ReleaseInfo,
  ReportMeta,
  Result,
  RoadmapStage,
  RoiBasis,
  RoiExplanation,
  RoiInputs,
  RubricRef,
  ScoringControls,
  StudyPlan,
  SubjectRollup,
  Submission,
  TeachingNudge,
  TopicMastery,
  Urgency,
} from "@/lib/types";

type Loose<T> = { [K in keyof T]?: unknown } | null | undefined;

function obj<T>(value: unknown): Loose<T> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose<T>) : null;
}

export function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => v !== null && v !== undefined) as T[]) : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nums(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
}

const URGENCIES: Urgency[] = ["on_track", "needs_attention", "at_risk"];
const BLOOM_LEVELS: BloomLevel[] = ["K1", "K2", "K3", "K4", "K5"];
const BLOOM_SOURCES: BloomSource[] = ["faculty", "ai", "heuristic"];

function bloomLevel(value: unknown): BloomLevel | null {
  return BLOOM_LEVELS.includes(value as BloomLevel) ? (value as BloomLevel) : null;
}

function bloomSource(value: unknown): BloomSource | null {
  return BLOOM_SOURCES.includes(value as BloomSource) ? (value as BloomSource) : null;
}

export function urgencyFromPct(pct: number): Urgency {
  if (pct >= 70) return "on_track";
  if (pct >= 55) return "needs_attention";
  return "at_risk";
}

function outcomeOf(q: Loose<QuestionEvaluation>): QuestionOutcome {
  const given = q?.outcome;
  if (given === "FULL" || given === "PARTIAL" || given === "ZERO" || given === "BLANK") return given;
  const answer = str(q?.student_answer).trim();
  const marks = num(q?.estimated_marks);
  const max = num(q?.max_marks);
  if (!answer) return "BLANK";
  if (max > 0 && marks >= max) return "FULL";
  if (marks <= 0) return "ZERO";
  return "PARTIAL";
}

function normalizeQuestion(raw: unknown): QuestionEvaluation {
  const q = obj<QuestionEvaluation>(raw);
  return {
    question: num(q?.question),
    topic: str(q?.topic, "Untitled topic"),
    estimated_marks: num(q?.estimated_marks),
    max_marks: num(q?.max_marks),
    evidence: str(q?.evidence),
    strengths: strings(q?.strengths),
    gaps: strings(q?.gaps),
    student_answer: str(q?.student_answer),
    confidence: num(q?.confidence),
    outcome: outcomeOf(q),
    source_pages: nums(q?.source_pages),
    uncertain_words: arr<{ text?: unknown; confidence?: unknown }>(q?.uncertain_words)
      .map((w) => ({ text: str(w?.text), confidence: num(w?.confidence) }))
      .filter((w) => w.text.trim() !== ""),
    corrected_by_faculty: bool(q?.corrected_by_faculty),
    // contract v3 fields
    question_type: q?.question_type === "mcq" ? "mcq" : "descriptive",
    bloom_level: bloomLevel(q?.bloom_level),
    bloom_source: bloomSource(q?.bloom_source),
    demonstrated_level: bloomLevel(q?.demonstrated_level),
    concept: strOrNull(q?.concept),
    penalty: num(q?.penalty),
    selected_option: strOrNull(q?.selected_option),
    correct_option: strOrNull(q?.correct_option),
    marking_breakdown: arr<Loose<MarkingAward>>(q?.marking_breakdown).map((m) => ({
      criterion: str(m?.criterion),
      marks: num(m?.marks),
      awarded: num(m?.awarded),
      required: bool(m?.required),
    })),
    marking_note: strOrNull(q?.marking_note),
  };
}

function normalizeTopic(raw: unknown): TopicMastery {
  const t = obj<TopicMastery>(raw);
  return {
    topic: str(t?.topic, "Untitled topic"),
    subject: str(t?.subject, "—"),
    score: num(t?.score),
    max_marks: num(t?.max_marks),
    mastery: num(t?.mastery),
    weightage: num(t?.weightage),
    effort_hours: num(t?.effort_hours),
    chapter: strOrNull(t?.chapter),
    questions: nums(t?.questions),
    n: num(t?.n, nums(t?.questions).length),
    full: num(t?.full),
    partial: num(t?.partial),
    zero: num(t?.zero),
    blank: num(t?.blank),
    priority_rank: numOrNull(t?.priority_rank),
  };
}

function normalizePriority(raw: unknown): Priority {
  const p = obj<Priority>(raw);
  const iv = obj<NonNullable<Priority["intervention"]>>(p?.intervention);
  const source = iv?.source === "ai" || iv?.source === "faculty" ? iv.source : "template";
  return {
    topic: str(p?.topic, "Untitled topic"),
    subject: str(p?.subject, "—"),
    roi: num(p?.roi),
    weightage: num(p?.weightage),
    gain_potential: num(p?.gain_potential),
    effort_hours: num(p?.effort_hours),
    rationale: str(p?.rationale),
    mastery: num(p?.mastery),
    projected_gain_marks: numOrNull(p?.projected_gain_marks),
    target_mastery: numOrNull(p?.target_mastery),
    gain_low: numOrNull(p?.gain_low),
    gain_high: numOrNull(p?.gain_high),
    trigger_questions: nums(p?.trigger_questions),
    intervention: iv
      ? {
          teach: str(iv.teach),
          practice: str(iv.practice),
          check_criterion: str(iv.check_criterion),
          source,
        }
      : null,
    qualitative_rank: numOrNull(p?.qualitative_rank),
    calibrated: bool(p?.calibrated),
  };
}

function normalizeNudge(raw: unknown): TeachingNudge | null {
  const n = obj<TeachingNudge>(raw);
  const text = str(n?.text).trim();
  const label = str(n?.label).trim();
  if (!text && !label) return null;
  const priority = n?.priority === "high" || n?.priority === "low" ? n.priority : "medium";
  const source = n?.source === "ai" || n?.source === "faculty" ? n.source : "template";
  return { priority, label, text, topic: strOrNull(n?.topic), question_refs: nums(n?.question_refs), source };
}

function normalizeBatch(raw: unknown, fallbackId: number): Batch {
  const b = obj<Batch>(raw);
  const mode = b?.strategy_mode;
  return {
    id: num(b?.id, fallbackId),
    name: str(b?.name, "Batch"),
    exam_type: str(b?.exam_type),
    exam: str(b?.exam, "NEET"),
    exam_date: strOrNull(b?.exam_date),
    exam_date_assumed: bool(b?.exam_date_assumed),
    days_to_exam: numOrNull(b?.days_to_exam),
    strategy_mode:
      mode === "broad" || mode === "focused" || mode === "revision" || mode === "consolidation" ? mode : null,
    faculty_lead: strOrNull(b?.faculty_lead),
  };
}

function outcomeCounts(raw: unknown, questions: QuestionEvaluation[]): OutcomeCounts {
  const o = obj<OutcomeCounts>(raw);
  const count = (k: QuestionOutcome) => questions.filter((q) => q.outcome === k).length;
  const derived = {
    full: count("FULL"),
    partial: count("PARTIAL"),
    zero: count("ZERO"),
    blank: count("BLANK"),
    mapped: questions.length,
    total_questions: questions.length,
  };
  if (!o) return derived;
  return {
    full: num(o.full, derived.full),
    partial: num(o.partial, derived.partial),
    zero: num(o.zero, derived.zero),
    blank: num(o.blank, derived.blank),
    mapped: num(o.mapped, derived.mapped),
    total_questions: num(o.total_questions, derived.total_questions),
  };
}

function subjectRollup(raw: unknown, topics: TopicMastery[]): SubjectRollup[] {
  const given = arr<Loose<SubjectRollup>>(raw).map((s) => ({
    subject: str(s?.subject, "—"),
    questions: num(s?.questions),
    full: num(s?.full),
    partial: num(s?.partial),
    zero: num(s?.zero),
    blank: num(s?.blank),
    score: num(s?.score),
    max_marks: num(s?.max_marks),
    pct: num(s?.pct),
  }));
  if (given.length > 0) return given;
  const by = new Map<string, SubjectRollup>();
  for (const t of topics) {
    const row = by.get(t.subject) ?? {
      subject: t.subject,
      questions: 0,
      full: 0,
      partial: 0,
      zero: 0,
      blank: 0,
      score: 0,
      max_marks: 0,
      pct: 0,
    };
    row.questions += t.n || t.questions.length;
    row.full += t.full;
    row.partial += t.partial;
    row.zero += t.zero;
    row.blank += t.blank;
    row.score += t.score;
    row.max_marks += t.max_marks;
    by.set(t.subject, row);
  }
  return [...by.values()].map((r) => ({ ...r, pct: r.max_marks > 0 ? (r.score / r.max_marks) * 100 : 0 }));
}

function normalizeRelease(raw: unknown): ReleaseInfo {
  const r = obj<ReleaseInfo>(raw);
  return {
    status: r?.status === "RELEASED" ? "RELEASED" : "PROVISIONAL",
    reviewed_by: strOrNull(r?.reviewed_by),
    reviewed_at: strOrNull(r?.reviewed_at),
    note: strOrNull(r?.note),
  };
}

function normalizeCustody(raw: unknown): Custody | null {
  const c = obj<Custody>(raw);
  if (!c || !strOrNull(c.sha256)) return null;
  return {
    sha256: str(c.sha256),
    size_bytes: num(c.size_bytes),
    page_count: numOrNull(c.page_count),
    mime_type: str(c.mime_type, "unknown"),
    detected_by: str(c.detected_by, "magic bytes"),
    verified: bool(c.verified),
    verified_at: strOrNull(c.verified_at),
  };
}

function normalizeExtraction(raw: unknown, questions: QuestionEvaluation[], threshold: number, sub: Submission): Extraction {
  const e = obj<Extraction>(raw);
  const confs = questions.map((q) => q.confidence).filter((c) => c > 0);
  const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  return {
    mapped: num(e?.mapped, questions.filter((q) => q.outcome !== "BLANK").length),
    total_questions: num(e?.total_questions, questions.length),
    unattempted: nums(e?.unattempted),
    dropped: nums(e?.dropped),
    mean_confidence: e && "mean_confidence" in e ? numOrNull(e.mean_confidence) : (sub.ocr_confidence ?? mean),
    min_confidence: e && "min_confidence" in e ? numOrNull(e.min_confidence) : confs.length ? Math.min(...confs) : null,
    below_threshold: num(e?.below_threshold, confs.filter((c) => c < threshold).length),
    threshold: num(e?.threshold, threshold),
    flagged_pages: nums(e?.flagged_pages),
    page_confidences: arr<{ page?: unknown; confidence?: unknown }>(e?.page_confidences).map((p) => ({
      page: num(p?.page),
      confidence: num(p?.confidence),
    })),
    ocr_adapter: str(e?.ocr_adapter, "vision LLM (PoC stand-in for certified OCR)"),
    ocr_cache_hit: bool(e?.ocr_cache_hit, Boolean(sub.ocr_cache_hit)),
    language_hints: arr<Extraction["language_hints"][number]>(e?.language_hints).length
      ? arr<Extraction["language_hints"][number]>(e?.language_hints)
      : (sub.language_hints ?? ["en"]),
    corrected_by_faculty: bool(e?.corrected_by_faculty, questions.some((q) => q.corrected_by_faculty)),
  };
}

function normalizeCost(raw: unknown, isDemo: boolean): CostSummary {
  const c = obj<CostSummary>(raw);
  return {
    llm_cost_inr: numOrNull(c?.llm_cost_inr),
    ocr_inr: numOrNull(c?.ocr_inr),
    evaluation_inr: numOrNull(c?.evaluation_inr),
    other_inr: numOrNull(c?.other_inr),
    target_inr: num(c?.target_inr, 5),
    within_target: typeof c?.within_target === "boolean" ? c.within_target : null,
    calls: num(c?.calls),
    ocr_cache_hit: bool(c?.ocr_cache_hit),
    synthetic: bool(c?.synthetic, isDemo),
    usd_inr: num(c?.usd_inr, 85),
  };
}

const QUADRANT_KEYS = ["priority_focus", "maintain", "deprioritise", "no_action"] as const;
const ACTION_KEYS = ["learn", "drill", "fix_errors", "maintain", "none"] as const;
const ACTIVITY_KEYS = ["learn", "drill", "fix_errors", "review", "checkpoint"] as const;
const HORIZON_KEYS = ["7", "30", "60", "90"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function normalizePlanTopic(raw: unknown): PlanTopic {
  const t = obj<PlanTopic>(raw);
  const mastery = num(t?.mastery);
  return {
    topic: str(t?.topic, "Untitled topic"),
    subject: str(t?.subject, "—"),
    chapter: strOrNull(t?.chapter),
    mastery,
    exam_marks: num(t?.exam_marks),
    gain_marks: num(t?.gain_marks),
    gain_low: num(t?.gain_low),
    gain_high: num(t?.gain_high),
    target_mastery: num(t?.target_mastery, Math.max(mastery, 85)),
    effort_hours: num(t?.effort_hours),
    time_factor: num(t?.time_factor, 1),
    roi: num(t?.roi),
    quadrant: oneOf(t?.quadrant, QUADRANT_KEYS, "no_action"),
    quadrant_reason: str(t?.quadrant_reason),
    action: oneOf(t?.action, ACTION_KEYS, "none"),
    allocated_hours: num(t?.allocated_hours),
    rank: numOrNull(t?.rank),
    question_refs: nums(t?.question_refs),
  };
}

function normalizeRoadmapStage(raw: unknown): RoadmapStage {
  const s = obj<RoadmapStage>(raw);
  return {
    horizon: oneOf(s?.horizon, HORIZON_KEYS, "7"),
    title: str(s?.title, "Stage"),
    days_label: str(s?.days_label),
    tasks: strings(s?.tasks),
    checkpoint: str(s?.checkpoint),
    condition: str(s?.condition),
    applicable: bool(s?.applicable, true),
  };
}

function normalizeCalendarDay(raw: unknown, index: number): CalendarDay {
  const d = obj<CalendarDay>(raw);
  return {
    day: num(d?.day, index + 1),
    date: strOrNull(d?.date),
    blocks: arr<Loose<CalendarBlock>>(d?.blocks).map((b) => ({
      topic: str(b?.topic, "Mixed revision"),
      minutes: num(b?.minutes),
      activity: oneOf(b?.activity, ACTIVITY_KEYS, "review"),
      note: str(b?.note),
    })),
  };
}

function normalizeExplanation(raw: unknown): RoiExplanation | null {
  const ex = obj<RoiExplanation>(raw);
  if (!ex || !strOrNull(ex.topic)) return null;
  const inp = obj<RoiInputs>(ex.inputs);
  return {
    topic: str(ex.topic),
    formula: str(ex.formula),
    arithmetic: str(ex.arithmetic),
    inputs: {
      exam_marks: num(inp?.exam_marks),
      mastery: num(inp?.mastery),
      target_mastery: num(inp?.target_mastery),
      time_factor: num(inp?.time_factor, 1),
      effort_hours: num(inp?.effort_hours),
      roi: num(inp?.roi),
    },
  };
}

function normalizeStudyPlan(raw: unknown, batch: Batch, pct: number): StudyPlan {
  const p = obj<StudyPlan>(raw);
  const mode = p?.strategy_mode;
  const ps = obj<StudyPlan["projected_score"]>(p?.projected_score);
  const topics = arr(p?.topics).map(normalizePlanTopic);
  return {
    calculation_version: str(p?.calculation_version, "—"),
    matrix_version: str(p?.matrix_version, "none"),
    exam: str(p?.exam, batch.exam || "NEET"),
    exam_date: p && "exam_date" in p ? strOrNull(p.exam_date) : batch.exam_date,
    days_to_exam: p && "days_to_exam" in p ? numOrNull(p.days_to_exam) : batch.days_to_exam,
    strategy_mode:
      mode === "broad" || mode === "focused" || mode === "revision" || mode === "consolidation"
        ? mode
        : (batch.strategy_mode ?? "focused"),
    strategy_title: str(p?.strategy_title),
    strategy_text: str(p?.strategy_text),
    study_hours: num(p?.study_hours, 18),
    calibrated: bool(p?.calibrated),
    topics,
    focus: arr(p?.focus).map(normalizePlanTopic),
    deprioritised: arr<Loose<Deprioritised>>(p?.deprioritised).map((d) => ({ topic: str(d?.topic), reason: str(d?.reason) })),
    effort_flags: arr<Loose<EffortFlag>>(p?.effort_flags).map((f) => ({
      topic: str(f?.topic),
      kind: f?.kind === "low_marginal_return" ? "low_marginal_return" : "over_investing",
      message: str(f?.message),
    })),
    projected_score: {
      current: num(ps?.current, pct),
      expected: num(ps?.expected, pct),
      low: num(ps?.low, pct),
      high: num(ps?.high, pct),
      scale_max: num(ps?.scale_max, 100),
      label: str(ps?.label, "Illustrative - not a calibrated forecast"),
    },
    weekly_calendar: arr(p?.weekly_calendar).map(normalizeCalendarDay),
    roadmap: arr(p?.roadmap).map(normalizeRoadmapStage),
    explanation: normalizeExplanation(p?.explanation),
    allocation_note: str(p?.allocation_note),
  };
}

/** Normalised StudyPlan for an API response (the ROI Lab's live what-if calls). */
export function normalizePlan(raw: unknown, batch: Batch, pct: number): StudyPlan {
  return normalizeStudyPlan(raw, batch, pct);
}

function normalizeHistory(h: Loose<HistoryEntry>, nQuestions: number): HistoryEntry {
  const pct = num(h?.pct);
  const oc = obj<OutcomeCounts>(h?.outcome_counts);
  return {
    submission_id: num(h?.submission_id),
    date: str(h?.date),
    batch_name: str(h?.batch_name, "Batch"),
    rubric_name: str(h?.rubric_name, "Assessment"),
    rubric_version: str(h?.rubric_version),
    subjects: strings(h?.subjects),
    score: num(h?.score),
    total_marks: num(h?.total_marks),
    pct,
    urgency: URGENCIES.includes(h?.urgency as Urgency) ? (h?.urgency as Urgency) : urgencyFromPct(pct),
    outcome_counts: {
      full: num(oc?.full),
      partial: num(oc?.partial),
      zero: num(oc?.zero),
      blank: num(oc?.blank),
      mapped: num(oc?.mapped, nQuestions),
      total_questions: num(oc?.total_questions, nQuestions),
    },
    current: bool(h?.current),
  };
}

/** Delivery rows from the API or from POST /api/deliveries (status is never "sent"). */
export function normalizeDelivery(d: Delivery): Delivery {
  return {
    ...d,
    channel: str(d.channel, "whatsapp"),
    recipient_masked: strOrNull(d.recipient_masked),
    template_name: str(d.template_name),
    status: d.status === "SIMULATED_NOT_SENT" ? "SIMULATED_NOT_SENT" : "BLOCKED_TEMPLATE_PENDING",
    detail: str(d.detail),
    download_url: strOrNull(d.download_url),
    link_expires_at: strOrNull(d.link_expires_at),
    created_at: str(d.created_at),
  };
}

/** Defensive defaults so a partially-populated payload never crashes the demo. */
export function normalizeResult(r: Result): Result {
  const submission: Submission = {
    ...r.submission,
    language_hints: arr(r.submission?.language_hints),
    flagged_pages: nums(r.submission?.flagged_pages),
    attempts: num(r.submission?.attempts),
    max_attempts: num(r.submission?.max_attempts, 3),
  };
  const totalMarks = typeof r.total_marks === "number" ? r.total_marks : num(submission.total_marks);
  const totalScore = num(r.total_score, num(submission.total_score));
  const pct = typeof r.percentage === "number" ? r.percentage : totalMarks > 0 ? (totalScore / totalMarks) * 100 : 0;
  const isDemo = Boolean(submission.is_demo);
  const questions = arr(r.question_evaluations).map(normalizeQuestion);
  const topics = arr(r.topic_mastery).map(normalizeTopic);

  const rubricRaw = obj<RubricRef>(r.rubric);
  const rubric: RubricRef = {
    id: num(rubricRaw?.id, submission.rubric_id),
    version: str(rubricRaw?.version),
    name: str(rubricRaw?.name, `Rubric ${submission.rubric_id}`),
    total_marks: num(rubricRaw?.total_marks, totalMarks),
    status: rubricRaw?.status === "FACULTY_APPROVED" ? "FACULTY_APPROVED" : "AUTHOR_DRAFT",
    rubric_hash: str(rubricRaw?.rubric_hash),
  };

  const metaRaw = obj<ReportMeta>(r.report_meta);
  const batch = normalizeBatch(metaRaw?.batch, submission.batch_id);
  const instRaw = obj<ReportMeta["institution"]>(metaRaw?.institution);
  const report_meta: ReportMeta = {
    run_id: str(metaRaw?.run_id, `SUB${String(submission.id).padStart(4, "0")}`),
    institution: { id: num(instRaw?.id, 0), name: str(instRaw?.name, "Institution") },
    batch,
    executed_at: str(metaRaw?.executed_at, submission.updated_at),
    timezone: str(metaRaw?.timezone, "Asia/Kolkata"),
    student_ref: str(metaRaw?.student_ref, submission.student_ref ?? ""),
    is_demo: bool(metaRaw?.is_demo, isDemo),
  };

  const sc = obj<ScoringControls>(r.scoring_controls);
  const itemSum = questions.reduce((a, q) => a + q.estimated_marks, 0);
  const scoring_controls: ScoringControls = {
    marking_rule: str(sc?.marking_rule, "Partial credit in 0.5-mark steps, clamped to each question max; totals summed server-side"),
    rubric_version: str(sc?.rubric_version, rubric.version),
    rubric_status: sc?.rubric_status === "FACULTY_APPROVED" ? "FACULTY_APPROVED" : rubric.status,
    rubric_hash: str(sc?.rubric_hash, rubric.rubric_hash),
    item_sum: num(sc?.item_sum, itemSum),
    reported_total: num(sc?.reported_total, totalScore),
    parity: bool(sc?.parity, Math.abs(itemSum - totalScore) < 1e-6),
    llm_total_used: bool(sc?.llm_total_used),
  };

  const rb = obj<RoiBasis>(r.roi_basis);
  const roi_basis: RoiBasis = {
    calculation_version: str(rb?.calculation_version, "roi-brd-v1"),
    matrix_version: str(rb?.matrix_version, "none"),
    weightage_source: str(rb?.weightage_source, "NEET subject weights x rubric marks share"),
    effort_source: str(rb?.effort_source, "rubric effort_hours"),
    forecast_status: str(rb?.forecast_status, "UNAVAILABLE"),
    reason: str(rb?.reason, "no calibrated effort-response data; NEET chapter matrix is illustrative"),
    calibrated: bool(rb?.calibrated),
  };

  const lat = obj<Result["latency"]>(r.latency);
  const threshold = num(obj<Extraction>(r.extraction)?.threshold, 0.7);
  const urgency = URGENCIES.includes(r.urgency as Urgency) ? (r.urgency as Urgency) : urgencyFromPct(pct);

  return {
    ...r,
    submission,
    total_score: totalScore,
    total_marks: totalMarks,
    overall_mastery: num(r.overall_mastery, pct),
    ocr_confidence: numOrNull(r.ocr_confidence) ?? submission.ocr_confidence ?? null,
    topic_mastery: topics,
    roi_recommendations: arr(r.roi_recommendations).map(normalizePriority),
    strengths_gaps: {
      strengths: strings(r.strengths_gaps?.strengths),
      gaps: strings(r.strengths_gaps?.gaps),
    },
    question_evaluations: questions,
    processing_log: arr<Result["processing_log"][number]>(r.processing_log).map((e) => ({
      step: str(e?.step, "Step"),
      message: str(e?.message),
      timestamp: str(e?.timestamp),
    })),
    rubric,
    urgency,
    urgency_reasons: strings(r.urgency_reasons),
    percentage: pct,
    summary: strOrNull(r.summary),
    executive_summary: strings(r.executive_summary),
    teaching_nudges: arr(r.teaching_nudges)
      .map(normalizeNudge)
      .filter((n): n is TeachingNudge => n !== null),
    confusions: arr<Result["confusions"][number]>(r.confusions)
      .map((c) => ({
        concept_a: str(c?.concept_a),
        concept_b: str(c?.concept_b),
        question: numOrNull(c?.question),
        evidence: str(c?.evidence),
      }))
      .filter((c) => c.concept_a && c.concept_b),
    outcome_counts: outcomeCounts(r.outcome_counts, questions),
    subject_rollup: subjectRollup(r.subject_rollup, topics),
    scoring_controls,
    roi_basis,
    report_meta,
    release: normalizeRelease(r.release),
    custody: normalizeCustody(r.custody),
    extraction: normalizeExtraction(r.extraction, questions, threshold, submission),
    cost: normalizeCost(r.cost, isDemo),
    latency: {
      seconds: numOrNull(lat?.seconds),
      target_seconds: num(lat?.target_seconds, 300),
      within_target: typeof lat?.within_target === "boolean" ? lat.within_target : null,
      stages: arr<{ step?: unknown; seconds?: unknown }>(lat?.stages).map((s) => ({
        step: str(s?.step, "Stage"),
        seconds: num(s?.seconds),
      })),
    },
    history: arr<Loose<HistoryEntry>>(r.history)
      .filter((h) => typeof h?.submission_id === "number")
      .map((h) => normalizeHistory(h, questions.length)),
    versions: arr<Loose<EvaluationVersion>>(r.versions)
      .filter((v) => typeof v?.version === "number")
      .map((v) => ({
        version: num(v?.version, 1),
        rubric_id: num(v?.rubric_id, rubric.id),
        rubric_version: str(v?.rubric_version),
        rubric_hash: strOrNull(v?.rubric_hash),
        total_score: num(v?.total_score),
        total_marks: num(v?.total_marks),
        created_at: str(v?.created_at),
        superseded_at: strOrNull(v?.superseded_at),
        current: bool(v?.current),
      })),
    deliveries: arr<Delivery>(r.deliveries).filter((d) => typeof d?.id === "number").map(normalizeDelivery),
    study_plan: normalizeStudyPlan(r.study_plan, batch, pct),
    // contract v3 extension fields: guarded on the server too; default when an older API omits them
    llm_routes: arr(r.llm_routes),
    patterns: r.patterns ?? { negative_marking: null, fatigue: null, transfer: null, bloom_profile: [], notes: [] },
    interventions: arr(r.interventions),
    voice: r.voice ?? null,
  };
}
