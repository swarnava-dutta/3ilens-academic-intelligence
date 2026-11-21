"""Generate the "neat" category of synthetic handwritten NEET answer sheets.

    backend/.venv/Scripts/python.exe test-pages/generators/gen_neat.py

Writes five sheets to test-pages/generated/neat/ (answers to the Biology - Genetics rubric,
backend/rubrics/biology_genetics_v1.json). Every sheet is clean and legible; what varies is
the student (near-perfect -> weak), the handwriting style, ink, paper and resolution:

    01  A4 300 dpi JPEG  2480x3508  Segoe Print, dark-blue ink, ruled exam booklet
    02  A4 200 dpi PNG   1654x2339  Bradley Hand, black ink, 5 mm squared paper
    03  A4 150 dpi PNG   1240x1754  Kristen ITC, blue gel ink, plain white paper
    04  WEBP             1500x2100  MV Boli, black ink, ruled sheet with boxed header, phone photo
    05  3-page PDF  (pages 1654x2339)  Lucida Handwriting, blue-black ink, Q3 split over pages 2->3

Reuses samples/generate_samples.py (font lookup, answer markup parser, Punnett model,
wobbly lines, exam constants) - it is imported, never edited. Handwriting is drawn glyph by
glyph with seeded per-character rotation / size / baseline / spacing jitter, a per-student
slant and per-line drift, then given a ballpoint texture so it does not look typeset.
Answer markup: ~~word~~ crossed out, ^{..} superscript, _{..} subscript (see gs.parse_word).
Deterministic: all randomness (including noise textures) comes from seeded random.Random.
"""
from __future__ import annotations

import io
import json
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, r"H:\3ilens\samples")
import generate_samples as gs  # noqa: E402

import pymupdf  # noqa: E402
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test-pages" / "generated" / "neat"
CATEGORY = "neat"
BICUBIC = Image.Resampling.BICUBIC
A4_W_MM, A4_H_MM = 210.0, 297.0
A4_PT = (595.28, 841.89)


