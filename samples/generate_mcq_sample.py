"""Generate a handwritten-style NEET MCQ answer sheet for the Mock 09 (sample) rubric.

Run with the backend venv (Pillow only):

    backend/.venv/Scripts/python.exe samples/generate_mcq_sample.py

Reads backend/rubrics/neet_mcq_mock09_sample.json and writes
samples/answer_sheet_mcq_mock09_sample.png: option letters for Q1-Q24 (3 wrong - all three
Organic Chemistry items, so the topic shows as over-attempting - and 2 left blank: Q20, Q23) plus
short worked answers for the descriptive Q25 and Q26. Upload it against "NEET MCQ Practice -
Mock 09 (sample)" to see +4 / -1 / 0 scoring and the negative-marking risk live.
Expected marks if read correctly: 19 x 4 - 3 + 4 + 4 = 81 / 104. Synthetic sample - not a real student.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
RUBRIC = HERE.parent / "backend" / "rubrics" / "neet_mcq_mock09_sample.json"
OUT = HERE / "answer_sheet_mcq_mock09_sample.png"
WRONG = (5, 13, 21)  # Organic Chemistry K2 / K3 / K1 -> 3 wrong of 3 attempted
BLANK = (20, 23)
W, H = 1700, 2200
INK = (28, 45, 120)
FONT_CANDIDATES = ("segoepr.ttf", "Inkfree.ttf", "comic.ttf", "DejaVuSans.ttf")


def font(size: int) -> ImageFont.ImageFont:
    for name in FONT_CANDIDATES:
        for folder in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu"), Path("/Library/Fonts")):
            if (folder / name).exists():
                return ImageFont.truetype(str(folder / name), size)
    return ImageFont.load_default()


def scribble(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, size: int, rng: random.Random) -> None:
    """Write text with a little per-character jitter so it reads as handwriting."""
    x, y = xy
    for ch in text:
        f = font(size + rng.randint(-2, 2))
        draw.text((x, y + rng.randint(-3, 3)), ch, fill=INK, font=f)
        x += int(draw.textlength(ch, font=f)) + rng.randint(0, 2)


def main() -> None:
    rubric = json.loads(RUBRIC.read_text(encoding="utf-8"))
    rng = random.Random(9)
    img = Image.new("RGB", (W, H), (252, 251, 246))
    draw = ImageDraw.Draw(img)
    for y in range(300, H - 40, 62):
        draw.line([(60, y), (W - 60, y)], fill=(190, 205, 230), width=2)
    draw.line([(150, 0), (150, H)], fill=(225, 120, 120), width=3)
    printed = font(30)
    draw.text((180, 60), rubric["name"], fill=(30, 30, 30), font=printed)
    draw.text((180, 110), "Batch: NEET-C (sample)    Marking: +4 / -1 / 0 for MCQs", fill=(60, 60, 60), font=font(24))
    draw.text((180, 150), "Synthetic sample sheet - not a real student", fill=(150, 60, 60), font=font(22))
    scribble(draw, (180, 205), "Name: Sample Learner", 40, rng)

    letters = "ABCD"
    mcqs = [q for q in rubric["questions"] if q.get("question_type") == "mcq"]
    col_x = (200, 560, 920, 1280)
    for index, q in enumerate(mcqs):
        n = int(q["question"])
        col, row = index // 6, index % 6
        x, y = col_x[col], 330 + row * 62 * 2
        answer = ""
        if n not in BLANK:
            answer = q["correct_option"]
            if n in WRONG:
                answer = letters[(letters.index(answer) + 1) % 4]
        scribble(draw, (x, y), f"{n}.  {answer}", 46, rng)

    y = 330 + 6 * 124 + 40
    scribble(draw, (60, y), "Q25.", 42, rng)
    for line in ("Energy conservation: mgh = 1/2 mv^2", "so v^2 = 2gh = 2 x 10 x 3.2 = 64", "v = 8 m/s"):
        scribble(draw, (180, y), line, 42, rng)
        y += 72
    y += 30
    scribble(draw, (60, y), "Q26.", 42, rng)
    scribble(draw, (180, y), "2C2H6 + 7O2 -> 4CO2 + 6H2O", 42, rng)

    img = img.filter(ImageFilter.GaussianBlur(0.4))
    img.save(OUT, optimize=True)
    print(f"Wrote {OUT.name}: wrong {list(WRONG)}, blank {list(BLANK)} (expected 81/104 if read correctly)")


if __name__ == "__main__":
    main()
