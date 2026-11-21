"""Generate handwritten-looking demo answer sheets for the 3iLens PoC.

Run with the backend venv (needs only Pillow and PyMuPDF):

    backend/.venv/Scripts/python.exe samples/generate_samples.py

The script reads backend/rubrics/biology_genetics_v1.json (title, question numbers,
total marks) and writes four answer sheets next to this file:

    answer_sheet_aarav_sharma.png   strong student, one page
    answer_sheet_priya_nair.pdf     mid-level student, two pages (images embedded in a PDF)
    answer_sheet_rohan_blurry.jpg   heavily blurred photo -> HUMAN_REVIEW_REQUIRED demo path
    answer_sheet_kavya_iyer.jpg     weaker student, phone-photo look, still legible

Answer markup used in the texts below:
    ~~word~~   the word is written and then crossed out
    ^{..}      superscript (X^{c}, ^{15}N)
    _{..}      subscript   (NH_{4}Cl)
Output is deterministic (seeded RNG per student).
"""
from __future__ import annotations

import io
import json
import math
import os
import random
import re
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import pymupdf
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
RUBRIC_PATH = HERE.parent / "backend" / "rubrics" / "biology_genetics_v1.json"

EXAM = "NEET-A Mock-07"
EXAM_DATE = "14/11/26"

# --------------------------------------------------------------------------- #
# Page geometry (1700 x 2200 px = US Letter at 200 dpi)
# --------------------------------------------------------------------------- #
W, H = 1700, 2200
MARGIN_X = 150          # red margin line
LABEL_X = 34            # "Q1." written inside the margin
TEXT_X = 178            # answers start right of the margin
RIGHT_X = 1625          # right edge for wrapped text
FIRST_RULE_Y = 290      # first ruled line
LINE_SPACING = 55       # ruled line spacing
LAST_RULE_Y = 2150
N_LINES = (LAST_RULE_Y - FIRST_RULE_Y) // LINE_SPACING + 1
WRAP_SLACK = 34         # room for per-word size/spacing jitter


def rule_y(i: int) -> int:
    return FIRST_RULE_Y + i * LINE_SPACING


# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #
HANDWRITING_FALLBACKS = ["Inkfree.ttf", "segoepr.ttf", "segoesc.ttf", "LHANDW.TTF", "comic.ttf"]
PRINT_BOLD = ["arialbd.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf", "Arial Bold.ttf"]
PRINT_REGULAR = ["arial.ttf", "segoeui.ttf", "DejaVuSans.ttf", "Arial.ttf"]


def _font_dirs() -> list[Path]:
    dirs = [Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"]
    dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
             Path("/Library/Fonts"), Path("/System/Library/Fonts")]
    return [d for d in dirs if d.is_dir()]


@lru_cache(maxsize=None)
def find_font(*names: str) -> str | None:
    """First existing font file among `names` (case-insensitive), or None."""
    wanted = [n.lower() for n in names]
    for name in wanted:
        for d in _font_dirs():
            direct = d / name
            if direct.exists():
                return str(direct)
            for p in d.rglob("*"):
                if p.name.lower() == name:
                    return str(p)
    return None