# --------------------------------------------------------------------------- #
# Seeded noise helpers (Image.effect_noise is not seedable)
# --------------------------------------------------------------------------- #
def tri_noise(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """Triangular-distributed noise around 128 (mean of two uniform byte images)."""
    w, h = size
    a = Image.frombytes("L", (w, h), rng.randbytes(w * h))
    b = Image.frombytes("L", (w, h), rng.randbytes(w * h))
    return ImageChops.add(a, b, scale=2.0)


def low_freq(size: tuple[int, int], rng: random.Random, cell: int) -> Image.Image:
    w, h = size
    small = tri_noise((max(2, w // cell + 2), max(2, h // cell + 2)), rng)
    return small.filter(ImageFilter.GaussianBlur(0.8)).resize((w, h), BICUBIC)


def smooth_field(size: tuple[int, int], fn) -> Image.Image:
    sw, sh = 40, 56
    im = Image.new("L", (sw, sh))
    im.putdata([max(0, min(255, int(fn(x / (sw - 1), y / (sh - 1))))) for y in range(sh) for x in range(sw)])
    return im.resize(size, BICUBIC)


def add_grain(img: Image.Image, rng: random.Random, sigma: float) -> Image.Image:
    k = sigma / 52.0
    n = tri_noise(img.size, rng).point(lambda v: max(0, min(255, int(128 + (v - 128) * k))))
    return ImageChops.add(img, Image.merge("RGB", (n, n, n)), scale=1.0, offset=-128)


def paste_rgba(dst: Image.Image, src: Image.Image, x: int, y: int) -> None:
    """alpha_composite that tolerates negative / out-of-bounds offsets."""
    if x < 0:
        src = src.crop((-x, 0, src.width, src.height))
        x = 0
    if y < 0:
        src = src.crop((0, -y, src.width, src.height))
        y = 0
    w, h = min(src.width, dst.width - x), min(src.height, dst.height - y)
    if w <= 0 or h <= 0:
        return
    if (w, h) != src.size:
        src = src.crop((0, 0, w, h))
    dst.alpha_composite(src, (x, y))


# --------------------------------------------------------------------------- #
# Sheet description
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Tubes:
    """Hand-drawn Meselson-Stahl centrifuge tubes, floated at the right of the next lines."""

    labels: tuple[str, ...]
    bands: tuple[tuple[float, ...], ...]   # band positions per tube, 0 = top, 1 = bottom
    rows: int = 5                           # ruled lines it occupies (incl. label line)


Item = str | gs.Punnett | Tubes


@dataclass
class Spec:
    nn: int
    slug: str
    ext: str                          # jpg | png | webp | pdf
    width: int                        # rendered A4 page width in px (height follows A4)
    student: str
    roll: str
    font: str
    em_mm: float                      # handwriting font size
    pitch_mm: float                   # line spacing
    ink: tuple[int, int, int]
    paper: str                        # ruled | graph | plain
    header: str                       # booklet | boxes | handwritten
    label_fmt: str                    # e.g. "Q{}."
    label_pos: str                    # margin | inline
    seed: int
    answers: dict[int, list[Item]]
    pages: int = 1
    hanging: bool = False             # inline labels: continuation lines indented under text
    effect: str = "scan"              # scan | clean | photo
    out_size: tuple[int, int] | None = None
    stroke_mm: float = 0.0
    slant_deg: float = 0.0
    per_char: bool = True
    rot_char: float = 1.4             # sd of per-glyph rotation (deg)
    dy_char: float = 0.025            # per-glyph baseline jitter (fraction of em)
    ds_char: float = 0.035            # per-glyph size jitter
    sp_char: float = 0.03             # per-glyph advance jitter
    word_dy: float = 0.025
    word_rot: float = 0.6             # sd of per-word baseline tilt (deg)
    line_rot: float = 0.30            # max random line rotation (deg)
    line_tilt: float = 0.0            # systematic uphill/downhill (deg)
    space: float = 1.12
    paper_tone: tuple[int, int, int] = (251, 250, 246)
    mottle: float = 0.07              # paper tone unevenness
    hand_header: tuple[str, ...] = ()
    page_break_before: frozenset[int] = frozenset()
    jpeg_quality: int = 90

    @property
    def filename(self) -> str:
        return f"answer_sheet_{CATEGORY}_{self.nn:02d}_{self.slug}.{self.ext}"


# --------------------------------------------------------------------------- #
# Page geometry
# --------------------------------------------------------------------------- #
class Geo:
    def __init__(self, spec: Spec, rng: random.Random):
        self.w = spec.width
        self.h = round(A4_H_MM / 25.4 * round(spec.width * 25.4 / A4_W_MM))   # 2480->3508, 1654->2339, 1240->1754
        self.mm = self.w / A4_W_MM
        mm = self.mm
        self.paper = spec.paper
        self.pitch = spec.pitch_mm * mm
        bottom = 287 * mm
        if spec.paper == "graph":
            self.grid = 5 * mm
            self.first = {0: 3 * self.grid}           # baselines on every 2nd grid line
            bottom = 291 * mm
            self.text_x = 3 * self.grid
            self.label_x = self.text_x
            self.right_x = self.w - 2.4 * self.grid
            self.margin_x = None
        elif spec.paper == "plain":
            self.first = {0: 21 * mm}
            self.text_x = 17 * mm
            self.label_x = self.text_x
            self.right_x = self.w - 15 * mm
            self.margin_x = None
            bottom = 284 * mm
        else:                                           # ruled with red margin
            self.first = {0: (52 if spec.header == "boxes" else 43) * mm}
            self.margin_x = 22 * mm
            self.label_x = 4.5 * mm
            self.text_x = 25 * mm
            self.right_x = self.w - 9 * mm
        self.cont_first = 33 * mm if spec.paper == "ruled" else self.first[0]
        self.bottom = bottom
        # Plain paper: baselines wander (random walk) because nothing guides the pen.
        self.drift: dict[int, list[float]] = {}
        for p in range(spec.pages):
            walk, acc = [], 0.0
            for _ in range(80):
                if spec.paper == "plain":
                    acc = 0.6 * acc + rng.uniform(-0.09, 0.09) * self.pitch
                walk.append(acc)
            self.drift[p] = walk

    def first_rule(self, page: int) -> float:
        return self.first[0] if page == 0 else self.cont_first

    def n_lines(self, page: int) -> int:
        return int((self.bottom - self.first_rule(page)) // self.pitch) + 1

    def rule_y(self, page: int, i: int) -> float:
        d = self.drift[page][i] if 0 <= i < len(self.drift[page]) else 0.0
        return self.first_rule(page) + i * self.pitch + d

    def baseline(self, page: int, i: int) -> float:
        off = 0.0 if self.paper == "plain" else 0.13 * self.pitch
        return self.rule_y(page, i) - off


# --------------------------------------------------------------------------- #
# Handwriting
# --------------------------------------------------------------------------- #
class Hand:
    def __init__(self, spec: Spec, mm: float, rng: random.Random, em_mm: float):
        self.spec = spec
        self.mm = mm
        self.path = gs.find_font(spec.font, *gs.HANDWRITING_FALLBACKS)
        self.size = em_mm * mm
        self.stroke = max(0, round(spec.stroke_mm * mm))
        self.rng = rng

    def font(self, size: float):
        return gs.load_font(self.path, max(8, int(round(size))))

    @staticmethod
    def seg(kind: str, size: float, base: float) -> tuple[float, float]:
        if kind == "sup":
            return size * 0.62, base - size * 0.42
        if kind == "sub":
            return size * 0.62, base + size * 0.16
        return size, base

    def word_width(self, word: gs.Word, size: float | None = None) -> float:
        size = size or self.size
        return sum(self.font(self.seg(k, size, 0)[0]).getlength(t.replace("\u00a0", " "))
                   for t, k in word.segments)

    def space(self, size: float | None = None) -> float:
        return self.font(size or self.size).getlength(" ") * self.spec.space

    def colour(self) -> tuple[int, int, int]:
        return tuple(max(0, min(255, c + self.rng.randint(-10, 10))) for c in self.spec.ink)  # type: ignore[return-value]

    def glyph(self, canvas: Image.Image, x: float, y: float, ch: str, fs: float, rgba, tilt: float = 0.0) -> None:
        s, rng = self.spec, self.rng
        size = fs * (1 + rng.uniform(-s.ds_char, s.ds_char))
        f = self.font(size)
        dy = rng.uniform(-1, 1) * s.dy_char * fs
        ang = rng.gauss(0, s.rot_char) + tilt
        col = (*rgba[:3], max(150, min(255, rgba[3] + rng.randint(-12, 5))))
        if abs(ang) < 0.25:
            ImageDraw.Draw(canvas).text((x, y + dy), ch, font=f, fill=col, anchor="ls",
                                        stroke_width=self.stroke, stroke_fill=col)
            return
        m = int(size * 1.5) + 6
        g = Image.new("RGBA", (2 * m, 2 * m), (0, 0, 0, 0))
        ImageDraw.Draw(g).text((m, m), ch, font=f, fill=col, anchor="ls",
                               stroke_width=self.stroke, stroke_fill=col)
        g = g.rotate(ang, resample=BICUBIC, center=(m + f.getlength(ch) / 2, m - size * 0.3))
        paste_rgba(canvas, g, int(round(x - m)), int(round(y + dy - m)))

    def draw_word(self, canvas: Image.Image, x: float, base: float, word: gs.Word, rgba, size: float,
                  tilt: float = 0.0) -> float:
        """Draw one word with its baseline tilted by `tilt` degrees (rising to the right)."""
        s, rng = self.spec, self.rng
        if tilt and not s.per_char:          # whole-word rendering: rotate the word as a unit
            pad = int(size) + 8
            bl = int(size * 1.9)
            tmp = Image.new("RGBA", (int(self.word_width(word, size) + 2 * pad + size), int(size * 3)), (0, 0, 0, 0))
            width = self.draw_word(tmp, pad, bl, word, rgba, size)
            tmp = tmp.rotate(tilt, resample=BICUBIC, center=(pad, bl))
            paste_rgba(canvas, tmp, int(round(x - pad)), int(round(base - bl)))
            return width
        slope = math.tan(math.radians(tilt))
        start = x
        for text, kind in word.segments:
            text = text.replace("\u00a0", " ")
            fs, y = self.seg(kind, size, base)
            f = self.font(fs)
            if not s.per_char:
                ImageDraw.Draw(canvas).text((x, y), text, font=f, fill=rgba, anchor="ls",
                                            stroke_width=self.stroke, stroke_fill=rgba)
                x += f.getlength(text)
                continue
            prev = 0.0
            for i, ch in enumerate(text):
                nxt = f.getlength(text[: i + 1])
                adv, prev = nxt - prev, nxt
                if not ch.isspace():
                    self.glyph(canvas, x, y - (x - start) * slope, ch, fs, rgba, tilt)
                x += adv * (1 + rng.uniform(-s.sp_char, s.sp_char))
        if word.struck:
            d = ImageDraw.Draw(canvas)
            mid = base - size * 0.30
            for k in range(2):
                tilt = rng.uniform(-0.08, 0.08) * size
                off = (k - 0.5) * size * 0.16
                d.line([(start - 0.06 * size, mid + off + tilt), (x + 0.06 * size, mid + off - tilt)],
                       fill=rgba, width=max(2, int(size / 13)))
        return x - start

    def draw_centered(self, ink: Image.Image, cx: float, baseline: float, text: str, size: float | None = None) -> None:
        size = size or self.size
        word = gs.parse_word(text)
        w = self.word_width(word, size)
        self.draw_word(ink, cx - w / 2, baseline, word, (*self.colour(), 238), size)

    def render_line(self, ink: Image.Image, words: list[gs.Word], x: float, baseline: float,
                    size: float | None = None) -> None:
        s, rng = self.spec, self.rng
        size = size or self.size
        pad = int(size * 1.1) + 12
        est = sum(self.word_width(w, size * 1.06) for w in words) + self.space(size) * 1.3 * len(words)
        base_local = int(size * 1.9)
        canvas = Image.new("RGBA", (int(est + 2 * pad), int(size * 3.0)), (0, 0, 0, 0))
        cx = float(pad)
        colour = self.colour()
        for w in words:
            wsize = size * (1 + rng.uniform(-0.025, 0.025))
            dy = rng.uniform(-1, 1) * s.word_dy * size
            cx += self.draw_word(canvas, cx, base_local + dy, w, (*colour, rng.randint(228, 250)), wsize,
                                 rng.gauss(0, s.word_rot))
            cx += self.space(size) * rng.uniform(0.85, 1.2)
        if s.slant_deg:
            t = math.tan(math.radians(s.slant_deg))
            canvas = canvas.transform(canvas.size, Image.Transform.AFFINE, (1, t, -t * base_local, 0, 1, 0),
                                      resample=BICUBIC)
        ang = rng.uniform(-s.line_rot, s.line_rot) + s.line_tilt
        canvas = canvas.rotate(ang, resample=BICUBIC, center=(pad, base_local))
        paste_rgba(ink, canvas, int(x - pad + rng.uniform(-0.4, 0.4) * self.mm), int(baseline - base_local))

    def text_at(self, ink: Image.Image, text: str, x: float, baseline: float, size: float | None = None) -> None:
        self.render_line(ink, [gs.parse_word(t) for t in text.split(" ") if t], x, baseline, size)


def wobbly(draw: ImageDraw.ImageDraw, p0, p1, rng: random.Random, colour, width: int, amp: float) -> None:
    (x0, y0), (x1, y1) = p0, p1
    length = math.hypot(x1 - x0, y1 - y0)
    steps = max(2, int(length / (amp * 25)))
    nx, ny = (-(y1 - y0) / length, (x1 - x0) / length) if length else (0, 0)
    pts = []
    for i in range(steps + 1):
        t = i / steps
        d = rng.uniform(-amp, amp) if 0 < i < steps else 0
        pts.append((x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d))
    draw.line(pts, fill=colour, width=width, joint="curve")


# --------------------------------------------------------------------------- #
# Layout (answers flow across pages; floats never split)
# --------------------------------------------------------------------------- #
@dataclass
class Op:
    kind: str           # label | text | punnett | tubes | underline
    page: int
    line: int
    payload: object
    x: float = 0.0


class Overflow(Exception):
    pass


def punnett_cell(hand: Hand, p: gs.Punnett) -> float:
    texts = [*p.cols, *p.rows, *[c for row in p.cells for c in row]]
    widest = max(hand.word_width(gs.parse_word(t)) for t in texts)
    return max(13 * hand.mm, widest + 0.9 * hand.size)


def float_width(hand: Hand, item) -> float:
    if isinstance(item, gs.Punnett):
        return (len(item.cols) + 1) * punnett_cell(hand, item)
    widest = max(hand.word_width(gs.parse_word(t), hand.size * 0.8) for t in item.labels)
    pitch_x = max(15 * hand.mm, widest + 4 * hand.mm)
    return len(item.labels) * pitch_x


def float_rows(item) -> int:
    return len(item.rows) + 1 if isinstance(item, gs.Punnett) else item.rows


def layout(spec: Spec, hand: Hand, geo: Geo) -> tuple[list[Op], dict[int, set[int]]]:
    ops: list[Op] = []
    spans: dict[int, set[int]] = {}
    floats: list[tuple[int, int, int, float]] = []     # page, start, end, x_left
    page, line = 0, 0
    slack = 0.6 * hand.size

    if spec.hand_header:
        for t in spec.hand_header:
            ops.append(Op("text", 0, line, [gs.parse_word(w) for w in t.split(" ")], geo.text_x))
            line += 1
        ops.append(Op("underline", 0, line - 1, None, geo.text_x))
        line += 1

    def new_page() -> None:
        nonlocal page, line
        page, line = page + 1, 0
        if page >= spec.pages:
            raise Overflow(f"{spec.filename}: needs more than {spec.pages} page(s)")

    def right_edge(i: int) -> float:
        return min([geo.right_x] + [xl - 3.5 * hand.mm for p, a, b, xl in floats if p == page and a <= i < b])

    for q in sorted(spec.answers):
        if q in spec.page_break_before and line > 0:
            new_page()
        if line + 2 > geo.n_lines(page):
            new_page()
        label = spec.label_fmt.format(q)
        if spec.label_pos == "margin":
            ops.append(Op("label", page, line, label, geo.label_x))
            first_x = cont_x = geo.text_x
        else:
            ops.append(Op("label", page, line, label, geo.text_x))
            lw = hand.word_width(gs.parse_word(label)) + hand.space() * 2.2
            first_x = geo.text_x + lw
            cont_x = first_x if spec.hanging else geo.text_x
        spans[q] = {page}
        x0 = first_x
        for item in spec.answers[q]:
            if isinstance(item, (gs.Punnett, Tubes)):
                rows = float_rows(item)
                if line + rows > geo.n_lines(page):
                    new_page()
                    spans[q].add(page)
                xl = geo.right_x - float_width(hand, item)
                floats.append((page, line, line + rows, xl))
                ops.append(Op("punnett" if isinstance(item, gs.Punnett) else "tubes", page, line, item, xl))
                continue
            words = [gs.parse_word(w) for w in item.split(" ")]   # "" tokens keep double spaces
            i = 0
            while i < len(words):
                while i < len(words) and not words[i].segments:
                    i += 1
                if i == len(words):
                    break
                if line >= geo.n_lines(page):
                    new_page()
                    spans[q].add(page)
                limit = right_edge(line) - x0 - slack
                j, width = i, 0.0
                while j < len(words):
                    add = hand.word_width(words[j]) * 1.03 + (hand.space() * 1.03 if j > i else 0)
                    if j > i and width + add > limit:
                        break
                    width += add
                    j += 1
                ops.append(Op("text", page, line, words[i:j], x0))
                line += 1
                i = j
                x0 = cont_x
            x0 = cont_x
        ends = [b for p, a, b, xl in floats if p == page]
        line = max([line] + ends) + 1
    if page + 1 < spec.pages:
        raise ValueError(f"{spec.filename}: only {page + 1} page(s) of content; expected {spec.pages}")
    return ops, spans


# --------------------------------------------------------------------------- #
# Paper and printed headers
# --------------------------------------------------------------------------- #
def make_paper(spec: Spec, geo: Geo, rng: random.Random) -> Image.Image:
    w, h, mm = geo.w, geo.h, geo.mm
    lf = low_freq((w, h), rng, max(6, int(4 * mm)))
    paper = Image.merge("RGB", [lf.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * spec.mottle))))
                                for b in spec.paper_tone])
    d = ImageDraw.Draw(paper)
    if spec.paper == "graph":
        g = geo.grid
        k = 0
        while k * g < w:
            d.line([(k * g, 0), (k * g, h)], fill=(184, 205, 218), width=max(1, round(0.14 * mm)))
            k += 1
        k = 0
        while k * g < h:
            d.line([(0, k * g), (w, k * g)], fill=(184, 205, 218), width=max(1, round(0.14 * mm)))
            k += 1
    return paper


def rule_paper(paper: Image.Image, geo: Geo, page: int) -> None:
    d = ImageDraw.Draw(paper)
    mm = geo.mm
    lw = max(1, round(0.2 * mm))
    for i in range(geo.n_lines(page)):
        y = geo.rule_y(page, i)
        d.line([(0, y), (geo.w, y)], fill=(158, 189, 226), width=lw)
    top = geo.first_rule(page) - geo.pitch
    d.line([(geo.margin_x, top), (geo.margin_x, geo.h)], fill=(222, 96, 96), width=max(2, round(0.3 * mm)))
    d.line([(geo.margin_x + 0.7 * mm, top), (geo.margin_x + 0.7 * mm, geo.h)], fill=(232, 150, 150), width=lw)


def pfont(names, size_px: float):
    return gs.load_font(gs.find_font(*names), max(8, int(size_px)))


def header_booklet(paper, ink, hand: Hand, spec: Spec, geo: Geo, rubric: dict, page_no: int, total: int) -> None:
    d = ImageDraw.Draw(paper)
    mm = geo.mm
    bold, reg, small = pfont(gs.PRINT_BOLD, 4.6 * mm), pfont(gs.PRINT_REGULAR, 3.9 * mm), pfont(gs.PRINT_REGULAR, 3.4 * mm)
    grey, lc = (48, 50, 60), (90, 92, 104)
    L, R = geo.text_x, geo.w - 8 * mm
    lw = max(2, round(0.25 * mm))
    hs = hand.size * 0.95
    if page_no == 1:
        d.text((L, 12 * mm), "ANSWER SHEET", font=bold, fill=grey, anchor="ls")
        d.text((R, 12 * mm), f"Page {page_no} of {total}", font=small, fill=grey, anchor="rs")
        y1 = 21.5 * mm
        prefix = f"{gs.EXAM}   |   {rubric['name']}   |   Name:"
        d.text((L, y1), prefix, font=reg, fill=grey, anchor="ls")
        nx = L + reg.getlength(prefix) + 2 * mm
        d.line([(nx, y1 + 1 * mm), (R, y1 + 1 * mm)], fill=lc, width=lw)
        y2 = 31 * mm
        d.text((L, y2), "Roll No:", font=reg, fill=grey, anchor="ls")
        rx = L + reg.getlength("Roll No:") + 2 * mm
        d.line([(rx, y2 + 1 * mm), (rx + 42 * mm, y2 + 1 * mm)], fill=lc, width=lw)
        dl = rx + 50 * mm
        d.text((dl, y2), "Date:", font=reg, fill=grey, anchor="ls")
        dx = dl + reg.getlength("Date:") + 2 * mm
        d.line([(dx, y2 + 1 * mm), (dx + 30 * mm, y2 + 1 * mm)], fill=lc, width=lw)
        total_marks = sum(q["max_marks"] for q in rubric["questions"])
        d.text((R, y2), f"Max. Marks: {total_marks}", font=reg, fill=grey, anchor="rs")
        d.line([(5 * mm, 35 * mm), (geo.w - 5 * mm, 35 * mm)], fill=lc, width=max(2, round(0.4 * mm)))
        hand.text_at(ink, spec.student, nx + 2 * mm, y1 - 0.3 * mm, size=hs * 1.05)
        hand.text_at(ink, spec.roll, rx + 2 * mm, y2 - 0.3 * mm, size=hs)
        hand.text_at(ink, gs.EXAM_DATE, dx + 2 * mm, y2 - 0.3 * mm, size=hs)
    else:
        d.text((L, 12 * mm), "ANSWER SHEET  (continuation)", font=bold, fill=grey, anchor="ls")
        d.text((R, 12 * mm), f"Page {page_no} of {total}", font=small, fill=grey, anchor="rs")
        y = 21.5 * mm
        d.text((L, y), "Roll No:", font=reg, fill=grey, anchor="ls")
        rx = L + reg.getlength("Roll No:") + 2 * mm
        d.line([(rx, y + 1 * mm), (rx + 42 * mm, y + 1 * mm)], fill=lc, width=lw)
        d.text((R, y), f"{gs.EXAM}  |  {rubric['name']}", font=small, fill=grey, anchor="rs")
        d.line([(5 * mm, 25.5 * mm), (geo.w - 5 * mm, 25.5 * mm)], fill=lc, width=max(2, round(0.4 * mm)))
        hand.text_at(ink, spec.roll, rx + 2 * mm, y - 0.3 * mm, size=hs)


def header_boxes(paper, ink, hand: Hand, spec: Spec, geo: Geo, rubric: dict) -> None:
    d = ImageDraw.Draw(paper)
    mm = geo.mm
    bold, reg = pfont(gs.PRINT_BOLD, 4.4 * mm), pfont(gs.PRINT_REGULAR, 3.6 * mm)
    grey, lc = (40, 44, 60), (70, 74, 92)
    lw = max(2, round(0.3 * mm))
    L, R = 10 * mm, geo.w - 10 * mm
    d.rectangle([L, 7 * mm, R, 42 * mm], outline=lc, width=lw)
    title = f"{gs.EXAM.upper()}   -   {rubric['name'].upper()}"
    d.text((geo.w / 2, 14.5 * mm), title, font=bold, fill=grey, anchor="ms")
    d.line([(L, 17.5 * mm), (R, 17.5 * mm)], fill=lc, width=max(1, round(0.2 * mm)))
    # Row: candidate name in a long box
    y = 27 * mm
    d.text((L + 4 * mm, y), "Candidate's Name:", font=reg, fill=grey, anchor="ls")
    bx = L + 4 * mm + reg.getlength("Candidate's Name:") + 3 * mm
    d.rectangle([bx, y - 6 * mm, R - 4 * mm, y + 2 * mm], outline=lc, width=max(1, round(0.2 * mm)))
    hand.text_at(ink, spec.student, bx + 3 * mm, y + 0.2 * mm, size=hand.size * 0.95)
    # Row: roll number boxes, date, max marks
    y = 38 * mm
    d.text((L + 4 * mm, y), "Roll No.:", font=reg, fill=grey, anchor="ls")
    bx = L + 4 * mm + reg.getlength("Roll No.:") + 3 * mm
    cell = 6.6 * mm
    for k, ch in enumerate(spec.roll):
        x = bx + k * cell
        d.rectangle([x, y - 6 * mm, x + cell, y + 1.6 * mm], outline=lc, width=max(1, round(0.2 * mm)))
        hand.draw_centered(ink, x + cell / 2, y - 0.3 * mm, ch, size=hand.size * 0.85)
    dx = bx + len(spec.roll) * cell + 8 * mm
    d.text((dx, y), "Date:", font=reg, fill=grey, anchor="ls")
    dbx = dx + reg.getlength("Date:") + 2 * mm
    d.rectangle([dbx, y - 6 * mm, dbx + 30 * mm, y + 1.6 * mm], outline=lc, width=max(1, round(0.2 * mm)))
    hand.text_at(ink, gs.EXAM_DATE, dbx + 2 * mm, y - 0.3 * mm, size=hand.size * 0.85)
    total_marks = sum(q["max_marks"] for q in rubric["questions"])
    d.text((R - 4 * mm, y), f"Max. Marks: {total_marks}", font=reg, fill=grey, anchor="rs")


# --------------------------------------------------------------------------- #
# Diagrams
# --------------------------------------------------------------------------- #
def draw_punnett(ink: Image.Image, hand: Hand, geo: Geo, p: gs.Punnett, page: int, x_left: float, line: int) -> None:
    d = ImageDraw.Draw(ink)
    rng = hand.rng
    colour = (*hand.colour(), 235)
    cw = punnett_cell(hand, p)
    n_rows, n_cols = len(p.rows) + 1, len(p.cols) + 1
    ys = [geo.baseline(page, line - 1 + r) + 0.24 * geo.pitch for r in range(n_rows + 1)]
    right = x_left + n_cols * cw
    lw = max(2, round(0.3 * geo.mm))
    amp = 0.18 * geo.mm
    for y in ys:
        wobbly(d, (x_left, y), (right, y), rng, colour, lw, amp)
    for c in range(n_cols + 1):
        x = x_left + c * cw
        wobbly(d, (x, ys[0]), (x, ys[-1]), rng, colour, lw, amp)
    wobbly(d, (x_left + 0.8 * geo.mm, ys[0] + 0.8 * geo.mm), (x_left + cw - 0.8 * geo.mm, ys[1] - 0.8 * geo.mm),
           rng, colour, max(1, lw - 1), amp)
    tb = lambda r: ys[r + 1] - 0.24 * geo.pitch  # noqa: E731  text baseline inside row r
    for ci, g in enumerate(p.cols):
        hand.draw_centered(ink, x_left + (ci + 1.5) * cw, tb(0), g)
    for ri, g in enumerate(p.rows):
        hand.draw_centered(ink, x_left + 0.5 * cw, tb(ri + 1), g)
        for ci, cell in enumerate(p.cells[ri]):
            hand.draw_centered(ink, x_left + (ci + 1.5) * cw, tb(ri + 1), cell)


def draw_tubes(ink: Image.Image, hand: Hand, geo: Geo, t: Tubes, page: int, x_left: float, line: int) -> None:
    d = ImageDraw.Draw(ink)
    rng = hand.rng
    mm = geo.mm
    colour = (*hand.colour(), 235)
    lw = max(2, round(0.3 * mm))
    amp = 0.15 * mm
    slot = float_width(hand, t) / len(t.labels)
    top = geo.baseline(page, line - 1) + 0.48 * geo.pitch
    bottom = geo.baseline(page, line + t.rows - 2) + 0.18 * geo.pitch
    tw = 7.5 * mm
    for k, (label, bands) in enumerate(zip(t.labels, t.bands)):
        cx = x_left + (k + 0.5) * slot
        xl, xr = cx - tw / 2, cx + tw / 2
        r = tw / 2
        wobbly(d, (xl - 0.8 * mm, top), (xr + 0.8 * mm, top), rng, colour, lw, amp)   # rim
        wobbly(d, (xl, top), (xl, bottom - r), rng, colour, lw, amp)
        wobbly(d, (xr, top), (xr, bottom - r), rng, colour, lw, amp)
        arc = [(cx - r * math.cos(a), bottom - r + r * math.sin(a))
               for a in [i * math.pi / 12 for i in range(13)]]
        d.line(arc, fill=colour, width=lw, joint="curve")
        span = bottom - r - top
        for pos in bands:
            y = top + 0.15 * span + pos * 0.8 * span + rng.uniform(-0.3, 0.3) * mm
            d.rounded_rectangle([xl + 1.1 * mm, y - 0.7 * mm, xr - 1.1 * mm, y + 0.7 * mm], radius=0.6 * mm,
                                fill=(*colour[:3], 215))
        hand.draw_centered(ink, cx, geo.baseline(page, line + t.rows - 1) - 0.1 * geo.pitch, label,
                           size=hand.size * 0.8)


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def pen_texture(ink: Image.Image, rng: random.Random, mm: float) -> Image.Image:
    a = ink.getchannel("A")
    lf = low_freq(ink.size, rng, max(2, int(0.9 * mm))).point(lambda v: int(255 * (0.78 + 0.22 * v / 255)))
    ink.putalpha(ImageChops.multiply(a, lf))
    return ink.filter(ImageFilter.GaussianBlur(max(0.35, 0.075 * mm)))


def render(spec: Spec, rubric: dict) -> tuple[list[Image.Image], dict[int, set[int]], float]:
    em = spec.em_mm
    while True:
        geo = Geo(spec, random.Random(spec.seed * 7 + 1))
        rng = random.Random(spec.seed)
        hand = Hand(spec, geo.mm, rng, em)
        try:
            ops, spans = layout(spec, hand, geo)
            break
        except Overflow:
            if em <= spec.em_mm * 0.8:
                raise
            em = round(em - 0.2, 2)
            print(f"  {spec.filename}: shrinking handwriting to {em} mm")

    images = []
    for page in range(spec.pages):
        paper = make_paper(spec, geo, rng)
        if spec.paper == "ruled":
            rule_paper(paper, geo, page)
        ink = Image.new("RGBA", (geo.w, geo.h), (0, 0, 0, 0))
        if spec.header == "booklet":
            header_booklet(paper, ink, hand, spec, geo, rubric, page + 1, spec.pages)
        elif spec.header == "boxes":
            header_boxes(paper, ink, hand, spec, geo, rubric)
        for op in (o for o in ops if o.page == page):
            base = geo.baseline(page, op.line)
            if op.kind == "label":
                hand.text_at(ink, str(op.payload), op.x, base)
            elif op.kind == "text":
                hand.render_line(ink, op.payload, op.x + rng.uniform(-0.3, 0.6) * geo.mm, base)  # type: ignore[arg-type]
            elif op.kind == "underline":
                y = base + 0.42 * geo.pitch
                wobbly(ImageDraw.Draw(ink), (op.x - 1 * geo.mm, y), (geo.right_x - 25 * geo.mm, y + 0.6 * geo.mm),
                       rng, (*hand.colour(), 230), max(2, round(0.28 * geo.mm)), 0.25 * geo.mm)
            elif op.kind == "punnett":
                draw_punnett(ink, hand, geo, op.payload, page, op.x, op.line)  # type: ignore[arg-type]
            elif op.kind == "tubes":
                draw_tubes(ink, hand, geo, op.payload, page, op.x, op.line)  # type: ignore[arg-type]
        bbox = ink.getbbox()
        if bbox and (bbox[2] > geo.w - 3 * geo.mm or bbox[3] > geo.h - 3 * geo.mm):
            raise RuntimeError(f"{spec.filename} p{page + 1}: ink reaches the page edge {bbox}")
        ink = pen_texture(ink, rng, geo.mm)
        out = paper.convert("RGBA")
        out.alpha_composite(ink)
        images.append(out.convert("RGB"))
    return images, spans, em


# --------------------------------------------------------------------------- #
# Capture effects (all mild - this category is about clean, legible pages)
# --------------------------------------------------------------------------- #
def scan_effect(img: Image.Image, rng: random.Random, angle: float, grain: float,
                contrast: float = 1.03, edge_shadow: bool = False) -> Image.Image:
    out = img.rotate(angle, resample=BICUBIC, fillcolor=(243, 243, 241))
    if edge_shadow:   # flatbed lid shadow along the left edge
        w, h = out.size
        f = smooth_field((w, h), lambda u, v: 255 * (0.90 + 0.10 * min(1.0, u * 14)))
        out = ImageChops.multiply(out, Image.merge("RGB", (f, f, f)))
    out = ImageEnhance.Contrast(out).enhance(contrast)
    return add_grain(out, rng, grain) if grain else out


def desk(size: tuple[int, int], rng: random.Random) -> Image.Image:
    lf = low_freq(size, rng, 24)
    streak = low_freq((size[0] // 40 + 2, size[1]), rng, 1).resize(size, BICUBIC)
    base = ImageChops.add(lf, streak, scale=2.0)
    return Image.merge("RGB", [base.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * 0.35))))
                               for b in (132, 104, 78)])


