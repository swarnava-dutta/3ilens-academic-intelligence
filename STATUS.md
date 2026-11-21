# 3iLens PoC - Project status

_Last updated: 2026-11-21._

Repo: https://github.com/swarnava-dutta/3ilens-academic-intelligence
Run: double-click `start.bat` (installs anything missing, starts API + web, opens the browser). Stop: `stop.bat`.
Port note: if port 8000 is taken by another local app, `start.bat` picks the next free port (for example API `:8001`, web `:3000`).
Planning notes used while building the requirements are kept in local planning notes (`docs/plans`, not in the repo).

## Verification state

| Check | Result |
|---|---|
| Backend tests (`cd backend && .venv\Scripts\python -m pytest -q`) | 781 passed, 3 failed on the last full run. The 3 failing tests pinned placeholder behaviour (empty AI routes, no transfer profile, no transcript mapping) that is now implemented; they need updating to the real behaviour (see Pending 2) |
| Frontend `npx tsc --noEmit` + `npm run lint` | clean |
| Frontend `npm run build` | not re-run since the latest feature work |
| Live AI end-to-end, base pipeline | done: 26 test pages, 23 COMPLETED / 3 HUMAN_REVIEW / 0 FAILED (see `test-pages/README.md`) |
| Live AI checks, newer features | partial: two fallback drills (Claude primary 3.0/4 in 9.4 s, Rs 1.85; simulated outage served by gpt-4o 3.5/4 in 4.0 s, Rs 0.76), one live transcription of the Hindi-English voice sample (`gpt-transcribe`, 30 s), live result rows showing their AI routes |
| Live UI checks | headless screenshots of the intake page, live and demo reports, `/owner` (including a what-if run), `/cohort` and `/integrations`; `/owner`, `/cohort` and `/integrations` have no horizontal scroll at 390 px |
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
- Samples (`samples/`) and 26 varied test pages (`test-pages/generated/{neat,messy,photo,edge}`), plus `test-pages/run_live_test.py` for live runs.
- Public GitHub repo, with `.env` committed but the keys blank (the local `.env` is marked skip-worktree).

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
  - DOCX uploads; real pre-processing (300 DPI master, contrast 1.4, sharpen, deskew);
  - SHA-256 custody and an OCR cache (cache hit = no vision call, Rs 0);
  - OCR gate at **0.70**, per sheet and per page;
  - cost / usage trace per call; retry and dead-letter re-drive; OCR review editor and rescan; re-evaluate without OCR;
  - rubric versions; page-image endpoints; operations cost endpoint.
- **Outputs:**
  - branded student and cohort PDFs (PyMuPDF) and a ZIP bundle;
  - release / revoke gate; **simulated** WhatsApp delivery with signed links;
  - students, history and filters APIs;
  - mixed NEET demo rubric and multi-batch / longitudinal demo data (sample).
- **Student report:** the full SAIR layout:
  - provisional banner, run metadata, KPI tiles, executive summary, immediate reading with nudges, urgency;
  - subject roll-up, topic screening, worksheet, intervention chooser, action plan, ROI lab;
  - evidence trace to source pages, audit trail, print styles;
  - a `/students` page with cards, nudges and the focus matrix.
- **Intake and cohort UI:**
  - batch / folder / DOCX intake with per-file status and retry, language hints, rubric from text with versioning;
  - re-evaluation confirmation with a cost estimate;
  - cohort extensions (ranking, at-risk, common errors, interventions, exam date, operations, filters);
  - `/journey` page.