@lru_cache(maxsize=None)
def load_font(path: str | None, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if path:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


# --------------------------------------------------------------------------- #
# Answer content model
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Punnett:
    """Small hand-drawn Punnett square, floated at the right of the following text lines."""

    cols: tuple[str, ...]           # gametes across the top
    rows: tuple[str, ...]           # gametes down the side
    cells: tuple[tuple[str, ...], ...]
    cell_w: int = 128


Item = str | Punnett


@dataclass
class Sheet:
    filename: str
    student: str
    roll_no: str
    font_files: tuple[str, ...]
    font_size: int
    ink: tuple[int, int, int]
    seed: int
    answers: dict[int, list[Item]]
    pages: int = 1                  # exact page count expected (handwriting shrinks to fit)
    page_break_before: frozenset[int] = frozenset()
    effect: str = "clean"           # clean | blurry | photo
    stroke: int = 0                 # extra pen thickness (px) for thin fonts


@dataclass
class Word:
    segments: list[tuple[str, str]]  # (text, "n" | "sup" | "sub")
    struck: bool = False


_SEG_RE = re.compile(r"\^\{([^}]*)\}|_\{([^}]*)\}|([^\^_]+|[\^_])")


def parse_word(raw: str) -> Word:
    struck = len(raw) > 4 and raw.startswith("~~") and raw.endswith("~~")
    if struck:
        raw = raw[2:-2]
    segs: list[tuple[str, str]] = []
    for m in _SEG_RE.finditer(raw):
        if m.group(1) is not None:
            segs.append((m.group(1), "sup"))
        elif m.group(2) is not None:
            segs.append((m.group(2), "sub"))
        else:
            segs.append((m.group(3), "n"))
    return Word(segs, struck)


# --------------------------------------------------------------------------- #
# Handwriting renderer
# --------------------------------------------------------------------------- #
class Hand:
    def __init__(self, sheet: Sheet, size: int, rng: random.Random):
        self.font_path = find_font(*sheet.font_files, *HANDWRITING_FALLBACKS)
        self.size = size
        self.ink = sheet.ink
        self.stroke = sheet.stroke
        self.rng = rng

    def font(self, size: int):
        return load_font(self.font_path, max(8, int(size)))

    def word_width(self, word: Word, size: int | None = None) -> float:
        size = size or self.size
        total = 0.0
        for text, kind in word.segments:
            f = self.font(size if kind == "n" else size * 0.62)
            total += f.getlength(text)
        return total

    def space(self, size: int | None = None) -> float:
        return self.font(size or self.size).getlength(" ") * 1.15

    def line_colour(self) -> tuple[int, int, int]:
        r, g, b = self.ink
        j = lambda v: max(0, min(255, v + self.rng.randint(-14, 14)))  # noqa: E731
        return j(r), j(g), j(b)

    def draw_word(self, draw: ImageDraw.ImageDraw, x: float, baseline: float, word: Word,
                  colour: tuple[int, int, int, int], size: int) -> float:
        start = x
        for text, kind in word.segments:
            if kind == "n":
                f, y = self.font(size), baseline
            elif kind == "sup":
                f, y = self.font(size * 0.62), baseline - size * 0.42
            else:
                f, y = self.font(size * 0.62), baseline + size * 0.16
            draw.text((x, y), text, font=f, fill=colour, anchor="ls",
                      stroke_width=self.stroke, stroke_fill=colour)
            x += f.getlength(text)
        if word.struck:
            mid = baseline - size * 0.30
            for k in range(2):
                tilt = self.rng.uniform(-6, 6)
                off = (k - 0.5) * size * 0.16
                draw.line([(start - 5, mid + off + tilt), (x + 5, mid + off - tilt)],
                          fill=colour, width=max(2, size // 13))
        return x - start

    def draw_centered(self, draw: ImageDraw.ImageDraw, cx: float, baseline: float, text: str) -> None:
        word = parse_word(text)
        w = self.word_width(word)
        c = self.line_colour()
        self.draw_word(draw, cx - w / 2, baseline, word, (*c, 240), self.size)

    def render_line(self, ink: Image.Image, words: list[Word], x: float, baseline: float,
                    size: int | None = None) -> None:
        """Render one line of words onto `ink` with slight rotation/jitter."""
        size = size or self.size
        rng = self.rng
        pad = 24
        est = sum(self.word_width(w, size + 1) for w in words) + self.space(size) * 1.3 * len(words)
        canvas = Image.new("RGBA", (int(est + 2 * pad + 40), int(size * 3)), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        base_local = int(size * 1.9)
        cx = float(pad)
        colour = self.line_colour()
        for w in words:
            wsize = size + rng.choice((-1, 0, 0, 1))
            alpha = rng.randint(222, 250)
            cx += self.draw_word(draw, cx, base_local + rng.uniform(-1.6, 1.6), w, (*colour, alpha), wsize)
            cx += self.space(size) * rng.uniform(0.85, 1.2)
        canvas = canvas.rotate(rng.uniform(-0.45, 0.45), resample=Image.Resampling.BICUBIC,
                               center=(pad, base_local))
        ox = max(0, int(x - pad + rng.uniform(-3, 3)))
        oy = max(0, int(baseline - base_local + rng.uniform(-2.5, 2.5)))
        ink.alpha_composite(canvas, (ox, oy))

    def text_at(self, ink: Image.Image, text: str, x: float, baseline: float, size: int | None = None) -> None:
        self.render_line(ink, [parse_word(t) for t in text.split(" ") if t], x, baseline, size)


def wobbly_line(draw: ImageDraw.ImageDraw, p0, p1, rng: random.Random, colour, width=3) -> None:
    (x0, y0), (x1, y1) = p0, p1
    length = math.hypot(x1 - x0, y1 - y0)
    steps = max(2, int(length / 40))
    nx, ny = (-(y1 - y0) / length, (x1 - x0) / length) if length else (0, 0)
    pts = []
    for i in range(steps + 1):
        t = i / steps
        d = rng.uniform(-1.6, 1.6) if 0 < i < steps else 0
        pts.append((x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d))
    draw.line(pts, fill=colour, width=width, joint="curve")


# --------------------------------------------------------------------------- #
# Layout
# --------------------------------------------------------------------------- #
@dataclass
class Op:
    kind: str                       # label | text | punnett
    line: int
    payload: object
    x: float = TEXT_X


class Overflow(Exception):
    pass


def place_question(q: int, items: list[Item], hand: Hand, line: int) -> tuple[list[Op], int]:
    """Lay out one answer starting at `line`; returns its ops and the first line after it."""
    ops = [Op("label", line, f"Q{q}.", LABEL_X)]
    floats: list[tuple[int, int, float]] = []   # (start_line, end_line, x_left)

    def right_edge(i: int) -> float:
        return min([RIGHT_X] + [x_left - 34 for start, end, x_left in floats if start <= i < end])

    for item in items:
        if isinstance(item, Punnett):
            x_left = RIGHT_X - (len(item.cols) + 1) * item.cell_w
            floats.append((line, line + len(item.rows) + 1, x_left))
            ops.append(Op("punnett", line, item, x_left))
            continue
        # Split on plain spaces only: a non-breaking space keeps words together.
        words = [parse_word(w) for w in item.split(" ") if w]
        i = 0
        while i < len(words):
            limit = right_edge(line) - TEXT_X - WRAP_SLACK
            j, width = i, 0.0
            while j < len(words):
                add = hand.word_width(words[j]) + (hand.space() if j > i else 0)
                if j > i and width + add > limit:
                    break
                width += add
                j += 1
            ops.append(Op("text", line, words[i:j]))
            line += 1
            i = j
    return ops, max([line] + [end for _, end, _ in floats])


def layout(sheet: Sheet, hand: Hand) -> list[list[Op]]:
    """Flow answers onto ruled pages; an answer is never split across pages."""
    pages: list[list[Op]] = [[]]
    line = 0
    for q in sorted(sheet.answers):
        ops, end = place_question(q, sheet.answers[q], hand, line)
        if pages[-1] and (q in sheet.page_break_before or end > N_LINES):
            pages.append([])
            ops, end = place_question(q, sheet.answers[q], hand, 0)
        if end > N_LINES:
            raise Overflow(f"{sheet.filename}: Q{q} alone is taller than a page at size {hand.size}")
        pages[-1].extend(ops)
        line = end + 1                     # one blank line between answers
    if len(pages) > sheet.pages:
        raise Overflow(f"{sheet.filename}: needs {len(pages)} pages at size {hand.size}")
    if len(pages) < sheet.pages:
        raise ValueError(f"{sheet.filename}: only {len(pages)} page(s); add content or a page break")
    return pages


# --------------------------------------------------------------------------- #
# Page rendering
# --------------------------------------------------------------------------- #
def make_paper(rng: random.Random) -> Image.Image:
    # Low-frequency mottling (compresses well, looks like paper tone).
    small = Image.effect_noise((W // 12, H // 12), 22).resize((W, H), Image.Resampling.BICUBIC)
    chans = [small.point(lambda v, base=base: max(0, min(255, int(base + (v - 128) * 0.05))))
             for base in (251, 249, 242)]
    paper = Image.merge("RGB", chans)
    d = ImageDraw.Draw(paper)
    for i in range(N_LINES):
        y = rule_y(i)
        d.line([(0, y), (W, y)], fill=(158, 189, 226), width=2)
    d.line([(MARGIN_X, 0), (MARGIN_X, H)], fill=(222, 96, 96), width=3)
    d.line([(MARGIN_X + 6, 0), (MARGIN_X + 6, H)], fill=(232, 150, 150), width=1)
    return paper


def draw_header(paper: Image.Image, ink: Image.Image, hand: Hand, sheet: Sheet, rubric: dict,
                page_no: int, total_pages: int) -> None:
    d = ImageDraw.Draw(paper)
    bold = load_font(find_font(*PRINT_BOLD), 34)
    reg = load_font(find_font(*PRINT_REGULAR), 30)
    small = load_font(find_font(*PRINT_REGULAR), 26)
    grey = (48, 50, 60)
    line_c = (90, 92, 104)

    d.text((TEXT_X, 70), "ANSWER SHEET", font=bold, fill=grey, anchor="ls")
    d.text((W - 70, 70), f"Page {page_no} of {total_pages}", font=small, fill=grey, anchor="rs")

    # Row 1: exam | subject | Name: ______
    y1 = 140
    prefix = f"{EXAM}   |   {rubric['name']}   |   Name:"
    d.text((TEXT_X, y1), prefix, font=reg, fill=grey, anchor="ls")
    name_x = TEXT_X + reg.getlength(prefix) + 16
    d.line([(name_x, y1 + 8), (W - 70, y1 + 8)], fill=line_c, width=2)

    # Row 2: Roll No | Date | Max. Marks
    y2 = 205
    d.text((TEXT_X, y2), "Roll No:", font=reg, fill=grey, anchor="ls")
    roll_x = TEXT_X + reg.getlength("Roll No:") + 16
    d.line([(roll_x, y2 + 8), (roll_x + 300, y2 + 8)], fill=line_c, width=2)
    date_label_x = roll_x + 360
    d.text((date_label_x, y2), "Date:", font=reg, fill=grey, anchor="ls")
    date_x = date_label_x + reg.getlength("Date:") + 16
    d.line([(date_x, y2 + 8), (date_x + 240, y2 + 8)], fill=line_c, width=2)
    total = sum(q["max_marks"] for q in rubric["questions"])
    d.text((W - 70, y2), f"Max. Marks: {total}", font=reg, fill=grey, anchor="rs")
    d.line([(40, 232), (W - 40, 232)], fill=line_c, width=3)

    # Handwritten fields.
    hand.text_at(ink, sheet.student, name_x + 14, y1 - 2, size=hand.size + 4)
    hand.text_at(ink, sheet.roll_no, roll_x + 14, y2 - 2)
    hand.text_at(ink, EXAM_DATE, date_x + 14, y2 - 2)


def draw_punnett(ink: Image.Image, hand: Hand, p: Punnett, x_left: float, line: int) -> None:
    d = ImageDraw.Draw(ink)
    rng = hand.rng
    colour = (*hand.line_colour(), 235)
    n_rows, n_cols = len(p.rows) + 1, len(p.cols) + 1
    top = rule_y(line - 1) + 5
    bottom = rule_y(line - 1 + n_rows) + 5
    right = x_left + n_cols * p.cell_w
    for r in range(n_rows + 1):
        y = rule_y(line - 1 + r) + 5
        wobbly_line(d, (x_left, y), (right, y), rng, colour)
    for c in range(n_cols + 1):
        x = x_left + c * p.cell_w
        wobbly_line(d, (x, top), (x, bottom), rng, colour)
    wobbly_line(d, (x_left + 6, top + 6), (x_left + p.cell_w - 6, rule_y(line) - 2), rng, colour, width=2)
    for ci, g in enumerate(p.cols):
        hand.draw_centered(d, x_left + (ci + 1.5) * p.cell_w, rule_y(line) - 12, g)
    for ri, g in enumerate(p.rows):
        base = rule_y(line + ri + 1) - 12
        hand.draw_centered(d, x_left + 0.5 * p.cell_w, base, g)
        for ci, cell in enumerate(p.cells[ri]):
            hand.draw_centered(d, x_left + (ci + 1.5) * p.cell_w, base, cell)


def render_sheet(sheet: Sheet, rubric: dict) -> list[Image.Image]:
    size = sheet.font_size
    while True:
        rng = random.Random(sheet.seed)
        hand = Hand(sheet, size, rng)
        try:
            pages = layout(sheet, hand)
            break
        except Overflow:
            if size <= 28:
                raise
            size -= 2
            print(f"  {sheet.filename}: shrinking handwriting to {size}px to fit {sheet.pages} page(s)")

    images = []
    for page_no, ops in enumerate(pages, start=1):
        paper = make_paper(rng)
        ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw_header(paper, ink, hand, sheet, rubric, page_no, len(pages))
        for op in ops:
            baseline = rule_y(op.line) - 9
            if op.kind == "label":
                hand.text_at(ink, str(op.payload), op.x, baseline)
            elif op.kind == "text":
                hand.render_line(ink, op.payload, op.x + rng.uniform(-2, 4), baseline)  # type: ignore[arg-type]
            elif op.kind == "punnett":
                draw_punnett(ink, hand, op.payload, op.x, op.line)  # type: ignore[arg-type]
        ink = ink.filter(ImageFilter.GaussianBlur(0.55))
        page = paper.convert("RGBA")
        page.alpha_composite(ink)
        images.append(page.convert("RGB"))
    return images


# --------------------------------------------------------------------------- #
# Camera / scanner effects
# --------------------------------------------------------------------------- #
def add_grain(img: Image.Image, sigma: float) -> Image.Image:
    n = Image.effect_noise(img.size, sigma)
    return ImageChops.add(img, Image.merge("RGB", (n, n, n)), scale=1.0, offset=-128)


def _smooth_field(fn, size=(48, 62)) -> Image.Image:
    """Low-res L image from fn(u, v) -> 0..255, upscaled smoothly to page size."""
    sw, sh = size
    im = Image.new("L", size)
    im.putdata([max(0, min(255, int(fn(x / (sw - 1), y / (sh - 1))))) for y in range(sh) for x in range(sw)])
    return im.resize((W, H), Image.Resampling.BICUBIC)


def desk_background(size: tuple[int, int]) -> Image.Image:
    small = Image.effect_noise((size[0] // 20, size[1] // 20), 30).resize(size, Image.Resampling.BICUBIC)
    chans = [small.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * 0.25)))) for b in (96, 80, 66)]
    return Image.merge("RGB", chans)


def photo_effect(img: Image.Image) -> Image.Image:
    """Phone-photo look: paper on a desk, slight perspective + rotation, shadow gradient."""
    border = 130
    cw, ch = W + 2 * border, H + 2 * border
    canvas = desk_background((cw, ch))
    shadow = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(shadow).rectangle([border + 14, border + 22, border + W + 14, border + H + 22], fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas = Image.composite(Image.new("RGB", (cw, ch), (30, 24, 20)), canvas, shadow)
    canvas.paste(img, (border, border))
    # Source quad (UL, LL, LR, UR) -> output rectangle: a mild keystone.
    quad = (70, 40, 20, ch - 60, cw - 40, ch - 30, cw - 105, 85)
    out = canvas.transform((W, H), Image.Transform.QUAD, quad, resample=Image.Resampling.BICUBIC)
    out = out.rotate(-1.3, resample=Image.Resampling.BICUBIC, fillcolor=(88, 74, 62))

    def light(u: float, v: float) -> float:
        base = 0.50 + 0.50 * min(1.0, 0.20 + 0.65 * u + 0.45 * v)       # darker towards top-left
        blob = 0.30 * math.exp(-(((u - 0.05) / 0.35) ** 2 + ((v - 0.92) / 0.25) ** 2))  # hand shadow
        return 255 * max(0.0, base - blob)

    lum = _smooth_field(light)
    tint = Image.merge("RGB", (lum, lum.point(lambda v: int(v * 0.965)), lum.point(lambda v: int(v * 0.90))))
    out = ImageChops.multiply(out, tint)
    out = ImageEnhance.Contrast(out).enhance(1.08)
    out = out.filter(ImageFilter.GaussianBlur(0.7))
    return add_grain(out, 7)


def blurry_effect(img: Image.Image) -> Image.Image:
    """Badly focused, washed-out photo: should trip the low-confidence human-review path."""
    out = img.rotate(2.6, resample=Image.Resampling.BICUBIC, fillcolor=(120, 112, 100))
    out = out.filter(ImageFilter.GaussianBlur(4.6))
    out = ImageEnhance.Contrast(out).enhance(0.52)
    out = ImageEnhance.Brightness(out).enhance(0.98)
    fog = _smooth_field(lambda u, v: 255 * (0.74 + 0.22 * u + 0.04 * v))
    out = ImageChops.multiply(out, Image.merge("RGB", (fog, fog, fog)))
    return add_grain(out, 9)


# --------------------------------------------------------------------------- #
# Student answers (written against the Biology - Genetics rubric)
# --------------------------------------------------------------------------- #
DARK_BLUE = (22, 38, 118)
BLUE_BLACK = (28, 32, 62)
BLACK = (30, 30, 36)
ROYAL_BLUE = (30, 52, 150)

Q1_PUNNETT = Punnett(cols=("T", "t"), rows=("t",), cells=(("Tt", "tt"),), cell_w=120)
Q4_PUNNETT = Punnett(cols=("X^{c}", "Y"), rows=("X", "X^{c}"),
                     cells=(("XX^{c}", "XY"), ("X^{c}X^{c}", "X^{c}Y")), cell_w=132)

SHEETS: list[Sheet] = [
    # Strong student: everything right except DNA polymerase direction (3'->5') in Q3.
    Sheet(
        filename="answer_sheet_aarav_sharma.png",
        student="Aarav Sharma",
        roll_no="NA07-014",
        font_files=("segoepr.ttf",),
        font_size=36,
        ink=DARK_BLUE,
        seed=7,
        answers={
            1: [
                "Tt (heterozygous tall) x tt (dwarf)",
                Q1_PUNNETT,
                "Gametes: T, t and t",
                "Genotypic ratio = 1 Tt : 1 tt",
                "Phenotypic ratio = 1 Tall : 1 Dwarf",
                "This is a test cross - it tells whether the tall parent is TT or Tt.",
            ],
            2: [
                "Incomplete dominance: neither allele is fully dominant, so the heterozygote "
                "shows an intermediate phenotype. Eg. snapdragon - red (RR) x white (rr) gives "
                "pink (Rr); F2 ratio 1 : 2 : 1.",
                "Codominance: both alleles are expressed fully and together in the heterozygote. "
                "Eg. ABO blood group - I^{A}I^{B} gives blood group AB.",
            ],
            3: [
                "Each daughter DNA has one ~~new~~ old (parental) strand and one newly made strand.",
                "Proved by Meselson and Stahl (1958): E. coli grown in ^{15}N medium, then shifted "
                "to ^{14}N; DNA separated by CsCl density gradient centrifugation. Gen\u00a01 - all "
                "hybrid ^{15}N/^{14}N DNA; Gen 2 - half hybrid, half light DNA.",
                "DNA polymerase works in 3'->5' direction; leading strand is continuous, lagging "
                "strand forms Okazaki fragments joined by ligase.",
            ],
            4: [
                "Man = X^{c}Y. Woman is a carrier XX^{c} (got X^{c} from her father).",
                Q4_PUNNETT,
                "Cross: X^{c}Y x XX^{c}",
                "Daughters: XX^{c} carrier, X^{c}X^{c} colour blind -> 50% colour blind",
                "Sons: XY normal, X^{c}Y colour blind -> 50% sons colour blind",
            ],
            5: [
                "Chromosomal disorder (aneuploidy) due to trisomy 21 - an extra copy of "
                "chromosome 21, so 47 chromosomes (2n+1).",
                "Cause: non-disjunction of chromosome 21 during meiosis (gamete formation).",
                "Symptoms: short stature, small round head, furrowed tongue, broad palm with "
                "palm crease, mental retardation.",
            ],
        },
    ),
    # Mid-level student over two pages: Q3 weak (wrong experiment), Q4 daughters wrong,
    # Q5 lists symptoms but never states the cause.
    Sheet(
        filename="answer_sheet_priya_nair.pdf",
        student="Priya Nair",
        roll_no="NA07-027",
        font_files=("BRADHITC.TTF", "Inkfree.ttf"),
        font_size=44,
        stroke=1,
        ink=BLUE_BLACK,
        seed=21,
        pages=2,
        answers={
            1: [
                "Tt  x  tt",
                "(tall)  (dwarf)",
                Q1_PUNNETT,
                "Gametes - T, t and t",
                "Offsprings - Tt (tall) and tt (dwarf)",
                "Genotypic ratio = 1 : 1 and phenotypic ratio = 1 tall : 1 dwarf",
                "This type of cross is called ~~test~~ back cross.",
            ],
            2: [
                "Incomplete dominance - the F1 hybrid shows a character in between both parents. "
                "Eg. Mirabilis jalapa (4 o'clock plant): red x white flowers gives pink flowers.",
                "F2 ratio is 1 : 2 : 1 (red : pink : white).",
                "Codominance - both alleles are dominant and the F1 looks like both the parents. "
                "Eg. roan coat colour in cattle.",
            ],
            3: [
                "In semi-conservative replication half of the DNA is old and half of the DNA is new.",
                "Replication starts at the origin of replication where a replication fork is formed.",
                "The DNA unwinds with the help of helicase and new strands are formed on it.",
                "It was proved by ~~Griffith~~ Hershey and Chase experiment using bacteriophage.",
            ],
            4: [
                "Colour blind man = X^{c}Y",
                "Woman has normal vision but her father was colour blind, so she is a carrier = XX^{c}",
                Q4_PUNNETT,
                "Sons - 50% colour blind (X^{c}Y) and 50% normal (XY)",
                "Daughters - all daughters have normal vision, 50% of them are carriers.",
            ],
            5: [
                "Down's syndrome is a chromosomal disorder. It was first described by Langdon Down (1866) "
                "and is also called mongolism.",
                "Symptoms - 1) short stature with small round head",
                "2) furrowed tongue and partially open mouth",
                "3) broad palm with a characteristic palm crease",
                "4) ~~physical~~ mental retardation and delayed development",
                "The child needs special care and therapy from an early age.",
            ],
        },
    ),
    # Decent answers, but the photo is unreadable on purpose (filename contains "blurry").
    Sheet(
        filename="answer_sheet_rohan_blurry.jpg",
        student="Rohan Verma",
        roll_no="NA07-033",
        font_files=("segoesc.ttf",),
        font_size=34,
        ink=BLACK,
        seed=33,
        effect="blurry",
        answers={
            1: [
                "Tt x tt gives Tt and tt.",
                "Genotypic ratio 1 : 1, phenotypic ratio 1 tall : 1 dwarf. It is a test cross.",
            ],
            2: [
                "Incomplete dominance - F1 is intermediate, eg. pink flowers in Mirabilis.",
                "Codominance - both alleles are expressed together, eg. ~~O~~ AB blood group.",
            ],
            3: [
                "Each new DNA molecule has one old strand and one new strand. Meselson and Stahl "
                "grew E. coli in ^{15}N then ^{14}N and used CsCl centrifugation.",
            ],
            4: [
                "X^{c}Y x XX^{c} -> 50% sons colour blind, 50% daughters colour blind, rest are carriers.",
            ],
            5: [
                "Trisomy 21 due to non-disjunction. Symptoms - mental retardation, flat face, palm crease.",
            ],
        },
    ),
    # Weaker student: wrong ratio, definitions swapped, Q3 not attempted, Q4 wrong, Q5 partial.
    Sheet(
        filename="answer_sheet_kavya_iyer.jpg",
        student="Kavya Iyer",
        roll_no="NA07-041",
        font_files=("LHANDW.TTF", "Inkfree.ttf"),
        font_size=33,
        ink=ROYAL_BLUE,
        seed=41,
        effect="photo",
        answers={
            1: [
                "Tt x tt",
                "Offsprings = TT, Tt, Tt, tt",
                "Ratio = 3 tall : 1 dwarf",
                "It is a ~~dihybrid~~ monohybrid cross.",
            ],
            2: [
                "Incomplete dominance - one allele is not fully dominant over the other one. "
                "Eg. AB blood group.",
                "Codominance - both alleles mix together and give a new colour. "
                "Eg. pink flower in snapdragon.",
            ],
            4: [
                "Man = XY^{c}     Woman = XX",
                "All the sons will be colour blind and all daughters will be ~~carrier~~ normal.",
            ],
            5: [
                "Down's syndrome is a genetic disease in which the child has one extra chromosome.",
                "Symptoms - mental retardation, flat face.",
            ],
        },
    ),
]


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def save_pdf(pages: list[Image.Image], path: Path) -> None:
    doc = pymupdf.open()
    for img in pages:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88, optimize=True)
        page = doc.new_page(width=612, height=612 * H / W)   # US Letter, matches 1700x2200
        page.insert_image(page.rect, stream=buf.getvalue())
    doc.set_metadata({"title": path.stem, "creator": "3iLens demo sample generator"})
    doc.save(str(path), garbage=3, deflate=True)
    doc.close()


def write_sheet(sheet: Sheet, rubric: dict) -> Path:
    unknown = set(sheet.answers) - {q["question"] for q in rubric["questions"]}
    if unknown:
        raise ValueError(f"{sheet.filename}: answers for unknown questions {sorted(unknown)}")
    pages = render_sheet(sheet, rubric)
    if sheet.effect == "blurry":
        pages = [blurry_effect(p) for p in pages]
    elif sheet.effect == "photo":
        pages = [photo_effect(p) for p in pages]

    out = HERE / sheet.filename
    suffix = out.suffix.lower()
    if suffix == ".pdf":
        save_pdf(pages, out)
    elif suffix == ".png":
        pages[0].save(out, "PNG", optimize=True)
    else:
        pages[0].save(out, "JPEG", quality=72 if sheet.effect == "blurry" else 86, optimize=True)
    return out


def verify(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        with pymupdf.open(str(path)) as doc:
            pages = doc.page_count
            pix = doc[0].get_pixmap(dpi=72)
            return f"PDF, {pages} page(s), first page renders {pix.width}x{pix.height}"
    with Image.open(path) as im:
        im.load()
        return f"{im.format} {im.width}x{im.height} {im.mode}"


def main() -> int:
    rubric = json.loads(RUBRIC_PATH.read_text(encoding="utf-8"))
    print(f"Rubric: {rubric['name']} ({len(rubric['questions'])} questions)")
    for sheet in SHEETS:
        path = write_sheet(sheet, rubric)
        print(f"  wrote {path.name:<34} {path.stat().st_size / 1024:8.0f} KB  {verify(path)}")
    custom = HERE / "rubric_physics_kinematics.json"
    if custom.exists():
        data = json.loads(custom.read_text(encoding="utf-8"))
        print(f"  ok    {custom.name:<34} {custom.stat().st_size / 1024:8.1f} KB  "
              f"{len(data['questions'])} questions, {sum(q['max_marks'] for q in data['questions'])} marks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