def photo_effect(img: Image.Image, rng: random.Random, out_size: tuple[int, int]) -> Image.Image:
    """Well-lit phone photo of the page lying on a desk: mild keystone, soft light falloff."""
    w, h = img.size
    b = int(0.05 * w)
    cw, ch = w + 2 * b, h + 2 * b
    canvas = desk((cw, ch), rng)
    shadow = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(shadow).rectangle([b + 8, b + 14, b + w + 8, b + h + 14], fill=120)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas = Image.composite(Image.new("RGB", (cw, ch), (40, 30, 22)), canvas, shadow)
    canvas.paste(img, (b, b))
    quad = (b * 0.62, b * 0.45, b * 0.40, ch - b * 0.52, cw - b * 0.45, ch - b * 0.40, cw - b * 0.72, b * 0.62)
    out = canvas.transform(out_size, Image.Transform.QUAD, quad, resample=BICUBIC)
    out = out.rotate(-0.6, resample=BICUBIC, fillcolor=(120, 96, 74))

    def light(u: float, v: float) -> float:
        return 255 * (0.84 + 0.16 * min(1.0, 0.35 + 0.55 * u + 0.25 * (1 - v)))

    lum = smooth_field(out.size, light)
    tint = Image.merge("RGB", (lum, lum.point(lambda v: int(v * 0.975)), lum.point(lambda v: int(v * 0.93))))
    out = ImageChops.multiply(out, tint)
    out = ImageEnhance.Contrast(out).enhance(1.06).filter(ImageFilter.GaussianBlur(0.45))
    return add_grain(out, rng, 4.5)