### Previously deferred requirements (now implemented)
- **FR-2.8 voice answers.** MP3 / WAV / M4A / OGG detected from the bytes; OpenAI `gpt-transcribe` as a stand-in for Whisper / Sarvam, labelled **not residency-approved** with cost shown as **unknown**. Per-question recordings make no extra AI call; whole-paper recordings are mapped onto the rubric questions by Claude (GPT-4o fallback). The transcript then goes through the confidence gate and grading. Audio and transcript endpoints, an audio player and transcript in the report and review editor, a "Voice answer" chip and question select at intake. Retry, dead-letter, review, re-evaluate and restart handling work for voice rows. Two synthetic TTS clips in `samples/`.
- **FR-3.8 marking schemes.** Per-question schemes with required steps; partial-credit modes `steps`, `proportional`, `all_or_nothing`; the grader returns per-step awards that are re-scored in Python. Rubric editor with marking-policy presets (NEET +4/-1, board 0.5-mark steps, whole marks, none, custom) and a live "x / max" check.
- **FR-3.9 Bloom K1-K5.** Level from the rubric, an AI suggestion (`POST /api/rubrics/{id}/bloom-levels`) or a verb heuristic; the grader reports the demonstrated level. Bloom badges in the report and a Bloom profile.
- **FR-3.10 fallback chain.** Claude timeouts, connection errors, 5xx, rate limits, refusals or empty replies retry OCR / grading / voice mapping once on `LLM_FALLBACK_MODEL` (default `gpt-4o`, announced shutdown 2027-01-14). Route chips per stage in the report; provider chain status and an outage drill on `/integrations`.
- **FR-4.8 negative marking.** MCQs scored +4 / -1 / 0 from the option letter with no grading call (an all-MCQ paper makes no AI grading call at all); net totals can be negative. Per-topic negative-marking risk with skip thresholds.
- **FR-4.10 fatigue** in the final third of the paper (cohort-adjusted when at least 5 results share the rubric) and **FR-4.11 memorisation vs transfer** per concept, for students and the class.
- **FR-4.13 intervention outcomes.** Log an intervention from the report; the outcome comes from the student's next test on that topic (improved / flat / declined / not assessed / pending). Effectiveness compares treated and untreated topics (labelled observational, not causal) and gives a per-institution calibration factor once 5 outcomes are measured.
- **FR-4.14 what-if.** Projects extra study hours with the illustrative linear model on the NEET matrix, optionally calibrated; shown on `/owner`.
- **FR-5.9 owner dashboard.** `/owner`: KPIs against the Rs 5 cost target, urgency strip, batches with an editable faculty lead and an indicative trend, faculty, trend per sitting, weakest topics, intervention effectiveness, what-if. No login in this PoC.
- **FR-5.10 LMS export.** Read-only JSON and CSV (`/api/lms/v1/*`) behind `X-API-Key`; keys stored only as SHA-256 and shown once; released results only by default; CSVs with a UTF-8 BOM and formula-injection guard; key management and a preview on `/integrations`.
- **Sample data:** `POST /api/demo/seed?set=insights` adds batch `NEET-C (sample)` with the NEET MCQ Mock 09 / Mock 10 (sample) papers, 25 submissions, 24 interventions (22 measured) and a voice sample row, all labelled as sample data and scored by the real engine. `set=all` is unchanged (27 rows). A synthetic MCQ answer sheet for Mock 09 is in `samples/`.

### Fixes to earlier known issues
- README states the 0.70 OCR threshold.
- `API_CONTRACT.md` lists the rubric-parse / review / re-evaluate error codes and the `?demo=`, `urgency` and `topic` query params.
- Reports with no stored AI summary (all demo rows) show a computed summary line, labelled as computed.
- Study plan: the current -> target column now shows the level the gain and hours refer to (max(mastery, 85%)).
- Manual retries show "attempt N"; re-evaluation shows "Re-grading" (results 202) until the new grade is stored.
- Stage durations ignore log entries written after completion (sign-off, delivery).
- OCR prompt: never correct towards the expected answer (e.g. "32P" stays "32P"), mark doubtful words `[?]`, transcribe diagrams as text, and wrap notes addressed to the examiner in `[note to examiner: ...]`, which the grader ignores and the UI flags. Covered by offline tests; not yet re-checked live (see Pending 1).
- The human-review banner uses voice-specific wording for voice rows.

## Pending

### 1. Live walkthrough and build check
- [ ] `cd frontend && npm run build`, and fix anything that breaks.
- [ ] Load `set=all` and `set=insights` into a copy of the live database (or the live one, if acceptable) and check:
  - NEET-C reports: MCQ rows with -1 and the net-total note, the Q25 marking-scheme table with the required-step lock, the voice sample card, the exam-behaviour cards for the over-attempter / fatigue / memorisation students, intervention statuses, and recording / deleting an intervention;
  - `/owner`: populated effectiveness card with the "Sample data" pill, the calibration toggle once a calibration factor exists, the "Ms. K. Menon (sample)" faculty row, inline faculty-lead save;
  - `/cohort`: NEET-C exam-behaviour lists.
