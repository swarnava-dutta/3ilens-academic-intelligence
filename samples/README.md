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