# --------------------------------------------------------------------------- #
# Students (all answer the Biology - Genetics paper)
# --------------------------------------------------------------------------- #
DARK_BLUE = (22, 38, 118)
GEL_BLUE = (30, 60, 172)
BLUE_BLACK = (26, 34, 86)
BLACK = (28, 28, 34)
BLACK_BALL = (36, 36, 42)

Q1_PUNNETT = gs.Punnett(cols=("T", "t"), rows=("t",), cells=(("Tt", "tt"),))
Q4_PUNNETT = gs.Punnett(cols=("X^{c}", "Y"), rows=("X", "X^{c}"), cells=(("XX^{c}", "XY"), ("X^{c}X^{c}", "X^{c}Y")))
Q4_PUNNETT_WRONG = gs.Punnett(cols=("X^{c}", "Y"), rows=("X", "X"), cells=(("XX^{c}", "XY"), ("XX^{c}", "XY")))
Q1_PUNNETT_WEAK = gs.Punnett(cols=("T", "t"), rows=("T", "t"), cells=(("TT", "Tt"), ("Tt", "tt")))
TUBES_RIGHT = Tubes(labels=("^{15}N", "Gen\u00a01", "Gen\u00a02"), bands=((0.85,), (0.55,), (0.55, 0.25)), rows=5)
TUBES_WRONG = Tubes(labels=("^{15}N", "Gen\u00a01", "Gen\u00a02"), bands=((0.85,), (0.85, 0.25), (0.85, 0.25)), rows=5)

