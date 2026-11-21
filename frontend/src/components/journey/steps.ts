// The 12-step journey of the V5 Unified Interactive report (.run/v5_payload.json "steps"),
// copied as data, plus what this PoC actually does at each step ("In this PoC").
// The BRD text (mechanics, API, gate) describes the PROPOSED production architecture.

export type PocStatus = "implemented" | "stand_in" | "mocked" | "out_of_scope";

export const POC_STATUS_LABEL: Record<PocStatus, string> = {
  implemented: "Implemented",
  stand_in: "Implemented - stand-in",
  mocked: "Mocked",
  out_of_scope: "Out of scope",
};

export interface PocNote {
  status: PocStatus;
  /** Optional second chip, e.g. delivery: PDF implemented + WhatsApp mocked. */
  secondary?: PocStatus;
  text: string;
  /** Where to see it in this app. */
  href?: string;
  linkLabel?: string;
}

export interface JourneyStep {
  id: string;
  title: string;
  person: string;
  summary: string;
  action: string;
  input: string;
  mechanics: string[];
  output: string;
  api: string;
  gate: string;
  poc: PocNote;
}

export const JOURNEY_STEPS: JourneyStep[] = [
  {
    id: "identity",
    title: "Institute onboarding & permissions",
    person: "Institute owner / admin",
    summary:
      "Create tenant, authorise users, record institution permissions and configure access before any student paper enters the platform.",
    action: "Choose institution and faculty role; create a test workspace.",
    input:
      "Institution, staff roles, student identifiers, processing permissions and consent evidence (specific implementation to approve).",
    mechanics: [
      "Tenant created under an institution-scoped identity.",
      "Issue authenticated session; API checks tenant and role; PostgreSQL RLS enforces institutional isolation.",
      "Encrypted student identity; upload and processing permissions checked.",
      "Purpose notice, guardian consent and DPA evidence gates need legal/product definition.",
    ],
    output: "Tenant-scoped test workspace; audit record.",
    api: "Proposed: POST /v1/institutions; POST /v1/users; GET /v1/session",
    gate: "No student processing before permission / privacy basis are confirmed.",
    poc: {
      status: "mocked",
      text:
        "Single seeded tenant (one institution, one or more batches). An institute-owner view aggregates batches, faculty and trends, but there is no login, roles or row-level security in the PoC: anyone who opens it sees the owner view.",
      href: "/owner",
      linkLabel: "Open the owner view",
    },
  },
  {
    id: "test",
    title: "Create test, rubric & exam context",
    person: "Faculty / authorised admin",
    summary:
      "Attach question paper, marking scheme, test maximum marks, topic tags, exam date and candidate batch before evaluation.",
    action: "Select a sample NEET mock, rubric version and days-to-exam.",
    input: "Test ID, subject, exam, rubric PDF/DOCX/pasted text, max marks, scoring policy and exam calendar.",
    mechanics: [
      "Parse question paper and marking scheme into a versioned, reviewed rubric.",
      "Assign question IDs, expected-answer criteria, marks and topic mapping.",
      "Capture exam and versioned chapter-weightage matrix; surface missing coverage.",
      "Lock the rubric version for a batch run so every student receives the same scoring policy.",
    ],
    output: "Rubric v1; test metadata; validation summary.",
    api: "Proposed: POST /v1/tests; POST /v1/rubrics; POST /v1/rubrics/{id}/approve",
    gate: "Rubric correctness, partial credit rights and exam matrix version must be reviewed.",
    poc: {
      status: "implemented",
      text:
        "Rubric from a saved list, JSON, pasted text or a PDF/DOCX question paper (Claude drafts it; faculty review and approve it in an editable table). Rubrics are hashed and versioned; the exam date is editable on the Cohort page.",
      href: "/#upload",
      linkLabel: "Open intake",
    },
  },
  {
    id: "upload",
    title: "Answer sheet intake & validation",
    person: "Faculty / admin",
    summary:
      "Safely accept PDFs, JPGs, PNGs and DOCX files; show per-file state and isolate bad or incomplete files.",
    action: "Select local files in the sample intake panel; examine the validation results.",
    input: "Batch/test/student IDs, answer files, original metadata.",
    mechanics: [
      "Pre-signed multipart object upload for files over 10 MB; 50 MB maximum per file.",
      "Inspect file signatures (magic bytes), not extension alone; reject corrupt and unsupported content.",
      "Show multi-file progress, retry state, and batch >100 queue-API guidance.",
      "Hash original bytes (SHA-256), persist object metadata and enqueue each student independently.",
      "Proposed hardening: malware scanning, tenant-scoped idempotency and safe DOCX-to-text conversion.",
    ],
    output: "Validated S3 object pointers, file hash, queued per-student jobs.",
    api: "Proposed: POST /v1/uploads/presign; POST /v1/submissions/batch; GET /v1/jobs/{id}",
    gate: "Never interpret a user-selected demo file as actually uploaded or scored.",
    poc: {
      status: "implemented",
      secondary: "stand_in",
      text:
        "Single sheet or batch / folder upload (3 at a time, per-file progress, retry / replace), magic-byte checks in the browser and on the server, SHA-256 custody hash with in-batch duplicate detection, DOCX accepted. Files go to local storage (S3 stand-in) in one streamed upload. Voice answers (MP3 / WAV / M4A / OGG, one recording per question or for the whole paper) are implemented: OpenAI gpt-transcribe stands in for Whisper large-v3 / Sarvam Saarika (not residency-approved - PoC only; transcription cost shown as unknown).",
      href: "/#upload",
      linkLabel: "Try a folder upload",
    },
  },
  {
    id: "queue",
    title: "Queue, worker & job lifecycle",
    person: "Processing service",
    summary:
      "Keep one student failure from stopping other students and make processing observable and repeatable.",
    action: "Advance the simulated batch through queue states.",
    input: "S3 object key, institution/test/student identifiers, rubric hash, attempts.",
    mechanics: [
      "SQS per-student job with idempotency key and status transitions.",
      "AWS ECS Fargate worker polls, fetches object with narrowly scoped IAM.",
      "Per-tenant fair scheduling / rate limits proposed for 20+ concurrent institutions.",
      "Retry transient failures with exponential backoff to a 3-attempt maximum; then DLQ.",
      "Capture trace IDs, cost and partial-batch status; reconcile orphaned jobs.",
    ],
    output: "Job progressing to preprocessing, or recovery state / DLQ.",
    api: "Proposed: GET /v1/jobs/{id}; POST /v1/jobs/{id}/retry",
    gate: "Idempotent retries and 60 s LLM timeouts; never silently drop a student.",
    poc: {
      status: "stand_in",
      text:
        "FastAPI BackgroundTasks stand in for SQS + Fargate. One job per student, transient failures retried up to 3 times with backoff, then dead-lettered with a Retry button in the queue. Model calls record cost and latency.",
      href: "/",
      linkLabel: "See the processing queue",
    },
  },
  {
    id: "ocr",
    title: "Pre-process, OCR & human review",
    person: "Document intelligence worker",
    summary:
      "Improve scan quality, extract text with confidence and stop unsafe grading when handwriting is unreadable.",
    action: "Switch sample page confidence between 0.92 and 0.62 to see the human gate.",
    input: "PDF page images at 300 DPI, raster settings, per-page source hash.",
    mechanics: [
      "Deskew up to ±15°, contrast 1.8×, unsharp mask, minimum shortest-edge 1200 px (BRD parameters).",
      "Run OCR adapter and return page/block/word confidence; annotate provenance.",
      "If page-average confidence <0.70: flag, request faculty correction/rescan; do not propagate unreliable text.",
      "Store reusable OCR result keyed to file/hash with carefully reviewed tenant and configuration isolation.",
      "BRD names Google Vision; AWS Textract is a proposed PoC alternative, not a validated drop-in.",
    ],
    output: "Extracted text, confidence, corrected text where approved, OCR artifact and trace.",
    api: "Proposed: GET /v1/ocr/{submission}; PATCH /v1/ocr-reviews/{id}",
    gate: "Mean >0.85 is a quality KPI, <0.70 is an individual page review threshold; they are not the same test.",
    poc: {
      status: "stand_in",
      text:
        "Claude vision stands in for Google Vision. Real pre-processing (300 DPI render, deskew, contrast - 1.4 by default - and sharpen); any page below 0.70 confidence goes to faculty review with no grading call. OCR results are cached by SHA-256: a repeat file makes no vision call (Rs 0.00). Try a file name containing \"blurry\".",
      href: "/#upload",
      linkLabel: "Run the review-gate demo",
    },
  },
  {
    id: "map",
    title: "AI stage 1 — question / answer mapping",
    person: "Lightweight model + schema validation",
    summary:
      "Convert OCR text into a trusted question-number → answer-text structure, without awarding marks yet.",
    action: "Inspect sample extraction mapping and confidence.",
    input: "OCR blocks, page offsets, question paper and rubric question IDs.",
    mechanics: [
      "Map OCR spans to question numbers via a lightweight model (BRD: Gemini Flash or Claude Haiku).",
      "Validate JSON schema, question IDs, missing questions, duplicate IDs and text/source spans.",
      "Store model/version, prompt version, mapping confidence and reviewer decisions.",
      "Proposed AWS-first route uses Bedrock Claude Haiku only when supported in approved India processing route.",
    ],
    output: "Structured answer JSON with question-level provenance and confidence.",
    api: "Proposed: POST /internal/parse-answers; GET /v1/answers/{id}",
    gate: "Unmapped questions must not be invented or auto-credited.",
    poc: {
      status: "implemented",
      text:
        "The OCR call returns schema-validated answers per rubric question with source pages and uncertain words; unknown question numbers are dropped and reported. Mapping coverage is shown in each report, and faculty can correct a transcript in the review editor before grading.",
      href: "/",
      linkLabel: "Open a report from the queue",
    },
  },
  {
    id: "evaluate",
    title: "AI stage 2 — rubric-grounded evaluation",
    person: "Claude Sonnet + validation layer",
    summary:
      "Score each structured answer against the same frozen rubric and generate auditable reasons for estimated marks.",
    action: "Inspect one fictional student and score breakdown.",
    input: "Versioned rubric, structured answer JSON, scoring rules, model/prompt version.",
    mechanics: [
      "Bedrock Claude Sonnet is proposed in place of direct Anthropic API to favour AWS processing controls.",
      "Provide consistent rubric context; where applicable measure prompt caching support and actual economics.",
      "Validate marks bounds, answer-to-criterion evidence, partial credits, 5–10 topic mastery scores.",
      "Generate 2–3 strengths, gaps, nudges and urgency tag; store human disagreement for calibration.",
      "Rerun repeatability goal within ±2 marks does not replace faculty-agreement test.",
    ],
    output: "Versioned per-question scores, estimated total, topic mastery, explanations and urgency.",
    api: "Proposed: POST /internal/evaluate; GET /v1/evaluations/{id}",
    gate: "AI score is an estimate until pilot calibration; external model/fallback route needs residency and privacy approval.",
    poc: {
      status: "implemented",
      text:
        "Claude grades each answer against the rubric (structured output, marks bounded per question), writes strengths, gaps and teaching nudges, and the urgency tag follows one deterministic rule. A consistency re-grade checks the ±2-mark goal. Scores stay provisional until a teacher releases them. Also implemented: per-question marking schemes with partial credit, NEET MCQs scored +4 / -1 server-side, Bloom levels K1-K5 (faculty, AI-suggested or heuristic), and a Claude -> GPT-4o fallback when Claude fails, with the route shown on each report (the fallback is not residency-approved - PoC only).",
      href: "/students",
      linkLabel: "See student cards",
    },
  },
  {
    id: "cohort",
    title: "AI stage 3 — cohort intelligence",
    person: "Synthesis service + group analytics",
    summary:
      "Aggregate only completed, review-cleared student evaluations and identify patterns the faculty can act upon.",
    action: "Filter fictional students by urgency/topic in the dashboard.",
    input: "Evaluation rows for an identical test/rubric version, sample size, exclusions.",
    mechanics: [
      "Compute valid denominator, topic averages, ranks, repeated misconceptions and at-risk cohort.",
      "Generate teacher nudges for shared weaknesses, with student-level drilldown.",
      "Display incomplete/flagged submissions separately to avoid misleading class percentages.",
      "Owner-wide aggregation remains within institution RLS; cross-tenant aggregates need separate authorisation.",
    ],
    output: "Student cards, batch ranking, topic error patterns, at-risk list, interventions.",
    api: "Proposed: GET /v1/cohorts/{test}/insights; GET /v1/students?urgency=...",
    gate: "Cohort interpretation must disclose denominator and missing/flagged submissions.",
    poc: {
      status: "implemented",
      text:
        "Cohort dashboard with batch / test / urgency / topic filters: ranking, at-risk students, common errors, concept confusions, class interventions, and the excluded (review / failed / processing) students listed separately. Exam-behaviour patterns are implemented: negative-marking risk with a skip threshold per topic, end-of-paper fatigue, and memorisation vs transfer (thresholds are defaults - confirm with the academic lead).",
      href: "/cohort",
      linkLabel: "Open the cohort dashboard",
    },
  },
  {
    id: "roi",
    title: "Deterministic preparation optimisation",
    person: "Rule engine — no LLM ranking",
    summary:
      "Rank the next study effort by expected value, not just lowest marks, and show why each recommendation exists.",
    action: "Use the ROI Lab: change student, days to exam, weekly study hours and mastery.",
    input: "Topic mastery, per-exam chapter weightage, effort-hours calibration, remaining days, confidence.",
    mechanics: [
      "BRD formula variants: (weightage × mark-gain-potential) ÷ hours, with optional time-decay factor (§8.3).",
      "Reproducible versioned coefficients; four action quadrants; top 5 topics with effort, projected gain and rationale.",
      "Adapt broad/focused/revision/consolidation strategies at 90+, 30–89, 7–29 and <7 days.",
      "Mark gain projection must be treated as unvalidated until student outcome and historical effort data exist.",
      "Human overrides require product authority decision and an audit trail.",
    ],
    output: "Ranked focus list, deprioritisation, hours, gain hypotheses, strategy mode and calculation trace.",
    api: "Proposed: POST /internal/recommendations; GET /v1/recommendations/{id}",
    gate: "Never fabricate precision or treat “80:20” as a verified universal NEET distribution.",
    poc: {
      status: "implemented",
      text:
        "Deterministic ROI engine with a versioned, illustrative chapter-weightage matrix (labelled sample data, not calibrated), four quadrants, strategy modes by days to exam and a visible calculation trace. No LLM ranks topics. Per-student negative-marking, fatigue and transfer advice sits next to the plan, and the owner view has an illustrative what-if simulator (extra hours on a topic -> projected NEET marks with a range).",
      href: "/students",
      linkLabel: "Open the ROI view",
    },
  },
  {
    id: "deliver",
    title: "Report, dashboard & governed delivery",
    person: "Faculty / institute owner",
    summary:
      "Turn student insights and cohort patterns into readable PDF, web views and — when approved — WhatsApp delivery.",
    action: "Open the print-ready sample student report; inspect delivery status.",
    input: "Reviewed evaluations, recommendation version, institution branding, selected recipients.",
    mechanics: [
      "Render student PDF (score, mastery, 2–3 nudges, top five focus) and cohort PDF.",
      "Presigned time-limited download permission; preserve report version and delivery audit.",
      "WhatsApp Business approved templates, consent and media/link sharing prerequisites.",
      "If template approval or residency is unresolved, retain secure dashboard download and queue channel setup as blocked.",
    ],
    output: "Institute-branded report preview, dashboard cards, delivery event states.",
    api: "Proposed: GET /v1/reports/{id}; POST /v1/deliveries; GET /v1/deliveries/{id}",
    gate: "WhatsApp is a BRD P0/acceptance item but its feasibility is explicitly not approved.",
    poc: {
      status: "implemented",
      secondary: "mocked",
      text:
        "Branded student and cohort PDFs plus a ZIP of every report. WhatsApp delivery is simulated: each attempt is recorded as BLOCKED / NOT sent with a signed, time-limited download link - no message is ever sent. LMS export API (JSON / CSV, API key) implemented: read-only, released results only by default, keys stored hashed.",
      href: "/integrations",
      linkLabel: "Open LMS export",
    },
  },
  {
    id: "rerun",
    title: "Rubric revision → selective reprocessing",
    person: "Authorised reviewer",
    summary:
      "Correct a rubric without paying OCR cost again; preserve all versions for audit and invalidate dependent insights.",
    action: "Click “Simulate rubric revision” to watch dependent stages refresh.",
    input: "Rubric v2 and unchanged source file hash / OCR result.",
    mechanics: [
      "Create a new rubric version and hash; keep original student artefacts immutable.",
      "Reuse OCR and the reviewed question mapping where structurally valid.",
      "Regenerate evaluation, cohort patterns, ROI recommendations, reports and deliveries.",
      "Prevent stale v1 PDFs from being represented as current; show revised/withdrawn state.",
      "Permissions remain unresolved: BRD describes faculty as view-only but also permits rerun and override.",
    ],
    output: "Evaluation v2, new recommendation and report version; preserved OCR cache.",
    api: "Proposed: POST /v1/rubrics/{id}/versions; POST /v1/tests/{id}/reprocess",
    gate: "Same question mapping reuse is conditional if question numbering changes.",
    poc: {
      status: "implemented",
      text:
        "Edit a rubric on the Cohort page and save it as the next version. After a confirmation that shows the number of students and the estimated cost, every report is re-graded from the stored OCR (0 vision calls); earlier versions are archived and their PDFs marked superseded.",
      href: "/cohort",
      linkLabel: "Open Rubric versions",
    },
  },
  {
    id: "feedback",
    title: "Intervention impact & learning loop (later)",
    person: "Faculty / academic head",
    summary:
      "Compare future test scores and recommended actions to see whether learning interventions worked.",
    action: "Examine Phase 2 trend and intervention loop.",
    input: "Follow-up evaluations, applied interventions and adherence, prior recommendation versions.",
    mechanics: [
      "Join recommendation IDs to future evaluation IDs.",
      "Measure actual topic mastery and score change; control for test difficulty and confounders.",
      "Calibrate effort-hours and projection confidence before publishing predictive gain claims.",
      "Phase 2 includes trend and intervention tracking; cross-paper cohort phase conflicts require decision.",
    ],
    output: "Longitudinal insights, outcome calibration and revision suggestions.",
    api: "Proposed: POST /v1/interventions; GET /v1/trends/{student}",
    gate: "Not first-MVP functionality; sequence depends on approved release baseline.",
    poc: {
      status: "implemented",
      text:
        "Intervention log + outcome tracking built; effects shown on sample data; observational, not causal. Faculty log an action per student and topic, the next test measures the change, and the owner view compares treated with untreated topics and derives a calibration factor for the what-if simulator.",
      href: "/owner",
      linkLabel: "See intervention effectiveness",
    },
  },
];

/** Index of a step from ?step= (an id such as "ocr", or a 1-based number); 0 when unknown. */
export function stepIndexFrom(param: string | null | undefined): number {
  if (!param) return 0;
  const byId = JOURNEY_STEPS.findIndex((s) => s.id === param.trim().toLowerCase());
  if (byId >= 0) return byId;
  const n = Number(param);
  return Number.isInteger(n) && n >= 1 && n <= JOURNEY_STEPS.length ? n - 1 : 0;
}
