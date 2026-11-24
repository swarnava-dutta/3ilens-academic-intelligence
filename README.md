# 3iLens Academic Intelligence - Proof of Concept

A runnable local demo of the 3iLens journey: a faculty member uploads a student's handwritten
answer sheet (or a spoken answer), AI reads the handwriting and maps it to question numbers,
AI grades it against the institute's rubric, a deterministic engine turns the grades into topic
mastery, exam-behaviour patterns and a **Preparation ROI** study plan, and the results appear
for faculty, students' mentors and the institute owner:

- **Intake** (`/`): upload single sheets, folders or batches (PDF, images, DOCX, voice
  recordings), pick or author the rubric, and watch the processing queue update live.
- **Student Intelligence Report** (`/report/<id>`): score, mastery, urgency, teaching nudges,
  action plan, ROI lab, exam behaviour, interventions, question-by-question evidence linked
  to the source pages, and the audit trail. Downloadable as a branded PDF.
- **Students** (`/students`): one card per student with nudges, the focus matrix and history.
- **Cohort Dashboard** (`/cohort`): batch KPIs, ranking, at-risk list, common errors, class
  interventions, class exam behaviour and the effect of logged interventions.
- **Owner** (`/owner`): institute-level KPIs, batches and faculty, trend, weakest topics,
  intervention effectiveness and a what-if simulator.
- **Integrations** (`/integrations`): LMS export keys and endpoints, and the AI provider chain
  with a fallback drill.
- **How it works** (`/journey`): the end-to-end journey and what each step does in this PoC.

The AI calls are real. Anthropic Claude (`claude-sonnet-5-5` by default) reads the sheets,
grades them, maps voice transcripts to questions and drafts rubrics. OpenAI is used for voice
transcription, as the GPT-4o fallback when Claude is unavailable, and optionally for OCR; every
OpenAI route is labelled **not residency-approved - PoC only**. The AWS infrastructure from the
target architecture is replaced by local stand-ins, so the whole thing runs on one laptop.

| Part | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, lucide-react, axios |
| Backend | Python 3.11+ with FastAPI, SQLAlchemy 2, Pydantic 2, PyMuPDF (PDF render and reports) |
| AI | `anthropic` SDK (OCR, grading, transcript mapping, rubric drafts, Bloom suggestions); `openai` SDK (voice transcription, GPT-4o fallback, optional OCR) |
| Queue / storage / database | FastAPI BackgroundTasks, local `uploads/` and `artifacts/` folders, SQLite |

---

## What the PoC covers

The original PoC brief ([docs/POC_SPEC.md](docs/POC_SPEC.md)) plus the V5 requirements,
including the P1 items that were first deferred (voice answers, marking schemes, Bloom levels,
the fallback chain, exam-behaviour patterns, intervention outcomes, what-if, owner dashboard
and LMS export). Requirement ids (FR-x.y) refer to the V5 requirements document.

**Intake and pipeline**

- PDF, JPEG, PNG, WEBP and typed DOCX answer sheets, detected from the file content. Single
  uploads, folder / batch intake with per-file status and retry, language hints
  (en/hi/ta/kn/te).
- **Voice answers** (FR-2.8): MP3, WAV, M4A or OGG, transcribed by OpenAI `gpt-transcribe`
  (stand-in for Whisper / Sarvam). Either one recording per question (no extra AI call) or a
  whole-paper recording that Claude maps onto the rubric questions. Transcription cost is
  shown as **unknown** because its price is not confirmed.
- **Printed MCQ papers**: a full question paper (up to 40 pages, 200 questions) on which the
  student ticked, circled or shaded options is read as an answer sheet; options printed
  (1)-(4) map to A-D, and printed answer keys, logos and adverts are ignored. A dedicated
  reader reports the marked option for every printed question, 2 pages per call, 3 calls at a
  time; handwritten sheets longer than 10 pages are transcribed in page chunks.
- **Same-paper check:** the printed questions on a student's paper are compared with the
  rubric's. A paper from another code / set (same questions, different order) or a different
  paper is held for faculty review instead of being scored; intake warns before upload.
- **Separate answer keys:** a key-only file (list, `Que./Ans.` grid, image) is read and applied
  to a rubric, either while drafting from the question paper or later in the rubric editor. Intake reads each PDF / DOCX's
  printed text first (`POST /api/intake/inspect`, no AI call) and flags a question paper that
  carries its own answer key ("Ans. (2)") as a rubric source rather than a student sheet.
- Pre-processing: 300 DPI PDF master, deskew, contrast and sharpen.
- SHA-256 custody and an OCR cache: re-uploading identical bytes reuses the stored OCR
  ("OCR cache hit - no vision call (Rs 0.00)").
- OCR keeps the student's literal answer (it never "corrects" towards the textbook answer),
  marks doubtful words with `[?]`, transcribes Punnett squares, pedigrees and labelled
  sketches as text, and wraps text addressed to the examiner in `[note to examiner: ...]`,
  which the grader ignores and the report flags.