- [ ] Live voice upload through the app: `samples/voice_answer_genetics_hinglish.mp3` with `voice_question=3` and `language_hints=hi,en`, and one whole-paper recording (mapping call).
- [ ] `/integrations`: create a key, preview the first 20 rows, revoke it, then paste it into the preview field (expect 403 `invalid_api_key`); run the drill with the simulated outage (expect "Claude -> GPT-4o (simulated_outage)").
- [ ] AI Bloom suggestions in the rubric version editor against the live API.
- [ ] Re-run live OCR on the test sheet that was misread ("32P" read as "15N") and on the prompt-injection sheet (`edge-04`) to confirm the new OCR prompt.
- [ ] Base-pipeline live checklist with real keys (small cost):
  - re-uploading the same file logs "OCR cache hit - no vision call (Rs 0.00)";
  - a `.docx` upload works;
  - `cache_read_input_tokens > 0` on the second student (prompt caching);
  - the student PDF and cohort PDF look right;
  - re-evaluate after a rubric edit and retry of a FAILED sheet both work.
- [ ] Mobile 390 px check of the report and intake pages (`/owner`, `/cohort` and `/integrations` were checked).
- [ ] Owner institution switcher with more than one institution (only checked in code; the data has one institution).

### 2. Known issues and follow-ups
- [ ] Update the three backend tests that still pin placeholder behaviour: transcript mapping without a question hint (now raises `AIConfigurationError` without a key instead of `not_implemented`), AI routes on a migrated copy of the real database (now real routes, not `[]`), and the Genetics demo transfer profile (now present).
- [ ] Consistency re-grade (`POST /api/results/{id}/consistency-check`): MCQs are compared against the grader's marks, which shows a false delta against the deterministic +4 / -1, and marking-scheme questions are not re-scored. Score each question through `marking.score_question` instead.
- [ ] An OCR result served by the GPT-4o fallback is stored in the OCR cache under the Claude cache key. Harmless, but a fallback transcript can be reused; consider skipping the cache store when the provider differs.
- [ ] AI error messages for voice calls read "... during rubric evaluation": add labels for `transcription` and `voice_mapping`.
- [ ] The sample voice row reports `transcript_chars: 0` while its transcript endpoint returns the synthetic transcript.
- [ ] Required-step rule: each step award is rounded to `mark_step` before the 50% check, so 0.4 on a 1-mark required step rounds to 0.5 and counts as met. Confirm this is intended.
- [ ] Study plan: with the target at max(mastery, 85%), the ROI lab's observed-gap candidate filter admits every topic below 85%, and the PDF's "Current -> target" column shows "-> 85%". Confirm this is acceptable.
- [ ] Cohort exam-behaviour lists for NEET-C can show the same student twice (Mock 09 and Mock 10); filtering by test shows one at a time.
- [ ] `INTERVENTION_DEFAULT_HOURS` is not exposed by `/api/health`; the intervention dialog uses 3 h.
- [ ] The LMS key dialog loads the whole owner dashboard just to list institutions; a small institutions endpoint would be lighter.
- [ ] `API_CONTRACT.md` should also document: `POST /api/interventions` 422 `invalid_applied_at`; `GET /api/whatif/options` 404 `unknown_batch`; 404 `not_found` for an unknown submission on `/audio` and `/transcript`; the units of the pattern fields (accuracy as a 0-1 fraction; transfer accuracies, gaps and fatigue drops in percentage points); CSV exports return all matching rows up to `LMS_MAX_ROWS` when no limit is given (JSON pages default to 500).
- [ ] Older report versions are only available as PDFs (there is no archived-result JSON endpoint), so there is no "Superseded" banner on the web.
- [ ] Demo learner percentages come from the mastery arrays, not the spec's score/max (urgency labels do match). In the `insights` set, a few Mock 09 urgencies differ from the intended mix (e.g. Kunal Desai shows at risk), and Mock 10 has no designed fatigue pattern.
- [ ] Cache-write price convention in `costing.py` not re-checked against the current price list ($2.50/MTok assumed for claude-sonnet-5-5).
- [ ] Sheet confidence ignores blank answers (one clean answer plus four blanks still passes the sheet-level check); re-test now that pages are gated individually.
- [ ] Small run-to-run grading drift (up to +/-0.5 marks).
- [ ] With six navigation links, the header's days-to-exam chip only shows on very wide screens (the Cohort page still shows the exam date).

### 3. Not built (deliberately trimmed for the PoC)
- OCR-cache reuse for voice answers (a repeated recording is transcribed again).
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