SPECS: list[Spec] = [
    # 01 - near-perfect: every rubric point covered, one self-corrected slip.
    Spec(
        nn=1, slug="near_perfect_300dpi", ext="jpg", width=2480,
        student="Ananya Krishnan", roll="NA07-008",
        font="segoepr.ttf", em_mm=4.8, pitch_mm=7.2, ink=DARK_BLUE,
        paper="ruled", header="booklet", label_fmt="Q{}.", label_pos="margin",
        seed=101, effect="scan", rot_char=1.2, slant_deg=2.0,
        answers={
            1: [
                "Tt (heterozygous tall) x tt (dwarf);  gametes T, t and t",
                Q1_PUNNETT,
                "Genotypic ratio = 1\u00a0Tt\u00a0:\u00a01\u00a0tt",
                "Phenotypic ratio = 1\u00a0tall\u00a0:\u00a01\u00a0dwarf",
                "This is a test cross - it tells whether a tall plant is TT or Tt.",
            ],
            2: [
                "Incomplete dominance: neither allele is completely dominant, so the heterozygote "
                "shows an intermediate phenotype. Eg. snapdragon: red (RR) x white (rr) gives pink "
                "(Rr); F2 = 1\u00a0red\u00a0:\u00a02\u00a0pink\u00a0:\u00a01\u00a0white.",
                "Codominance: both alleles are fully expressed together in the heterozygote. "
                "Eg. ABO blood groups - I^{A}I^{B} gives blood group AB.",
            ],
            3: [
                "Each daughter DNA keeps one old (parental) strand and one newly synthesised strand.",
                "Proved by Meselson and Stahl (1958). E. coli grown in ^{15}NH_{4}Cl, then "
                "shifted to ^{14}N medium; DNA separated by CsCl density gradient "
                "centrifugation. Gen\u00a01: all hybrid (^{15}N/^{14}N). Gen\u00a02: half hybrid, half light.",
                "DNA polymerase works only 5'->3', so the leading strand is continuous and "
                "the lagging strand is made as Okazaki fragments, joined by ligase.",
            ],
            4: [
                "Man = X^{c}Y. Woman has normal vision but her father was colour blind, so she "
                "is a carrier: XX^{c}.",
                Q4_PUNNETT,
                "Cross: X^{c}Y x XX^{c}",
                "Daughters: XX^{c} carrier, X^{c}X^{c} colour blind",
                "-> 50% of daughters colour blind.",
                "Sons: XY normal, X^{c}Y colour blind -> 50% of sons colour blind.",
            ],
            5: [
                "Chromosomal disorder (aneuploidy): trisomy 21 - an extra chromosome 21, "
                "so 47 chromosomes (2n+1).",
                "Cause: non-disjunction of chr. 21 during ~~mitosis~~ meiosis (gametes).",
                "Symptoms: short stature, small round head, furrowed tongue, open mouth, "
                "palm crease, mental retardation.",
            ],
        },
    ),
    # 02 - average A: test cross not named, wrong experiment, ignores the carrier mother, no non-disjunction.
    Spec(
        nn=2, slug="average_bradley_squared_200dpi", ext="png", width=1654,
        student="Ishaan Gupta", roll="NA07-052",
        font="BRADHITC.TTF", em_mm=6.4, pitch_mm=10.0, ink=BLACK, stroke_mm=0.12,
        paper="graph", header="handwritten", label_fmt="Ans\u00a0{}.", label_pos="inline",
        seed=202, effect="clean", slant_deg=4.0, rot_char=1.6, line_rot=0.4,
        paper_tone=(252, 252, 250), mottle=0.04,
        hand_header=("Name: Ishaan Gupta     Roll No: NA07-052",
                     "NEET-A Mock-07   Biology - Genetics   Date: 14/11/26"),
        answers={
            1: [
                "Tt x tt  (tall x dwarf)",
                Q1_PUNNETT,
                "Genotypic ratio - 1\u00a0Tt\u00a0:\u00a01\u00a0tt",
                "Phenotypic ratio - 1 Tall : 1 Dwarf",
                "This is a monohybrid cross.",
            ],
            2: [
                "Incomplete dominance - the F1 shows a phenotype in between the two parents. "
                "Example - Mirabilis jalapa: red x white gives pink flowers.",
                "Codominance - both alleles are expressed equally in the F1. "
                "Example - AB blood group (I^{A}I^{B}).",
            ],
            3: [
                "Each new DNA molecule has one parent strand and one new strand. Helicase "
                "unwinds the DNA and DNA polymerase makes the new strands - the leading strand "
                "is continuous and the lagging strand is made as Okazaki fragments.",
                "This was proved by the Hershey and Chase experiment.",
            ],
            4: [
                "Man - X^{c}Y (colour blind)    Woman - XX (normal)",
                Q4_PUNNETT_WRONG,
                "All daughters are carriers and",
                "all sons are normal. So 0% sons",
                "and 0% daughters colour blind.",
            ],
            5: [
                "Chromosomal disorder due to an extra chromosome 21 (trisomy 21), "
                "47 chromosomes. Symptoms - short height, round head, mental retardation.",
            ],
        },
    ),
    # 03 - average B: wrong genotypic ratio, swapped definitions, wrong label (32P), daughters misread, monosomy.
    Spec(
        nn=3, slug="average_kristen_plain_150dpi", ext="png", width=1240,
        student="Meera Pillai", roll="NA07-019",
        font="ITCKRIST.TTF", em_mm=5.0, pitch_mm=8.6, ink=GEL_BLUE,
        paper="plain", header="handwritten", label_fmt="Q.{}", label_pos="inline", hanging=True,
        seed=303, effect="scan", rot_char=1.8, slant_deg=-2.0, line_rot=0.35, line_tilt=0.25,
        paper_tone=(253, 253, 252),
        hand_header=("Meera Pillai  -  Roll No. NA07-019  -  14/11/26",
                     "NEET-A Mock-07 : Biology - Genetics"),
        answers={
            1: [
                "Tt x tt",
                Q1_PUNNETT,
                "Genotypic ratio = 1\u00a0TT\u00a0:\u00a02\u00a0Tt\u00a0:\u00a01\u00a0tt",
                "Phenotypic ratio = 1 tall : 1 dwarf",
                "It is a test cross.",
            ],
            2: [
                "Incomplete dominance - both the alleles are expressed together in the hybrid. "
                "Eg. AB blood group.",
                "Codominance - the hybrid is intermediate between the two parents as neither "
                "allele is dominant. Eg. pink snapdragon from red x white.",
            ],
            3: [
                "Semi-conservative means one strand of the parent DNA is conserved in each new "
                "DNA, i.e. one old strand + one new strand.",
                "Meselson and Stahl proved it using E. coli. They labelled the DNA with "
                "radioactive ^{32}P and checked the radioactivity in the daughter cells.",
            ],
            4: [
                "Man = X^{c}Y",
                "Woman = XX^{c} (carrier, her father was colour blind)",
                Q4_PUNNETT,
                "Sons - 50% colour blind",
                "Daughters - none are colour",
                "blind, 50% are carriers.",
            ],
            5: [
                "Down's syndrome is a genetic disorder due to loss of one chromosome 21 "
                "(monosomy), so the person has 45 chromosomes.",
                "Symptoms - mental retardation, flat face, short stature and palm crease.",
            ],
        },
    ),
    # 04 - weak: 3:1 ratio / dihybrid, vague Q2, conservative model + Watson-Crick, all sons, partial Q5.
    Spec(
        nn=4, slug="weak_mvboli_ruled_phone", ext="webp", width=1500, out_size=(1500, 2100),
        student="Rahul Yadav", roll="NA07-061",
        font="mvboli.ttf", em_mm=6.0, pitch_mm=9.0, ink=BLACK_BALL,
        paper="ruled", header="boxes", label_fmt="{}.", label_pos="margin",
        seed=404, effect="photo", rot_char=1.6, slant_deg=1.0, line_rot=0.4, space=0.85,
        paper_tone=(250, 248, 240),
        answers={
            1: [
                "Tt x tt",
                Q1_PUNNETT_WEAK,
                "TT, Tt, Tt, tt",
                "ratio 3 : 1",
                "It is a dihybrid cross.",
            ],
            2: [
                "Incomplete dominance - one gene is dominant on the other gene.",
                "Codominance - both genes are dominant. Eg. AB blood group.",
            ],
            3: [
                "DNA replication is semi conservative because DNA makes a copy of itself and the "
                "old DNA is kept as it is.",
                "It was proved by Watson and Crick.",
            ],
            4: [
                "All sons will be colour blind and all daughters will be ~~carrier~~ normal.",
            ],
            5: [
                "Down's syndrome is caused by an extra chromosome 21.",
                "Symptoms - mental retardation and flat face.",
            ],
        },
    ),
    # 05 - good but verbose, 3 pages: Q3 wrong Gen-1 result (two bands), Q4 daughters 25%, Q5 mitosis + Turner symptom.
    Spec(
        nn=5, slug="good_lucida_3page", ext="pdf", width=1654, pages=3,
        student="Sneha Reddy", roll="NA07-037",
        font="LHANDW.TTF", em_mm=6.2, pitch_mm=9.5, ink=BLUE_BLACK,
        paper="ruled", header="booklet", label_fmt="Q{})", label_pos="margin",
        seed=505, effect="scan", line_rot=0.35, space=1.05, word_rot=0.5,
        rot_char=0.5, dy_char=0.008, ds_char=0.012, sp_char=0.0,   # connected script: tiny glyph jitter
        paper_tone=(250, 249, 243),
        answers={
            1: [
                "Given: tall (T) is dominant over dwarf (t).",
                "Parents: Tt (heterozygous tall) x tt (dwarf)",
                Q1_PUNNETT,
                "Gametes: T and t from the tall parent, only t from the dwarf parent.",
                "Offspring: Tt (tall) and tt (dwarf)",
                "Genotypic ratio = 1\u00a0Tt\u00a0:\u00a01\u00a0tt",
                "Phenotypic ratio = 1\u00a0tall\u00a0:\u00a01\u00a0dwarf",
                "This is a test cross. A plant with the dominant phenotype is crossed with the "
                "homozygous recessive parent to find out whether it is homozygous (TT) or "
                "heterozygous (Tt). Here 1\u00a0:\u00a01 shows the tall plant was Tt.",
            ],
            2: [
                "Incomplete dominance: here neither allele is completely dominant over the other, "
                "so the F1 heterozygote shows an intermediate (in-between) phenotype.",
                "Example: flower colour in snapdragon (Antirrhinum majus). Red (RR) x white (rr) "
                "gives all pink (Rr) in F1, and the F2 ratio is 1\u00a0red\u00a0:\u00a02\u00a0pink\u00a0:\u00a01\u00a0white, so the "
                "phenotypic and genotypic ratios are the same.",
                "Codominance: both alleles are expressed fully and at the same time in the "
                "heterozygote, nothing is blended.",
                "Example: ABO blood groups - I^{A} and I^{B} are codominant, so a person with "
                "I^{A}I^{B} has blood group AB (both A and B antigens on the RBCs). Roan coat "
                "colour in cattle is another example.",
            ],
            3: [
                "In semi-conservative replication the two strands of the parent DNA separate and "
                "each acts as a template. So every daughter DNA molecule has one old (parental) "
                "strand and one newly synthesised strand.",
                "This was proved by Meselson and Stahl in 1958.",
                "They grew E. coli for many generations in a medium with ^{15}NH_{4}Cl, so all "
                "the DNA became heavy (^{15}N). The cells were then shifted to a medium with "
                "normal ^{14}N.",
                TUBES_WRONG,
                "DNA was extracted after every generation (about 20 minutes) and separated "
                "by CsCl density gradient centrifugation.",
                "After one generation they got two bands - one heavy (^{15}N/^{15}N) and one "
                "light (^{14}N/^{14}N).",
                "After two generations the light band became thicker than the heavy band.",
                "DNA polymerase adds nucleotides only in the 5'->3' direction, so the leading "
                "strand is continuous and the lagging strand is made in small pieces called "
                "Okazaki fragments, which are joined by DNA ligase.",
            ],
            4: [
                "Colour blindness is X-linked recessive. Man (colour blind) = X^{c}Y",
                "Woman has normal vision but her father was colour blind, so she got X^{c} from "
                "him - she is a carrier = XX^{c}.",
                "Cross: X^{c}Y x XX^{c}",
                Q4_PUNNETT,
                "Gametes: X^{c}, Y and X, X^{c}",
                "XX^{c} - carrier daughter",
                "X^{c}X^{c} - colour blind daughter",
                "XY - normal son, X^{c}Y - colour blind son",
                "So 50% of the sons are colour blind, and 25% of the daughters are colour blind "
                "(1 out of 4 children).",
            ],
            5: [
                "Down's syndrome is a chromosomal disorder (aneuploidy) in which there is an "
                "extra copy of chromosome 21 - trisomy 21, so the person has 47 chromosomes.",
                "Cause: non-disjunction of chromosome 21 during mitosis in the early embryo.",
                "Symptoms: (i) short stature, small round head (ii) furrowed tongue, partially "
                "open mouth (iii) webbed neck (iv) mental retardation.",
            ],
        },
    ),
]


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def save(spec: Spec, pages: list[Image.Image], path: Path) -> None:
    dpi = round(spec.width / (A4_W_MM / 25.4))
    if spec.ext == "pdf":
        doc = pymupdf.open()
        for img in pages:
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=86, optimize=True)
            page = doc.new_page(width=A4_PT[0], height=A4_PT[1])
            page.insert_image(page.rect, stream=buf.getvalue())
        doc.set_metadata({"title": path.stem, "creator": "3iLens neat test-page generator",
                          "creationDate": "D:20261114100000", "modDate": "D:20261114100000"})
        doc.save(str(path), garbage=3, deflate=True, no_new_id=True)
        doc.close()
    elif spec.ext == "png":
        pages[0].save(path, "PNG", optimize=True, dpi=(dpi, dpi))
    elif spec.ext == "webp":
        pages[0].save(path, "WEBP", quality=86, method=6)
    else:
        pages[0].save(path, "JPEG", quality=spec.jpeg_quality, optimize=True, dpi=(dpi, dpi))