- Human-review gate at OCR confidence **0.70**, per sheet and per page. Faculty can approve or
  correct the transcript in a review editor, or rescan.
- Retries with backoff and a dead-letter queue with operator retry ("attempt N"). Jobs cut
  off by a server restart are moved to FAILED so they can be retried.
- **Fallback chain** (FR-3.10): if Claude times out, is unreachable, rate-limited, overloaded,
  refuses or returns nothing, the OCR, grading or voice-mapping call is retried once on
  `LLM_FALLBACK_MODEL` (default `gpt-4o`, announced shutdown **2027-01-14**). Each report shows
  which model served each stage.
- Per-call cost and token trace, prompt caching of the rubric, an operations cost view.

**Rubrics and grading**

- Rubrics from JSON, pasted text, DOCX or PDF (AI-drafted, with warnings), versioned with
  change notes and faculty approval. A question-paper PDF of 3+ pages is read from page images,
  2 pages per call: the answer key comes from printed "Ans." lines, an answer-key table or the
  ticked option, and large drafts open as a dense answer-key table for review. Bulk re-evaluation after an edit is confirmed with a cost
  estimate.
- **Marking policies** (FR-3.8, FR-4.8): NEET MCQs score +4 / -1 / 0 from the option letter
  alone, with no grading call; descriptive questions can have per-question marking schemes,
  required steps and partial-credit modes (steps, proportional, all-or-nothing). Totals can be
  negative; mastery is clamped to 0-100.
- **Bloom levels K1-K5** (FR-3.9) per question, from the rubric, an AI suggestion or a verb
  heuristic, plus the level the student demonstrated.
- A consistency re-grade check (tolerance +/-2 marks).

**Reports and analytics**

- Student report: KPIs, executive summary, teaching nudges, urgency (on track / needs
  attention / at risk), subject and topic mastery, interventions to teach / practise / check,
  action plan, ROI lab with quadrants and projected mark gain, weekly study calendar, evidence
  trace to the source pages, audit trail and AI route chips.
- **Exam behaviour** (FR-4.8, FR-4.10, FR-4.11): negative-marking risk per topic with skip
  thresholds, fatigue in the last third of the paper, memorisation vs transfer per concept,
  and a Bloom profile. Thresholds are labelled "default - confirm with academic lead".
- **Intervention log** (FR-4.13): record what was done for a topic; the outcome is measured on
  the student's next test that covers it. The effectiveness view compares treated and
  untreated topics and is labelled observational, not causal.
- Student and cohort PDFs, a ZIP bundle, a release / revoke sign-off gate, and **simulated**
  WhatsApp delivery with signed, expiring download links.
- **Owner dashboard** (FR-5.9): KPIs against the Rs 5 per-student cost target, batches with an
  editable faculty lead, faculty, trend per sitting, weakest topics, intervention
  effectiveness and the **what-if** simulator (FR-4.14, illustrative linear model). There is no
  login in this PoC.
- **LMS export API** (FR-5.10): read-only JSON and CSV for batches, students, results and topic
  mastery, behind `X-API-Key`. Keys are stored only as SHA-256 and shown once. Released results
  only by default.

**Clearly labelled sample or simulated parts:** the chapter-weightage matrix, ROI and what-if
projections, the calibration factor, every demo data set (`is_demo`, "Sample data" pills), the
synthetic voice clips, WhatsApp delivery (never sent), and Claude vision as the stand-in for
Google Vision OCR.

---

## Quick start (Windows)

