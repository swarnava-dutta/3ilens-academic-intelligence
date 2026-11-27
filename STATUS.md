# 3iLens PoC - Project status

_Last updated: 2026-11-27._

Repo: https://github.com/swarnava-dutta/3ilens-academic-intelligence
Run: double-click `start.bat` (installs anything missing, starts API + web, opens the browser). Stop: `stop.bat`.
Port note: if port 8000 is taken by another local app, `start.bat` picks the next free port (for example API `:8001`, web `:3000`).
Planning notes used while building the requirements are kept in local planning notes (`docs/plans`, not in the repo).

## Verification state

| Check | Result |
|---|---|
| Backend tests (`cd backend && .venv\Scripts\python -m pytest -q`) | **1523 passed**, 0 failed (offline; AI and transcription calls are faked) |
| Frontend `npx tsc --noEmit` + `npm run lint` | clean |
| Frontend `npm run build` | passes (all 8 routes) |
| Live AI end-to-end, base pipeline | done: 26 test pages, 23 COMPLETED / 3 HUMAN_REVIEW / 0 FAILED (see `test-pages/README.md`) |
| Live AI checks, newer features | partial: two fallback drills (Claude primary 3.0/4 in 9.4 s, Rs 1.85; simulated outage served by gpt-4o 3.5/4 in 4.0 s, Rs 0.76), one live transcription of the Hindi-English voice sample (`gpt-transcribe`, 30 s), live result rows showing their AI routes; one upload of `neat_02` (#71): OCR cache hit (no vision call), graded 13/20 for Rs 4.28, then re-evaluated from the stored OCR (cache read 6,802 tokens, Rs 3.03) into version 2; the real 19-page AIPMT 2016 ticked sheet with its key-only answer key: Rs 20.50, 63 s, 4 AI calls (was Rs 27.24, 73.6 s) |
| Live UI checks | headless Edge screenshots at 1440 px and 390 px (device emulation) of `/`, a completed live report, a demo report, a human-review report, a superseded report version, `/students`, `/cohort`, `/owner`, `/integrations` and `/journey`: no horizontal scroll and no console errors. Report analytics: takeaways checked against the API for a live and two demo reports, hover tooltips and every "Show data" table open. Student PDF chart pages rendered to PNG and checked |
| Full end-to-end walkthrough with the `insights` sample set in the live database | not done (see Pending 1) |

## Done

### Base PoC (original brief, `docs/POC_SPEC.md`)
- FastAPI + SQLite backend: upload -> BackgroundTasks queue -> pre-processing -> Claude vision OCR (call 1) -> Claude rubric grading (call 2) -> deterministic insights and Preparation ROI -> persistence. Failures go to `FAILED` with a dead-letter artifact.
- "blurry" filename mock -> `HUMAN_REVIEW_REQUIRED` at 0.65 with no AI call. Real low OCR confidence also routes to review.
- Next.js 16 frontend: intake (upload, queue polling every 3 s, amber human-review rows), Student Intelligence Report, Cohort Dashboard.
- Models: `claude-sonnet-5-5` (Claude 3.5 Sonnet is retired). Optional OpenAI `gpt-4o` vision via `VISION_PROVIDER=openai`.
- `.env` is the only source of LLM settings: inherited Windows `ANTHROPIC_*`/`OPENAI_*` variables (e.g. a local proxy) are dropped, and base URLs are pinned.
- `start.bat` / `stop.bat`:
  - installs Python 3.13 (per user) and portable Node 24 when they're missing, and pip/npm packages when missing or changed;
  - picks free ports, uses a single-instance lock, and stops only its own processes.
- Samples (`samples/`) and 25 varied test pages (`test-pages/generated/`, 24 of them in `{neat,messy,photo,edge}`), plus `test-pages/run_live_test.py` for live runs.
- Public GitHub repo; `.env` is git-ignored and `.env.example` is the template.

### V5 requirements
All 34 P0 functional requirements, the P1 items FR-1.7, FR-4.9, FR-4.12 and FR-5.8, and the 11 requirements that were first deferred (listed in the next section). FR-3.1 was already present in the base PoC.

- **Data and API:** new columns and tables through an idempotent migration (an existing database keeps working), Pydantic schemas mirrored by `frontend/src/lib/types.ts`, `API_CONTRACT.md`, and a contract test that checks every live payload against the TypeScript types.
- **AI evaluation and ROI:**
  - teaching nudges, summary, topic interventions (teach / practice / check) and concept confusions;
  - urgency tags (on track / needs attention / at risk);
  - chapter-weightage matrix (`backend/data/weightage/neet.json`, illustrative), ROI quadrants, projected mark gain, days-to-exam (NEET 2027-05-02, labelled "assumed");
  - weekly study calendar;
  - rubric from pasted text / DOCX / PDF, prompt caching of the rubric context, a consistency re-grade check;
  - cohort analysis (common errors, at-risk list, class interventions).
- **Pipeline:**
  - DOCX uploads; real pre-processing (200 DPI master since 2026-11-27, was 300; contrast 1.4, sharpen, deskew);
  - SHA-256 custody and an OCR cache (cache hit = no vision call, Rs 0);
  - OCR gate at **0.70**, per sheet and per page;
  - cost / usage trace per call; retry and dead-letter re-drive; OCR review editor and rescan; re-evaluate without OCR;
  - rubric versions; page-image endpoints; operations cost endpoint.
- **Outputs:**
  - branded student and cohort PDFs (PyMuPDF) and a ZIP bundle;
  - release / revoke gate; **simulated** WhatsApp delivery with signed links;
  - students, history and filters APIs;
  - mixed NEET demo rubric and multi-batch / longitudinal demo data (sample).
- **Student report:** the full SAIR layout (replaced by the redesigned report on 2026-11-27, see "Redesigned pages" below):
  - provisional banner, run metadata, KPI tiles, executive summary, immediate reading with nudges, urgency;
  - subject roll-up, topic screening, worksheet, intervention chooser, action plan, ROI lab;
  - evidence trace to source pages, audit trail, print styles;
  - a `/students` page (redesigned on 2026-11-27 as a roster, see below).
- **Intake and cohort UI:**
  - batch / folder / DOCX intake with per-file status and retry, language hints, rubric from text with versioning;
  - re-evaluation confirmation with a cost estimate;
  - cohort extensions (ranking, at-risk, common errors, interventions, exam date, operations, filters);
  - `/journey` page.
- **Interface:** one flat, data-dense style across all pages (Fira Sans / Fira Code, white bordered panels, KPI strips, dense tables, small rectangular status tags, navy primary actions, blue as the single accent); sample / simulated / illustrative labels kept as quiet tags.
- **Report analytics:** a "Performance analytics" section with 10 charts (marks and reading confidence by question, topic mastery vs target, batch comparison, score position, focus quadrant, projected gain, score trend, study plan load, Bloom accuracy, accuracy through the paper), each with a computed takeaway and a data table. The 2026-11-27 redesign keeps four of them on the web: batch comparison, score position, projected gain and study plan load. The student PDF has the matching mastery, marks, quadrant, projected-gain and trend charts.
- **Result versions:** `GET /api/results/{id}/versions` and `/versions/{n}`; the report has a version selector and a "Superseded by version N" view of older versions.

### Previously deferred requirements (now implemented)
- **FR-2.8 voice answers.** MP3 / WAV / M4A / OGG detected from the bytes; OpenAI `gpt-transcribe` as a stand-in for Whisper / Sarvam, labelled **not residency-approved** with cost shown as **unknown**. Per-question recordings make no extra AI call; whole-paper recordings are mapped onto the rubric questions by Claude (GPT-4o fallback). The transcript then goes through the confidence gate and grading. Audio and transcript endpoints, an audio player and transcript in the report and review editor, a "Voice answer" chip and question select at intake. Retry, dead-letter, review, re-evaluate and restart handling work for voice rows. Two synthetic TTS clips in `samples/`.
- **FR-3.8 marking schemes.** Per-question schemes with required steps; partial-credit modes `steps`, `proportional`, `all_or_nothing`; the grader returns per-step awards that are re-scored in Python. Rubric editor with marking-policy presets (NEET +4/-1, board 0.5-mark steps, whole marks, none, custom) and a live "x / max" check.
- **FR-3.9 Bloom K1-K5.** Level from the rubric, an AI suggestion (`POST /api/rubrics/{id}/bloom-levels`) or a verb heuristic; the grader reports the demonstrated level. Bloom badges in the report and a Bloom profile.
- **FR-3.10 fallback chain.** Claude timeouts, connection errors, 5xx, rate limits, refusals or empty replies retry OCR / grading / voice mapping once on `LLM_FALLBACK_MODEL` (default `gpt-4o`, announced shutdown 2027-01-14). Route chips per stage in the report; provider chain status and an outage drill on `/integrations`.
- **FR-4.8 negative marking.** MCQs scored +4 / -1 / 0 from the option letter with no grading call (an all-MCQ paper makes no AI grading call at all); net totals can be negative. Per-topic negative-marking risk with skip thresholds.
- **FR-4.10 fatigue** in the final third of the paper (cohort-adjusted when at least 5 results share the rubric) and **FR-4.11 memorisation vs transfer** per concept, for students and the class.
- **FR-4.13 intervention outcomes.** Log an intervention from the report; the outcome comes from the student's next test on that topic (improved / flat / declined / not assessed / pending). Effectiveness compares treated and untreated topics (labelled observational, not causal) and gives a per-institution calibration factor once 5 outcomes are measured.
- **FR-4.14 what-if.** Projects extra study hours with the illustrative linear model on the NEET matrix, optionally calibrated; shown on `/owner`.
- **FR-5.9 owner dashboard.** `/owner`: a "needs your attention" list, KPIs against the Rs 5 cost target, batches with an editable faculty lead and their latest test, then tabs for progress, topics, exam behaviour, faculty, intervention effectiveness, what-if and cost & operations (redesigned 2026-11-27). No login in this PoC.
- **FR-5.10 LMS export.** Read-only JSON and CSV (`/api/lms/v1/*`) behind `X-API-Key`; keys stored only as SHA-256 and shown once; released results only by default; CSVs with a UTF-8 BOM and formula-injection guard; key management and a preview on `/integrations`.
- **Sample data (only with `SEED_DEMO_DATA=1`; off by default since 2026-11-26):** `POST /api/demo/seed?set=insights` adds batch `NEET-C (sample)` with the NEET MCQ Mock 09 / Mock 10 (sample) papers, 25 submissions, 24 interventions (22 measured) and a voice sample row, all labelled as sample data and scored by the real engine. `set=all` is unchanged (27 rows). A synthetic MCQ answer sheet for Mock 09 is in `samples/`.

### Printed exam papers at intake (2026-11-23)
Built for two kinds of PDF the client will upload: a scanned NEET question paper on which a student ticked options (19 pages, 180 MCQs) and a typed question paper with its answer key printed under each question ("Ans. (2)", 9 pages, 45 MCQs).
- **Limits:** PDFs up to 40 pages (`MAX_PDF_PAGES`), rubrics up to 200 questions.
- **Detection without AI:** `POST /api/intake/inspect` (`paper_detect.py`) reads the text layer and classifies a file as an answer-key paper, a printed MCQ paper, an answer sheet or unknown. Intake shows a notice: an answer-key paper offers "Use as the answer key"; a printed MCQ paper says its ticks are read as the student's answers and offers "Use as the question paper" (no key yet) and "Use the ticks as the answer key". Batch rows are tagged. Uploads log the same hint and are never blocked by it.
- **Rubric from a full paper:** a question-paper PDF of 3+ pages is read from page images, 2 pages per call (plus the next page as context), `AI_CHUNK_CONCURRENCY` calls at a time (3 then, 5 since 2026-11-27). The key comes from printed "Ans." lines, an answer-key table or, with `key_source=marks` ("the ticks mark the key"), the ticked options. Drafts over 20 questions open as a dense answer-key table. Warnings are folded per kind (e.g. "No answer key for Q1, Q4-Q7 ...").
- **Student's ticked paper:** a dedicated reader (`mcq_marks.py`, prompt `marks-v1`) reports the marked option of every printed question, 2 pages per call then (5 since 2026-11-27, see below); options (1)-(4) score as A-D; printed keys are ignored; two chunks that disagree cap the confidence below the review gate. Other (typed) sheets are transcribed by the OCR prompt (`ocr-v4`), 10 pages per call.
- **Live checks on the two sample papers (throwaway database):**
  - Typed paper with key -> rubric: 45/45 questions, 45/45 keys, all checked against the printed "Ans." lines; 5 calls, 50 s, about Rs 17.
  - Scanned ticked paper -> rubric: 180/180 questions (subjects 45/43/92 vs the true 45/45/90). Default mode finds keys for 114 (it treats a student's mixed marks as no key); with "ticks are the key" 137, and the other 43 questions have no tick on the scan. 10 calls, about 105 s, Rs 55.
  - Scanned ticked paper graded as a student's sheet against that rubric: 134 marked answers read, 516/720, 130 of 134 matching the independent rubric reading, 30/30 correct on questions checked by eye (7 of them unticked), 10 calls, 68 s, Rs 21.77. The general transcription OCR read the same paper far worse (405/720 at 10 pages per call, 373/720 at 2 pages per call, with invented and missed ticks), which is why the dedicated reader exists.
  - Typed paper with key uploaded as a student's sheet: the printed key is ignored (0 answers read) and the sheet goes to faculty review.
- **Same-paper check and separate answer keys (2026-11-24):** the printed-MCQ reader also returns each question's first words and the printed paper code; `paper_match` compares them with the rubric and holds another code / set or a different paper for review, and intake shows the same check before upload (`rubric_id` on inspect, text layer only). Key-only answer files are read (`POST /api/rubrics/answer-key`, text parse or AI from images) and applied while drafting (`key_file`) or in the rubric editor ("Apply answer key from file", with undo). Live checks:
  - key-only list PDF: 45/45 keys read from the text (no AI call); the same key as a grid image: 45/45 via one AI call (5 s);
  - intake check: 2016 paper vs its rubric -> match (90/101); vs the same rubric with numbers shuffled (stand-in for another code) -> reordered; the 2025 Physics paper vs the 2016 rubric -> mismatch; vs its own rubric -> match (38/43);
  - pipeline: 2016 paper vs its rubric -> "match (148 of 153 compared)", graded 521/720 (Rs 27.26); vs the shuffled rubric -> reordered and paper code A vs P, held for review unscored (Rs 27.18).
- **Review hardening:** the paper check never holds a sheet against a rubric whose questions are short typed summaries (questions need 5+ distinctive words and at least half the rubric needs question text), checks each subject block on its own (a version that reorders only one section is held), holds two different printed codes even when the text lines up (versions that shuffle only the options), and is skipped at intake for typed answer sheets. The answer-key parser skips and warns rather than guessing on gaps, blank grid cells, unlabelled number columns and multi-answer entries.
- **Cost note:** a 19-page printed paper cost about Rs 22-27 to read then, Rs 20.50 since 2026-11-27 (see below) - still above the Rs 5 per-student target, which was sized for sheets of a few pages.

### Answer keys per intake (2026-11-27)
- **No saved rubrics.** Every intake drafts its own answer key from the question paper it uploads (plus an optional separate answer-key file) and grades straight away; the first upload sends the key inline (`rubric_json`) and becomes a per-intake snapshot, later sheets of the same intake reuse it. There is no rubric library and no default rubric (`rubric_required`). `/cohort` lists the keys a cohort was graded with under "Answer keys used".
- **Several accepted options and bonus questions.** An MCQ key may accept 2-6 options (`accepted_options`, "2 or 3": any of them scores full marks) or make the question a bonus (`bonus`: full marks to everyone, blank included). Read from answer-key files and AI drafts ("2 or 3", "B/C", "(1), (3)", options back to back such as "(2)(3)" / "b)c)"; "Bonus", "*", "Dropped", "Deleted", "All options correct", also when the model puts one of those words into the correct option). Rule texts and draft warnings name them. A bonus question counts as full credit in the report, the outcome counts and the PDF appendix (older rows that stored it as BLANK are read as full credit).
- **Source files and previews.** The question paper (or rubric file / marked copy) and the separate answer-key file an intake's key was drafted from are kept with its snapshot (`artifacts/rubrics/<id>/`, with a role for the label) and shown on the report as page thumbnails (`GET /api/rubrics/{id}/sources[/{kind}/preview]`). Rendered pages are cached next to the files; text files may be UTF-8 or UTF-16 (Notepad "Unicode", no longer taken for an MP3), and long lines are cut before wrapping. A source file the server refuses never stops the sheet from grading (the upload goes again without that file only).
- **One-call re-grade.** "Re-grade with this key" sends the edited key with `POST /api/submissions/{id}/reevaluate` (`rubric`): validated, stored as a new snapshot and re-graded from the stored transcript in one call (held / failed sheets: `/rerun` with `rubric`).
- **Answer key only.** A key-only file (a publisher's `Que./Ans.` grid PDF, a `1-B` list, a key table), a pasted key grid or a photo of a key builds an all-MCQ key straight from the key: +4 / -1, NEET sections for 180 / 200 questions, two-answer and bonus cells kept, no AI drafting (text is parsed with no AI call; a photo takes one call to read).
- **Review holds and re-run.** A held sheet carries its `review_reason` (`low_confidence`, `low_page_confidence`, `no_answers`, `mostly_blank`, `paper_mismatch`, `paper_reordered`) and the report says what to do. A held or failed sheet is re-run from its stored upload with a key drafted on the spot (`POST /api/submissions/{id}/rerun` with an inline `rubric`). Sheets held by an older build are re-checked at start-up (no AI call).
- **Answer sheets are printed or typed, never handwritten.** The tick reader takes all-MCQ keys only (a key with a written question goes to the transcription reader) and reads PDFs and photos / scans of printed papers: 5 pages per call, 5 calls at a time, 200 DPI page masters. No cross-vendor fallback for ticks: a gpt-4o reading moved ticks and filled blanks (304/720 vs 402, at 0.95 confidence), so a transient Claude error is retried with backoff and a sheet that still fails shows **Retry**.
- **Chapter-level topics.** For a key with no question text, the tick reader also names each question's NCERT chapter from the NEET-UG list (`syllabus` in `backend/data/weightage/neet.json`: 80 chapters - Physics 28, Chemistry 20, Biology 32), so mastery, focus rows and the study plan are per chapter instead of per subject.
- **Measured on the real 19-page AIPMT 2016 ticked sheet** with the publisher's key-only answer key: Rs 27.24 and 73.6 s before these changes, **Rs 20.50 and 63 s** after, 4 AI calls.
- **Redesigned pages.**
  - Report: a student view and a teacher view. Key insights come first (score card with band and target, "In short", three key insights), then subjects, where to focus and a question grid; the study plan, exam technique, chapters, question details, sheet pages and batch comparison are folded under "More details". Review and release, re-grade / re-run, the key's source files, the study-plan lab, teaching actions, reading quality and the audit trail are teacher-view only. The student PDF follows the same order, with the faculty material last (`sair-pdf-v6`).
  - `/students`: one row per student, "Act on first", a student drawer, a Topics view and CSV export.
  - `/cohort`: one batch and test at a time, headline tiles, an action strip and tabs (Students, Chapters, Questions, Exam behaviour, Progress).
  - `/owner`: a "needs your attention" list, KPIs, batches and tabs (Progress, Topics, Exam behaviour, Faculty, Interventions, What-if, Cost & operations).
  - One definition of test, sitting, latest and previous paper across the three pages (`sittings.py`).
- **Demo data off by default** (`SEED_DEMO_DATA=0`): a fresh database has no rubric, sheet or result; the demo sets load only with `SEED_DEMO_DATA=1` through `POST /api/demo/seed` (the UI has no seed buttons).
- **Data reset.** `scripts/reset_data.py` is a dry run by default; `--yes` backs up the database, `uploads/` and `artifacts/` to `backups/<UTC timestamp>/`, then deletes every rubric, sheet and result, the demo batches and the demo faculty leads (institution, base batch and LMS keys stay).

### Fixes to earlier known issues
- Voice transcripts are cached like OCR: a repeated recording makes no transcription call (Rs 0).
- Report charts: ties are named in the takeaways, changes between percentages read as points, and the projected-gain chart ends at the stored projected score.
- An archived report version lists the live versions (no duplicate entry in the superseded view).
- README states the 0.70 OCR threshold.
- `API_CONTRACT.md` lists the rubric-parse / review / re-evaluate error codes and the `?demo=`, `urgency` and `topic` query params.
- Reports with no stored AI summary (all demo rows) show a computed summary line, labelled as computed.
- Study plan: the current -> target column now shows the level the gain and hours refer to (max(mastery, 85%)).
- Manual retries show "attempt N"; re-evaluation shows "Re-grading" (results 202) until the new grade is stored.
- Stage durations ignore log entries written after completion (sign-off, delivery).
- OCR prompt: never correct towards the expected answer (e.g. "32P" stays "32P"), mark doubtful words `[?]`, transcribe diagrams as text, and wrap notes addressed to the examiner in `[note to examiner: ...]`, which the grader ignores and the UI flags. Covered by offline tests; not yet re-checked live (see Pending 1).
- The human-review banner uses voice-specific wording for voice rows.
- The consistency re-grade scores each question like the original run: MCQs keep their deterministic +4 / -1 / 0 and marking-scheme questions are re-scored, so there is no false delta.
- An OCR result served by the GPT-4o fallback is not stored in the OCR cache, so a later upload of the same file goes to Claude again.
- AI error messages for voice calls name speech-to-text transcription or transcript mapping; the sample voice row counts its synthetic transcript.
- The contract tests follow the implemented behaviour (transcript mapping, AI routes on migrated rows, transfer profiles).

## Pending

### 1. Live walkthrough and build check
- [x] `cd frontend && npm run build`, and fix anything that breaks.
- [ ] Load `set=all` and `set=insights` into a copy of the live database (or the live one, if acceptable) and check:
  - NEET-C reports: MCQ rows with -1 and the net-total note, the Q25 marking-scheme table with the required-step lock, the voice sample card, the exam-behaviour cards for the over-attempter / fatigue / memorisation students, intervention statuses, and recording / deleting an intervention;
  - `/owner`: populated effectiveness card with the "Sample data" pill, the calibration toggle once a calibration factor exists, the "Ms. K. Menon (sample)" faculty row, inline faculty-lead save;
  - `/cohort`: NEET-C exam-behaviour lists.
- [ ] Live voice upload through the app: `samples/voice_answer_genetics_hinglish.mp3` with `voice_question=3` and `language_hints=hi,en`, and one whole-paper recording (mapping call).
- [ ] `/integrations`: create a key, preview the first 20 rows, revoke it, then paste it into the preview field (expect 403 `invalid_api_key`); run the drill with the simulated outage (expect "Claude -> GPT-4o (simulated_outage)").
- [ ] AI Bloom suggestions in the rubric version editor against the live API.
- [ ] Re-run live OCR on the test sheet that was misread ("32P" read as "15N") and on the prompt-injection sheet (`edge-04`) to confirm the new OCR prompt.
- [ ] Base-pipeline live checklist with real keys (small cost):
  - [x] re-uploading the same file logs "OCR cache hit - no vision call (Rs 0.00)" (#71);
  - [ ] a `.docx` upload works;
  - [x] prompt caching: cache read 6,802 tokens on the re-evaluation of #71 (not yet checked across two different students);
  - [x] the student PDF looks right (charts included); [ ] the cohort PDF;
  - [x] re-evaluate without a rubric change (#71 -> version 2); [ ] re-evaluate after a rubric edit; [ ] retry of a FAILED sheet.
- [x] Mobile 390 px check of every page, including the report and intake pages.
- [ ] Owner institution switcher with more than one institution (only checked in code; the data has one institution).

### 2. Known issues and follow-ups
- [ ] Required-step rule: each step award is rounded to `mark_step` before the 50% check, so 0.4 on a 1-mark required step rounds to 0.5 and counts as met. Confirm this is intended.
- [ ] Study plan: with the target at max(mastery, 85%), the ROI lab's observed-gap candidate filter admits every topic below 85%, and the PDF's "Current -> target" column shows "-> 85%". Confirm this is acceptable.
- [x] Cohort exam-behaviour lists show each student once (latest flagged test) with a note when students sat more than one test.
- [x] `/api/health` exposes `intervention_default_hours`; the intervention dialog starts from it (3 h fallback).
- [x] The LMS key dialog lists institutions from `GET /api/institutions`.
- [x] `API_CONTRACT.md` documents: `POST /api/interventions` 422 `invalid_applied_at`; `GET /api/whatif/options` 404 `unknown_batch`; 404 `not_found` for an unknown submission on `/audio` and `/transcript`; the units of the pattern fields (accuracy as a 0-1 fraction; transfer accuracies, gaps and fatigue drops in percentage points); CSV exports return all matching rows up to `LMS_MAX_ROWS` when no limit is given (JSON pages default to 500).
- [x] Older report versions open on the web (version selector, "Superseded by version N" notice).
- [ ] Demo learner percentages come from the mastery arrays, not the spec's score/max (urgency labels do match).
- [x] `insights` set: Mock 09 has the intended 2 / 6 / 4 urgency mix and Mock 10 the designed fatigue students. The seed is idempotent, so a database seeded earlier keeps the old NEET-C rows until it is re-seeded.
- [ ] Cache-write price convention in `costing.py` not re-checked against the current price list ($2.50/MTok assumed for claude-sonnet-5-5).
- [x] Mostly blank sheets (fewer than half the rubric questions answered) go to human review before grading; the per-page 0.70 gate is unchanged.
- [ ] Small run-to-run grading drift (up to +/-0.5 marks).
- [x] The days-to-exam figure is always visible in the header.
- [ ] The student PDF's "Teacher action plan" follows the stored ROI order, while the web action plan uses the observed-gap order, so P1 can differ between the two (e.g. report #70).
- [ ] When the ROI lab's strategy ranks by recoverable marks, its "How #1 was calculated" topic (the plan's #1) is not the topic with the highest ROI in "Relative ROI by topic"; the wording could make the ranking basis clearer.

- [ ] Printed papers: the official answer key of the scanned 2016 paper was not available, so its grading was checked against an independent AI reading of the same ticks and by eye on 30 questions, not against the official key.
- [ ] Printed papers: Q74, Q79 and Q100 of the 2016 paper were read differently by the rubric drafting and the student reader; not checked by eye.
- [ ] Printed papers: report and cohort views with 180-question results not yet reviewed for density (charts list every question).

### 3. Not built (deliberately trimmed for the PoC)
- Audio decoding for MP3 / M4A / OGG durations: they come from the transcription response; WAV is measured locally.

## Out of scope for the PoC (infrastructure / legal)
AWS (S3 multipart, ECS, SQS, RDS), multi-tenant RLS, authentication and roles (the owner view has no login), India-only data residency (the OpenAI routes are PoC only), a residency-approved speech-to-text engine (Whisper large-v3 / Sarvam Saarika), the 99% uptime SLO, real WhatsApp Business API, Google Vision OCR (Claude vision is the stand-in), causal measurement of intervention effects, and the pilot quality instruments (expert top-5 overlap, +/-15% faculty agreement).

## Open decisions for the client
- Real NEET exam date (currently assumed 2027-05-02).
- OCR threshold 0.70 (from the BRD); confirm on real sheets.
- Pricing / FX used for cost tracking (USD_INR=85), and the price of voice transcription (shown as "unknown" until confirmed).
- OpenAI routes (GPT-4o fallback, voice transcription) are on by default and labelled not residency-approved: keep them on for demos or switch them off (`LLM_FALLBACK=0`, `VOICE_ANSWERS=0`).
- Fallback model: gpt-4o has an announced shutdown of 2027-01-14; pick its replacement (`LLM_FALLBACK_MODEL`).
- Pattern thresholds, all labelled "default - confirm with academic lead": negative-marking skip thresholds (attempt only if at least 50% sure for high risk, 34% for medium), fatigue flagged at a 15-point accuracy drop in the last third (high at 25) or a 20-point rise in blanks, memorisation flagged when recall is at least 60% and 25+ points ahead of application (both below 40% = foundational gap; both at or above 60% = transferable).
- NEET +4/-1 as the default MCQ policy for drafted rubrics ("default - confirm with academic lead"), and the 50% required-step rule.
- LMS export returns released results only by default; confirm with the LMS partner.
- Whether the V5 requirements HTML and `docs/POC_SPEC.md` may stay in a **public** repo.

## Untested
- `start.bat` doing a real Python install (only the dry run was tested, since Python already exists here); Windows 10.