def describe(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        with pymupdf.open(str(path)) as doc:
            sizes = []
            for p in doc:
                imgs = p.get_images()
                sizes.append(f"{imgs[0][2]}x{imgs[0][3]}" if imgs else "?")
            return f"PDF {doc.page_count} pages, embedded {', '.join(sizes)}"
    with Image.open(path) as im:
        im.load()
        return f"{im.format} {im.width}x{im.height}"


def main() -> int:
    rubric = json.loads(gs.RUBRIC_PATH.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    for spec in SPECS:
        if only and str(spec.nn) not in only and f"{spec.nn:02d}" not in only:
            continue
        unknown = set(spec.answers) - {q["question"] for q in rubric["questions"]}
        if unknown:
            raise ValueError(f"{spec.filename}: unknown questions {sorted(unknown)}")
        pages, spans, em = render(spec, rubric)
        fx = random.Random(spec.seed + 99)
        if spec.effect == "scan":
            pages = [scan_effect(p, fx, angle=fx.uniform(-0.45, 0.45), grain=2.5, edge_shadow=(i == 0 and spec.nn == 1))
                     for i, p in enumerate(pages)]
        elif spec.effect == "photo":
            pages = [photo_effect(p, fx, spec.out_size or p.size) for p in pages]
        path = OUT / spec.filename
        save(spec, pages, path)
        span_txt = " ".join(f"Q{q}:p{'+'.join(str(p + 1) for p in sorted(s))}" for q, s in sorted(spans.items()))
        print(f"wrote {path.name:<48} {path.stat().st_size / 1024:7.0f} KB  {describe(path)}  "
              f"em={em}mm  {span_txt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