1. Put your Anthropic API key in `.env` in this folder (see [Configuration](#configuration)).
   Add an OpenAI key too if you want voice answers or the GPT-4o fallback.
   If `.env` does not exist, `start.bat` creates it from `.env.example` for you.
2. **Double-click `start.bat`.**
3. Your browser opens at <http://localhost:3000> once the app is ready.

`start.bat` installs everything the app needs, then starts it. You do not need to install
Python or Node.js first, and you do not need admin rights. Requirements: Windows 10 or 11
(64-bit) and an internet connection on the first run.

| What | When it is installed | Where |
| --- | --- | --- |
| Python 3.13.17 | No Python 3.11+ is found (the Microsoft Store `python` shortcut does not count). Uses `winget` if available, otherwise the official python.org installer (SHA-256 and signature checked). Installed for the current user only. | `%LOCALAPPDATA%\Programs\Python\Python313` |
| Backend packages | `backend\.venv` is missing or broken, `backend\requirements.txt` changed since the last install, or a required package (or one it needs, extras included) is missing, at a version the file does not allow, or has files missing (damaged packages are reinstalled at the same version) | `backend\.venv` |
| Node.js 24.22.3 LTS (portable) | The `node` and `npm` that come first on `PATH` are not Node.js 20.9+ with a standard npm (the app runs on those, so a newer Node.js further down `PATH` does not count). The official nodejs.org zip is downloaded, checked against its SHA-256 and unpacked. Nothing is installed system-wide. Later runs reuse it. | `.tools\node` (only used by `start.bat`) |
| Frontend packages | `node_modules` is missing, `package.json` / `package-lock.json` changed since the last install, or `npm ls` reports a missing package | `frontend\node_modules` |

It also creates `.env` from `.env.example` if needed and seeds the database. The first run
takes a few minutes. Later runs check all of the above in a few seconds and start the
servers. The checks are done by `scripts\ensure-deps.ps1`. If a step fails (offline, a
download fails or does not match its checksum, an install fails), the launcher stops and
says what to do by hand.

`start.bat` opens two windows, **3iLens API :8000** (FastAPI) and **3iLens Web :3000**
(Next.js). Keep them open while you demo.

**To stop:** close those two windows, or double-click **`stop.bat`**. `stop.bat` stops only
3iLens processes. If another program is using port 8000 or 3000, it is left running.

Good to know:

- If port 8000 or 3000 is taken by another program, `start.bat` uses the next free port
  (8001, 3001, ...) and points the frontend at it automatically. The summary at the end of
  the launcher window shows the URLs in use.
- Running `start.bat` while 3iLens is already running reuses the running servers, even if a
  lower port has become free in the meantime.
- Only one `start.bat` runs per folder at a time. Starting it again while the first one is
  still installing or starting says so and stops (it holds `.start.lock` until the servers
  are up).
- The folder path must not contain `&` or `^` (npm cannot handle them); `start.bat` says so
  right away. Spaces and parentheses are fine.
- An empty `ANTHROPIC_API_KEY` is only a warning. The app starts, live uploads are marked
  `FAILED` with a clear message, and the blurry-sheet demo and the demo data sets still work.

### Prerequisites

`start.bat` installs Python and Node.js when they are missing (see above). You need them
yourself only for the manual setup, or on macOS/Linux.

| Tool | Version | Check |
| --- | --- | --- |
| Python | 3.11 or newer (3.13 tested) | `py -3 --version` or `python --version` |
| Node.js | 20.9 or newer (22 and 24 tested), with npm | `node --version` |
| An Anthropic API key | for live OCR and grading | <https://console.anthropic.com/> |
| An OpenAI API key (optional) | for voice answers, the GPT-4o fallback and `VISION_PROVIDER=openai` | <https://platform.openai.com/> |

### Test switches for `start.bat`

Set these in a `cmd` window before running `start.bat`, for example
`set "THREEILENS_FORCE_NODE_INSTALL=1"`, then `start.bat`.

| Variable | Effect |
| --- | --- |
| `THREEILENS_NO_BROWSER=1` | Do not open the browser. |
| `THREEILENS_NO_PAUSE=1` | Never wait for a key press, also not after an error. |
| `THREEILENS_FORCE_NODE_INSTALL=1` | Ignore the system Node.js and use the portable copy in `.tools\node`, downloading it first if needed. Only changes this folder. |
| `THREEILENS_FORCE_PYTHON_MISSING=1` together with `THREEILENS_DRY_RUN_PYTHON_INSTALL=1` | Act as if no Python were installed, print the exact install commands (winget command, download URL, SHA-256, installer command line), then stop without installing or starting anything. `THREEILENS_FORCE_PYTHON_MISSING=1` on its own really installs Python for the current user. |

---

## Architecture

The target design is a 16-step AWS pipeline. The PoC keeps each step's role and swaps the
cloud service for a local stand-in:

```
  Faculty browser (Next.js :3000)
        |  POST /api/upload  (file or recording + student name + rubric choice)
        v
 +--------------------------------------------------------------------------------------+
 |  FastAPI orchestrator :8000  (backend/main.py + backend/routers/)                    |
 |                                                                                      |
 |  AWS concept                          Local stand-in in this PoC                     |
 |  -----------------------------------  ---------------------------------------------  |
 |   1 Web portal / CloudFront          Next.js dev server (frontend/)                  |
 |   2 API Gateway                      FastAPI routes + CORS                           |
 |   3 Tenant & batch context           Seeded Instit-42 / NEET-A Mock-07 (seed.py)     |
 |   4 Upload validation                Content sniffing, 20 MB / 40-page limits,       |
 |                                      rubric validated before the file is stored      |
 |   5 S3 raw-upload bucket             ./uploads/ (SHA-256 recorded for custody)       |
 |   6 SQS job queue                    FastAPI BackgroundTasks, retries with backoff   |
 |   7 ECS / Lambda worker              pipeline.process_submission()                   |
 |   8 Pre-processing (deskew, DPI)     preprocessing.py: 300 DPI master, deskew,       |
 |                                      contrast, sharpen                               |
 |   9 OCR (Google Vision)              Claude vision (or GPT-4o); OCR cache by SHA-256 |
 |                                      Voice: OpenAI speech-to-text                    |
 |  10 Answer structuring               same call / Claude maps a voice transcript      |
 |  11 Confidence gate / human review   sheet or any page < 0.70 -> HUMAN_REVIEW        |
 |  12 Rubric evaluation engine         Claude grades descriptive answers; MCQs scored  |
 |                                      in Python; GPT-4o fallback if Claude fails      |
 |  13 Insights & Preparation ROI       insights.py, analytics.py, patterns.py          |
 |                                      (deterministic Python, no AI)                   |
 |  14 RDS governed results store       SQLite: backend/3ilens.db                       |
 |  15 S3 artifact bucket / audit       ./artifacts/<id>/ (page images, ocr.json,       |
 |                                      evaluation.json, report.json, PDFs) + log       |
 |  16 Dead-letter queue                status FAILED + artifacts/<id>/dead_letter.json |
 +--------------------------------------------------------------------------------------+
        ^
        |  GET /api/submissions (polled every 3 s), /api/results/<id>, /api/cohort, ...
  Intake  ->  Student Report  ->  Students / Cohort  ->  Owner  ->  LMS export
```

Submission statuses move `PENDING -> PROCESSING -> COMPLETED`. Two other endings exist:
`HUMAN_REVIEW_REQUIRED` (low OCR confidence; evaluation waits for faculty review and the UI
shows it in amber) and `FAILED` (any error after retries; the reason is shown in the UI and
written to the dead-letter file, and **Retry** re-runs it).

Safety rules built into the pipeline:

- A file name containing `blurry` is treated as a low-quality scan. It is set to confidence
  0.65 and stopped before any AI call, which demonstrates the BRD's human-review safety
  constraint without needing an API key.
- Descriptive marks come from the AI but are clamped to each question's maximum and rounded
  by the marking policy (0.5-mark steps by default). MCQs are scored from the option letter
  only, and the answer key is never sent to the OCR model. Totals, mastery, patterns and ROI
  are always computed in Python, never taken from the model.
- Answer-sheet text is treated as data to transcribe or grade, never as instructions; notes
  addressed to the examiner are flagged for faculty and ignored for grading.
- API keys are never logged or returned by the API.

---

## Manual setup and running

Use this if you prefer terminals over `start.bat`, or on macOS/Linux. Run all commands from
the project root.

### Windows (PowerShell, two terminals)

First time only:

```powershell
cd backend
python -m venv .venv                       # or: py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe seed.py
cd ..\frontend
npm install
cd ..
```

Terminal 1, backend:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

Terminal 2, frontend:

```powershell
cd frontend
npm run dev
```

Open <http://localhost:3000>. The API docs are at <http://localhost:8000/docs>.

If the backend runs on a different port, tell the frontend before starting it:
`$env:NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8001"; npm run dev`

### macOS / Linux

First time only:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/seed.py
(cd frontend && npm install)
```

Both servers from one terminal (Ctrl+C stops both):

```bash
trap 'kill 0' EXIT
(cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8000) &
(cd frontend && npm run dev) &
wait
```

Or use two terminals: `cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8000`
in one, and `cd frontend && npm run dev` in the other.

---

## Configuration

The backend reads settings from **`.env` in the project root** (copy `.env.example`). Restart
the backend after editing it: `--reload` watches only Python files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(empty)* | **Required for live grading.** Used for OCR (when `VISION_PROVIDER=anthropic`), grading, voice-transcript mapping, rubric drafts and Bloom suggestions. |
| `OPENAI_API_KEY` | *(empty)* | Needed for voice answers, the GPT-4o fallback and `VISION_PROVIDER=openai`. |
| `VISION_PROVIDER` | `anthropic` | Which model reads the handwriting: `anthropic` (Claude) or `openai` (GPT-4o). Grading always starts with Claude. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model for OCR and grading. |
| `OPENAI_VISION_MODEL` | `gpt-4o` | OpenAI model for OCR when `VISION_PROVIDER=openai`. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API endpoint, pinned in `.env`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API endpoint, pinned in `.env`. |
| `OCR_CONFIDENCE_THRESHOLD` | `0.70` | OCR confidence below this, for the whole sheet or any single page, goes to `HUMAN_REVIEW_REQUIRED` (BRD FR-2.4 default). |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Browser origins allowed to call the API. Any `localhost`/`127.0.0.1` port is also accepted. |
| `DATABASE_URL`, `UPLOAD_DIR`, `ARTIFACT_DIR` | `backend/3ilens.db`, `uploads/`, `artifacts/` | Optional overrides, mainly for tests. |
| `NEXT_PUBLIC_API_BASE_URL` (frontend env) | `http://localhost:8000` | Where the browser finds the API. `start.bat` sets it for you. |
| `VOICE_ANSWERS` | `1` | Voice answers (MP3/WAV/M4A/OGG) transcribed by OpenAI. **Not residency-approved - PoC only.** `0` turns voice intake off. Needs `OPENAI_API_KEY`. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Transcription model (stand-in for Whisper large-v3 / Sarvam Saarika). Its per-minute price is not known, so voice cost is shown as "unknown". |
| `LLM_FALLBACK` | `1` | When Claude fails (timeout, outage, rate limit, refusal, empty reply), retry OCR / grading / voice mapping once on OpenAI. **Not residency-approved - PoC only.** `0` turns it off. |
| `LLM_FALLBACK_MODEL` | `gpt-4o` | Fallback model. gpt-4o has an announced shutdown of **2027-01-14**; change it before then. |
| `LLM_SIMULATE_PRIMARY_OUTAGE` | `0` | Demo switch for the outage drill: skips every Claude call so the fallback runs. |
| `LMS_API` | `1` | Read-only LMS export API (`/api/lms/v1/*`, header `X-API-Key`). `0` -> 503. |
| `LMS_API_KEY` | *(empty)* | Optional static LMS key, accepted alongside keys created in the UI (those are stored only as SHA-256 and shown once). Never logged. |
| `LMS_MAX_ROWS` | `5000` | Max rows per LMS export call (100-50000). |
| `INTERVENTION_DEFAULT_HOURS` | `3` | Default hours for a logged intervention (0.5-40). |

Other optional settings, with their defaults (all listed in `.env.example` and in the Settings
table of [API_CONTRACT.md](API_CONTRACT.md)):

| Area | Variables |
| --- | --- |
| OCR cache | `OCR_CACHE=1` |
| Pre-processing | `PDF_MASTER_DPI=300`, `VISION_MAX_EDGE_PX=2000`, `PREPROCESS_ENHANCE=1`, `PREPROCESS_CONTRAST=1.4`, `MIN_SHORT_EDGE_PX=1200` |
| Worker | `MAX_JOB_ATTEMPTS=3`, `RETRY_BACKOFF_BASE_SECONDS=2.0`, `WORKER_CONCURRENCY=4` |
| Printed papers | `MAX_PDF_PAGES=40`, `OCR_PAGES_PER_CALL=10`, `MCQ_OCR_PAGES_PER_CALL=2`, `RUBRIC_PAGES_PER_CALL=2`, `AI_CHUNK_CONCURRENCY=3` |
| Cost tracking | `USD_INR=85`, `COST_TARGET_INR=5`, `LATENCY_TARGET_SECONDS=300`, `BATCH_TARGET_SECONDS=1800`, `LLM_PRICING_JSON` |
| Study plan | `DEFAULT_EXAM=NEET`, `NEET_EXAM_DATE=2027-05-02` (assumed, labelled so in the UI), `STUDY_HOURS_PER_WEEK=18` |
| Delivery and PDFs | `WHATSAPP_MODE=blocked` (always simulated), `DOWNLOAD_LINK_SECRET`, `DOWNLOAD_LINK_TTL_HOURS=24`, `REPORT_LOGO_PATH` |

**Model note:** the original spec named Claude 3.5 Sonnet (`claude-3-5-sonnet-20241022`).
That model was retired on 2025-10-28, so the PoC uses the current Sonnet,
`claude-sonnet-5-5`. Change `ANTHROPIC_MODEL` to use another Claude model. Claude requests use
structured JSON output and opt into Anthropic's server-side refusal fallback
(`fallbacks="default"`).

The `ANTHROPIC_*` and `OPENAI_*` values come only from `.env`. Variables with those
prefixes that are inherited from your shell or Windows user environment are ignored. This
stops a proxy or key set up for another tool from leaking into the demo.

---

## Seeding and demo data

- **Base seed** (runs automatically at every backend start, and in `start.bat`): institution
  `Instit-42`, batch `NEET-A` / `Mock-07`, and the **Biology - Genetics** rubric
  (5 questions x 4 marks = 20). It is safe to run repeatedly:
  `backend\.venv\Scripts\python.exe backend\seed.py`
- **Demo data sets** (optional). They make no AI calls, every row is labelled as sample data
  (`is_demo`), and repeated runs add nothing. Load them with the seed buttons on the empty
  Intake queue, Cohort and Owner pages, or with `POST http://localhost:8000/api/demo/seed?set=<name>`:

  | Set | Contents |
  | --- | --- |
  | `genetics` (default) | 12 synthetic graded Genetics students plus one human-review case; 2 are released. Also `seed.py --demo`. |
  | `mixed` | The mixed NEET sample rubric in batch `NEET-B` / `Mock-08` with 6 sample learners, plus earlier mocks for 4 Genetics students (history). |
  | `all` | `genetics` + `mixed` (27 rows on a fresh database). Also `seed.py --all`. |
  | `insights` | Batch `NEET-C (sample)` with the NEET MCQ Mock 09 and Mock 10 (sample) papers (+4/-1 marking, Bloom levels, a marking scheme), 12 students on each, logged interventions with measured outcomes, released results and a voice-answer sample row. Drives the exam-behaviour, intervention-effectiveness and what-if views. |

- **Reset everything:** stop the servers, then delete `backend\3ilens.db` and the contents of
  `uploads\` and `artifacts\`. The next start recreates the base seed.

---

## Client demo script

The sample files are in `samples/` (see `samples/README.md`).

1. **Start.** Double-click `start.bat`. On the Intake page, the header pill should say
   **AI ready**. If it says *AI keys missing*, add the key to `.env` and restart.
2. **Happy path.** Upload `samples/answer_sheet_aarav_sharma.png` with student name *Aarav
   Sharma* and the default rubric. Watch the queue row move through Pre-processing, OCR,
   Rubric evaluation and Insights to **Completed** (usually 1-2 minutes with live AI). Click
   **View report**: KPIs, summary and nudges, the action plan and ROI lab, the transcribed
   answer and evidence for every question (linked to the page image), the AI route used for
   each stage, and the audit trail. Download the PDF from the report.
3. **Safety constraint.** Upload `samples/answer_sheet_rohan_blurry.jpg`. Within a few seconds
   it turns amber, **Human review required** (OCR confidence 65%, below the 70% gate), and AI
   grading is skipped. Open the review editor to type or correct the answers. This step works
   without API keys.
4. **More sheets (optional).** `answer_sheet_priya_nair.pdf` shows a 2-page PDF and a mixed
   ROI plan. `answer_sheet_kavya_iyer.jpg` shows a phone photo with Q3 not attempted, which
   scores zero.
5. **Voice answer (needs `OPENAI_API_KEY`).** Drop `samples/voice_answer_genetics_hinglish.mp3`,
   choose **Q3** under *Answers question* and tick `hi` and `en`. The report shows the audio
   player, the transcript and the "not residency-approved" note.
6. **Sample analytics.** Load the `all` and `insights` demo sets (buttons on the Cohort and
   Owner pages).
   - **Cohort:** KPIs, ranking, at-risk students, common errors, class interventions, the
     class exam-behaviour section (negative-marking risk, fatigue, memorisation vs transfer,
     Bloom accuracy) and the intervention effect for the batch.
   - **A NEET-C report:** MCQ rows such as "Marked C · Correct B · -1", the net total after
     negative marking, the Exam behaviour cards and the Interventions log. Record an
     intervention from there.
   - **Owner:** institute KPIs, batches with the editable faculty lead, trend, intervention
     effectiveness and the what-if simulator (try "+5 h Organic Chemistry").
   - Optional: upload `samples/answer_sheet_mcq_mock09_sample.png` against the "NEET MCQ
     Practice - Mock 09 (sample)" rubric to see +4/-1/0 scoring on a live read (expect about
     81/104).
7. **Integrations.** Create an LMS key (the secret is shown once), preview the first 20
   released rows, then revoke it. In the AI providers card, run the fallback drill with
   *Simulate Claude outage* on: it makes real provider calls (about Rs 1-2) and shows the
   route "Claude -> GPT-4o (simulated_outage)".
8. **Custom rubric.** In the upload card, choose `samples/rubric_physics_kinematics.json`
   under *Custom rubric JSON* (the **Template** link downloads the current rubric as a
   starting point), or open the rubric editor to try the NEET +4/-1 preset, MCQ options,
   marking schemes and Bloom suggestions. Note that grading a Biology sheet against the
   Physics rubric scores low; this step only shows the rubric options.

---

## API summary

Full JSON shapes, status codes, error codes and validation rules are in
**[API_CONTRACT.md](API_CONTRACT.md)**. Interactive docs: <http://localhost:8000/docs>.

| Area | Endpoints |
| --- | --- |
| Core | `GET /api/health`, `GET /api/rubrics`, `POST /api/intake/inspect` (optional `rubric_id`), `POST /api/upload`, `GET /api/submissions`, `GET /api/results/{id}`, `GET /api/cohort`, `POST /api/demo/seed?set=genetics\|mixed\|all\|insights` |
| Pipeline operations | `POST /api/submissions/{id}/retry`, `.../reevaluate`, `.../review`, `.../rescan`; `GET /api/submissions/{id}/ocr`, `.../pages`, `.../pages/{n}`, `.../invocations`; `GET /api/ops/costs`; `GET /api/intake-batches/{id}` |
| Voice | `GET /api/submissions/{id}/audio`, `GET /api/submissions/{id}/transcript` |
| Rubrics | `POST /api/rubrics/parse` (AI draft, optional `key_file`), `POST /api/rubrics/answer-key`, `POST /api/rubrics`, `POST /api/rubrics/{id}/versions`, `GET /api/rubrics/{id}/reevaluation-estimate`, `POST /api/rubrics/{id}/bloom-levels` |
| Analytics | `GET /api/results/{id}/plan`, `POST /api/results/{id}/consistency-check`, `GET /api/weightage`, `GET /api/exams`, `PATCH /api/batches/{id}` (exam, exam date, faculty lead) |
| Outputs | `GET /api/reports/{id}/pdf`, `GET /api/cohort/pdf`, `GET /api/reports/bundle.zip`, `POST /api/results/{id}/release` and `/revoke`, `POST /api/deliveries` (simulated), `GET /api/download/{token}`, `GET /api/students`, `GET /api/students/{ref}/history`, `GET /api/filters` |
| Interventions and what-if | `POST /api/interventions`, `GET /api/interventions`, `DELETE /api/interventions/{id}`, `GET /api/interventions/effectiveness`, `POST /api/whatif`, `GET /api/whatif/options` |
| Owner | `GET /api/owner/dashboard?institution_id=` |
| AI provider chain | `GET /api/ops/llm-chain`, `POST /api/ops/llm-chain/drill` (real provider calls) |
| LMS keys (local admin) | `GET /api/lms/info`, `GET /api/lms/keys`, `POST /api/lms/keys`, `POST /api/lms/keys/{id}/revoke` |
| LMS export (`X-API-Key`) | `GET /api/lms/v1/batches`, `.../students`, `.../results`, `.../results.csv`, `.../topic-mastery.csv` |

Upload rules: PDF, JPEG, PNG, WEBP or DOCX answer sheets, or MP3, WAV, M4A or OGG recordings,
detected from the file content rather than the extension (otherwise 415); at most 20 MB
(413); PDFs at most 40 pages (`MAX_PDF_PAGES`); corrupt files and invalid rubric JSON return 422. With
`VOICE_ANSWERS=0`, audio returns 415 `voice_disabled`.

LMS export example (released results only unless `include_provisional=true`; create a key on
the Integrations page or set `LMS_API_KEY`):

```bash
curl -H "X-API-Key: $LMS_KEY" "http://localhost:8000/api/lms/v1/results?batch_id=1&limit=50"
curl -H "X-API-Key: $LMS_KEY" -o results.csv "http://localhost:8000/api/lms/v1/results.csv"
```

The CSV files start with a UTF-8 BOM so Excel opens them correctly, and cells that start with
`= + - @` are prefixed with an apostrophe so spreadsheets do not run them as formulas.

---

## How Preparation ROI works

From the BRD, for every topic on the rubric:

```
mastery         = marks scored / marks available for the topic         (0-100 %)
gain potential  = 100 - mastery
topic weightage = subject weight x topic marks / assessed marks in that subject
ROI             = (weightage x gain potential) / effort_hours
```

- NEET subject weights: **Physics 25%, Chemistry 25%, Biology 50%**.
- `effort_hours` (the estimated study time to close the topic) comes from the rubric.
- Topics at 90% mastery or above count as mastered and are left out. The rest are sorted
  by ROI, highest first, and the top 5 become the study priorities, each with a short
  rationale.
- With negative marking, topic mastery uses the net marks and is clamped to 0-100.

Worked example (Biology - Genetics rubric): *Molecular Basis of Inheritance* is worth 4 of
the 20 Biology marks, so its weightage is 0.50 x 4/20 = **0.10**. A student who scores 2/4 has
50% mastery and 50 points of gain potential. With 4 effort hours, ROI = 0.10 x 50 / 4 =
**1.25**.

The Cohort Dashboard applies the same formula to the cohort's average mastery per topic. The
report's ROI lab, projected mark gain, weekly calendar and the owner what-if use an
**illustrative** NEET chapter-weightage matrix (`backend/data/weightage/neet.json`) and are
labelled as such.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| A port is already in use | `start.bat` moves to the next free port and prints the URLs. Manually: `netstat -ano \| findstr :8000` shows the owner's PID. Start uvicorn with another `--port` and set `NEXT_PUBLIC_API_BASE_URL` for the frontend. |
| Upload ends in **FAILED**: "ANTHROPIC_API_KEY is not configured" | Add the key to `.env` in the project root, then restart the backend (close the *3iLens API* window and run `start.bat` again). |
| FAILED with "rejected the API key", "model ... not available", "rate limit" or "temporarily unavailable" | The message comes from the provider. Check the key and `ANTHROPIC_MODEL` in `.env`, or retry later with **Retry**. Details are in `artifacts/<id>/dead_letter.json` and the API window. With an OpenAI key and `LLM_FALLBACK=1`, outages and rate limits are retried once on the fallback model first. |
| A voice answer fails at transcription | Voice needs `OPENAI_API_KEY` in `.env` and `VOICE_ANSWERS=1`. Restart the backend after adding the key. |
| Red **API offline** banner in the app | The backend is not running, or the frontend points to the wrong port. Check the *3iLens API* window; `start.bat` sets the port automatically. |
| Browser console shows CORS errors | Open the app at `http://localhost:<port>` or `http://127.0.0.1:<port>`. For other hosts, add the origin to `CORS_ORIGINS` in `.env` and restart the backend. |
| A job stays in PROCESSING for a long time | Live grading normally takes 30-120 s. Each AI request times out after 180 s and is retried once; transient errors are retried up to `MAX_JOB_ATTEMPTS` times with backoff before the job is marked FAILED. |
| A job shows "Interrupted by server restart" | The backend restarted during processing (for example after editing a `.py` file with `--reload`). Click **Retry** on the row. |
| The fallback drill returns `fallback_unavailable` | The outage is simulated but `LLM_FALLBACK=0` or `OPENAI_API_KEY` is empty. |
| `start.bat` could not install Python or Node.js | Usually no internet access, or a proxy/firewall blocks python.org or nodejs.org. The launcher prints the URL it tried. A download that stalls (no data for 60 s) is retried twice and then reported, instead of hanging. Install Python 3.11+ (tick *Add python.exe to PATH*) and Node.js 20.9+ by hand, then run it again. |
| "start.bat is already running for this folder" | Another launcher window for this folder is still installing or starting. Wait for it, or close it and run `start.bat` again. |
| "The folder path contains & or ^" | Move or rename the 3iLens folder, for example to `C:\3ilens`. |
| `start.bat` downloads a portable Node.js although Node.js is installed | The `node.exe` (or the `npm`) that comes first on `PATH` is older than 20.9, for example a leftover install or an old version-manager link. Remove it from `PATH` to use the installed Node.js instead; the portable copy in `.tools\node` works too. |
| "failed its SHA-256 check" | The download was damaged or changed on the way, so it was deleted and not used. Run `start.bat` again. If it keeps happening, install that tool by hand. |
| Lots of old test uploads | See *Reset everything* above. |

---

## Running the tests

Backend tests run offline: AI and transcription calls are faked, and each test uses a
temporary database and folders, never `backend/3ilens.db` or real keys.

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
```

`tests/test_contract.py` drives the full upload-to-report journey through the HTTP API and
checks every JSON field against the TypeScript types in `frontend/src/lib/types.ts`, so the
backend and frontend cannot drift apart silently.

Frontend checks:

```powershell
cd frontend
npx tsc --noEmit
npm run lint
npm run build
```

`test-pages/` holds 26 varied generated answer sheets and `run_live_test.py` for live
end-to-end runs (real AI calls; see `test-pages/README.md`).

---

## Project layout

```
.env.example            settings template (copy to .env)
API_CONTRACT.md         HTTP contract shared by backend and frontend
STATUS.md               what is done, pending, out of scope, and open decisions
start.bat / stop.bat    one-click start and stop (Windows)
scripts/
  ensure-deps.ps1       installs/checks Python, Node.js and the packages for start.bat
  check-requirements.py checks backend\.venv against requirements.txt (used by ensure-deps.ps1)
  server-processes.ps1  process helper used by start.bat / stop.bat (ports, server windows, stop)
.tools/                 portable Node.js downloaded by start.bat when needed (git-ignored)
backend/
  main.py               FastAPI app and core routes
  routers/              pipeline ops, analytics, outputs, voice, AI chain, insights, owner, LMS
  pipeline.py           worker: pre-processing/transcription -> OCR -> evaluation -> insights
  preprocessing.py      image/PDF normalisation for the vision model
  uploads.py            upload validation and content sniffing (documents and audio)
  paper_detect.py       printed-paper detection from the text layer (answer-key paper, MCQ paper)
  paper_pages.py        question-paper PDF pages rendered for page-by-page rubric drafting
  mcq_marks.py          reads the marked option of every question on a printed MCQ paper
  paper_match.py        checks a printed paper's questions against the rubric (same paper / code)
  answer_keys.py        reads key-only answer files and applies them to rubrics
  ai.py, llm_route.py   Claude/OpenAI calls, fallback chain, route provenance, error mapping
  voice.py              speech-to-text and voice result details
  marking.py, bloom.py  MCQ +4/-1, marking schemes and partial credit; Bloom K1-K5
  insights.py           deterministic mastery and Preparation ROI engine
  analytics.py          urgency, study plan, ROI lab, nudges
  patterns.py           negative-marking risk, fatigue, memorisation vs transfer
  outcomes.py, whatif.py intervention outcomes and effectiveness; what-if projections
  cohort.py, owner.py   cohort and institute-owner aggregates
  lms.py                LMS export rows, CSV and API keys
  reports.py            student and cohort PDFs
  database.py           SQLAlchemy models (SQLite) and the idempotent migration
  schemas.py            API response models and rubric validation
  seed.py, seed_insights.py  base seed and the demo data sets
  rubrics/              Genetics, mixed NEET and sample MCQ / oral rubrics
  data/weightage/       illustrative NEET chapter-weightage matrix
  tests/                pytest suite (offline)
frontend/src/
  app/                  routes: /, /report/[id], /students, /cohort, /owner, /integrations, /journey
  components/           intake, report, students, cohort, owner, integrations and rubric UI
  lib/                  API client, shared types, formatters
samples/                demo answer sheets, an MCQ sheet, voice clips and a custom rubric
test-pages/             generated test sheets and the live test runner
docs/POC_SPEC.md        original PoC specification
uploads/, artifacts/    local stand-ins for S3 (created at runtime)
```
