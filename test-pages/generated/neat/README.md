# Test pages: neat handwriting

These are five clean, legible answer sheets for the **Biology - Genetics** paper
(`backend/rubrics/biology_genetics_v1.json`, Q1-Q5, 20 marks). Only the student changes from
sheet to sheet, along with the handwriting style, ink, paper, file format and resolution.
None of the pages is meant to be hard to read. They check that the pipeline completes on
good input and that its grades follow the planted mistakes.

Generator: `test-pages/generators/gen_neat.py`. It imports `samples/generate_samples.py` for
the font lookup, the answer-markup parser, the Punnett model and the exam constants.
Every random source is seeded, so the same command produces the same bytes:
`backend/.venv/Scripts/python.exe test-pages/generators/gen_neat.py [NN ...]`.
The handwriting is drawn one glyph at a time. Each glyph gets its own rotation, size, baseline
and spacing jitter, each word gets a small tilt, and each line gets drift and an optional slant.
A ballpoint texture goes on top, so the text does not look typeset.

| File | Resolution | Format | Handwriting / font, quality | Student ability, planted mistakes | What it tests | Intended | LIVE result |
|---|---|---|---|---|---|---|---|
| `answer_sheet_neat_01_near_perfect_300dpi.jpg` | 2480x3508 (A4, 300 dpi), 1.7 MB | JPEG q90 | Segoe Print, dark-blue ballpoint, slight right slant, compact. Ruled exam booklet with printed header; labels `Q1.` in the margin. Flatbed-scan look | **Near-perfect.** Every rubric point is covered. One self-corrected slip (~~mitosis~~ meiosis in Q5). Punnett squares for Q1 and Q4 | High-res input (downscaled to 2000 px by preprocessing), sub/superscripts (X^c, ^15N, NH4Cl), a crossed-out word | COMPLETED, ~20/20 | **COMPLETED**, conf **0.94**, **20.0/20** (4/4/4/4/4). Read the crossed-out word correctly and ignored it |
| `answer_sheet_neat_02_average_bradley_squared_200dpi.png` | 1654x2339 (A4, 200 dpi), 1.2 MB | PNG | Bradley Hand, black ink, 4 deg slant. 5 mm squared/graph paper, header handwritten by the student, inline `Ans 1.` labels. Clean scan | **Average A.** Q1 calls it a "monohybrid cross" (no test cross). Q3 credits Hershey and Chase. Q4 treats the woman as XX (ignores the colour-blind father), so 0% colour-blind; the Punnett square matches that wrong assumption. Q5 has no non-disjunction | Grid lines behind the text, handwritten header, inline labels, a self-consistent but wrong Punnett square | COMPLETED, ~12/20 | **COMPLETED**, conf **0.95**, **12.5/20** (3/4/2/0.5/3). ROI #1 = Sex-linked Inheritance |
| `answer_sheet_neat_03_average_kristen_plain_150dpi.png` | 1240x1754 (A4, 150 dpi), 2.2 MB | PNG | Kristen ITC, blue gel ink, slight back-slant and uphill drift. Plain white unruled paper, so the baselines wander. `Q.1` labels with a hanging indent | **Average B.** Q1 genotypic ratio given as 1TT:2Tt:1tt. Q2 definitions **and** examples swapped. Q3 says Meselson-Stahl used radioactive 32P. Q4 says "no daughters colour-blind" against its own correct Punnett square. Q5 says monosomy / 45 chromosomes | Lowest resolution, no ruling to guide line segmentation, contradictions between a diagram and the text | COMPLETED, ~9-10/20 | **COMPLETED**, conf **0.94**, **9.0/20** (2.5/0/2/3/1.5). ROI #1 = Incomplete Dominance & Codominance. The grader noticed the Q4 conflict between the Punnett square and the text |
| `answer_sheet_neat_04_weak_mvboli_ruled_phone.webp` | 1500x2100, 0.56 MB | WEBP q86 | MV Boli, black ballpoint, large and upright. Cream ruled sheet with a boxed printed header (roll number written one character per box). Well-lit phone photo on a desk with mild keystone and shading | **Weak.** Q1 Punnett drawn as Tt x Tt, 3:1, "dihybrid". Q2 vague, with an AB example only. Q3 describes conservative replication and credits Watson and Crick. Q4 "all sons colour-blind, daughters normal", no cross. Q5 partial. Half the page left blank | WEBP decoding, photo framing, per-character boxed header, short answers | COMPLETED, ~3-5/20 | **COMPLETED**, conf **0.94**, **4.5/20** (0.5/1.5/0/0/2.5). The Q1 Punnett cells were flattened into the answer text and caught as contradicting "Tt x tt" |
| `answer_sheet_neat_05_good_lucida_3page.pdf` | 3 pages, each 1654x2339 (A4, 200 dpi) embedded as JPEG q86 on A4 pages; 2.2 MB | PDF | Lucida Handwriting (joined cursive), blue-black ink. Ruled booklet, page-1 header plus "continuation" headers. Hand-drawn Meselson-Stahl centrifuge tubes | **Good but verbose.** Q2 runs from page 1 to 2, **Q3 runs from page 2 to 3 mid-sentence** with no continuation label. Q3 says generation 1 gave a heavy band plus a light band (and the tube diagram shows the same). Q4 says 25% of daughters colour-blind ("1 out of 4 children"). Q5 puts non-disjunction in mitosis and lists webbed neck (Turner) as a symptom | Multi-page stitching, answers split over page breaks, a connected cursive script, a non-text diagram | COMPLETED, ~16-17/20 | **COMPLETED**, conf **0.95**, **17.5/20** (4/4/3.5/3/3). Q3 was stitched across pages 2-3 word for word. The tube drawing was left out of the transcription |

Live run: `LIVE_TEST_NAME=neat PYTHONIOENCODING=utf-8 backend/.venv/Scripts/python.exe test-pages/run_live_test.py test-pages/generated/neat`
(model `claude-sonnet-5-5`, vision provider anthropic, 12-25 s per sheet, 2026-11-20).
The artifacts (OCR JSON, evaluation JSON and the page images the model saw) are in
`.run/live_test/neat/artifacts/`.

## Observations

- All five sheets COMPLETED, with clearly separated scores: 20 > 17.5 > 12.5 > 9 > 4.5. Each
  one lands within half a mark of the score the planted mistakes were designed for. The grader
  marked every planted error, including the subtle ones: Hershey-Chase versus Meselson-Stahl,
  32P labelling, 25% of daughters, mitosis versus meiosis, and webbed neck being a Turner symptom.
- OCR confidence stayed between 0.94 and 0.95 on every sheet, from 150 dpi to 300 dpi, across
  five fonts and on both the scans and the phone photo. On clean pages, confidence does not track
  resolution or style. It only tells good input apart from bad.
- Diagrams are transcribed as flattened cell text: Punnett squares come out as `X^c Y / X XX^c XY ...`.
  The grader uses them and compares them with the student's prose. It caught the Q1 Tt x Tt
  square on sheet 04 and the daughters-versus-square conflict on sheet 03. The centrifuge-tube
  drawing on sheet 05 was not transcribed, so Q3 was graded on its text alone.
- One small inconsistency: the sheet-level "gaps" summary for sheet 01 suggests adding
  "the mechanism of non-disjunction" for Down's syndrome. The student did write it, and the
  per-question Q5 evidence quotes it. The summary reads as generic enrichment advice rather
  than a gap that was actually found.
