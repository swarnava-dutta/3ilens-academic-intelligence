# Demo samples

Upload these files from the Faculty Workspace to run the demo end to end. They are written against the seeded **Biology - Genetics** rubric (5 questions x 4 marks = 20).

| File | Student / content | What it demonstrates |
| --- | --- | --- |
| `answer_sheet_aarav_sharma.png` | Strong student, 1 page, Punnett squares | Clean happy path. Nearly full marks; the only slip is in Q3, where DNA polymerase is written as 3'->5'. |
| `answer_sheet_priya_nair.pdf` | Mid-level student, 2-page PDF | Multi-page PDF rasterisation. Q1 names a back cross instead of a test cross. Q3 is weak: it credits the Hershey-Chase experiment. Q4 is wrong about daughters, and Q5 lists symptoms but gives no cause. The answers produce mixed mastery and ROI recommendations. |
| `answer_sheet_rohan_blurry.jpg` | Blurred, low-contrast, tilted photo | The filename contains `blurry`, so confidence is set to 0.65 and the sheet stops at `HUMAN_REVIEW_REQUIRED` before any AI call. The amber warning state appears in the UI. |
| `answer_sheet_kavya_iyer.jpg` | Weaker student, phone-photo look | Low score and gap-heavy report. Q1 gives a wrong ratio, Q2 swaps the definitions, Q3 is **not attempted**, Q4 is wrong and Q5 is partial. Omitted answers receive zero marks. |
| `rubric_physics_kinematics.json` | Custom rubric: Physics - Kinematics, 4 questions, 16 marks | Shows the "custom rubric JSON" upload option. It validates against the rubric content schema in `API_CONTRACT.md`. The Physics subject weight is 0.25. |
| `generate_samples.py` | Generator | Regenerates the four sheets from `backend/rubrics/biology_genetics_v1.json` using Pillow and PyMuPDF. |

Regenerate the sheets from the repo root. The output is deterministic, and the script uses Windows handwriting fonts when they are available.

```
backend\.venv\Scripts\python.exe samples\generate_samples.py
```

## MCQ answer sheet (negative marking, FR-4.8)

| File | Content | What it demonstrates |
| --- | --- | --- |
| `answer_sheet_mcq_mock09_sample.png` | Synthetic handwritten-style sheet for the "NEET MCQ Practice - Mock 09 (sample)" rubric: option letters for Q1-Q24 plus short worked answers for the descriptive Q25 and Q26 | NEET +4 / -1 / 0 scoring with no grading call for the MCQs. Q5, Q13 and Q21 (all Organic Chemistry) are wrong and Q20 and Q23 are blank, so Organic Chemistry shows as over-attempting (high negative-marking risk). Expect 81/104 if the sheet is read correctly. |
| `generate_mcq_sample.py` | Generator | Re-creates the sheet from `backend/rubrics/neet_mcq_mock09_sample.json` (Pillow only). |

The Mock 09 rubric is created by the `insights` demo set, so load it first (the "Load insights sample" button on the Cohort or Owner page, or `POST http://localhost:8000/api/demo/seed?set=insights`), then upload the sheet against that rubric. It is a synthetic sample, not a real student.

```
backend\.venv\Scripts\python.exe samples\generate_mcq_sample.py
```

## Voice answers (FR-2.8, synthetic TTS samples)

| File | Content | What it demonstrates |
| --- | --- | --- |
| `voice_answer_genetics_en.mp3` | English answer to Genetics **Q1** (test cross), about 30 s | One recording per question: the whole transcript becomes the Q1 answer, with no mapping call. |
| `voice_answer_genetics_hinglish.mp3` | Hindi-English answer to Genetics **Q3** (semi-conservative replication, Meselson-Stahl), Devanagari plus English scientific terms, about 30 s | Mixed-language speech. The transcription reports the detected language(s). |
| `generate_voice_samples.py` | Generator | Re-creates both clips with OpenAI text-to-speech. |

Both clips are **synthetic**: computer-generated speech (OpenAI `gpt-4o-mini-tts`, announced shutdown 2027-01-06) reading answers written for this demo. They are not recordings of real students.

To upload one, open the Faculty Workspace, pick the Genetics rubric and drop the MP3. In the "Answers question" select, choose **Q1** for the English clip or **Q3** for the Hinglish clip. For the Hinglish clip, also tick the `hi` and `en` language chips. The same upload with curl:

```
curl -F file=@samples/voice_answer_genetics_hinglish.mp3 -F student_name="Voice Sample (synthetic)" ^
     -F voice_question=3 -F language_hints=hi,en http://localhost:8000/api/upload
```

If you leave out `voice_question`, the recording is treated as a whole paper and Claude maps the transcript onto the rubric questions. This makes one extra AI call.

- Transcription uses OpenAI `gpt-transcribe` (`OPENAI_TRANSCRIBE_MODEL`). It is a PoC stand-in for Whisper large-v3 / Sarvam Saarika, is **not residency-approved**, and needs `OPENAI_API_KEY`. Set `VOICE_ANSWERS=0` to switch voice intake off.
- Cost: the transcription price is not in the price table, so the report shows the transcription cost as **unknown**. The grading call is costed as usual. Generating both clips once cost a few US cents.
- Regenerate the clips (this needs `OPENAI_API_KEY` in `.env`; without it the script prints `skipped: no OPENAI_API_KEY` and exits 0):

```
backend\.venv\Scripts\python.exe samples\generate_voice_samples.py --force
```
