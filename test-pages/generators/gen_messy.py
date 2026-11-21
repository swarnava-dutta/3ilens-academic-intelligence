"""Generate the "messy" test pages: bad handwriting at increasing severity.

    backend/.venv/Scripts/python.exe test-pages/generators/gen_messy.py

Writes six sheets to test-pages/generated/messy/. Every sheet answers the Biology - Genetics
paper (backend/rubrics/biology_genetics_v1.json, Q1..Q5). All pages are physically sharp
(flat scans, no blur); the difficulty is the handwriting itself:

    01 mild         rushed slant, uneven baseline, inconsistent letter size
    02 moderate     cramped lines, run-together words, cross-outs, overwrites, ink smudge
    03 cursive      script font with heavy per-letter jitter
    04 tiny         tiny writing, two lines per ruled gap, margin notes + arrows, carets
    05 severe       scrawl: irregular size/rotation, overlapping letters, drifting lines
    06 pencil       faint, low-contrast pencil with uneven pressure (2-page PDF)

Reuses samples/generate_samples.py (fonts, answer markup parser, Punnett model, wobbly lines,
verify) without modifying it. All randomness comes from seeded random.Random instances
(noise images are built from rng.randbytes, not Image.effect_noise, so output is repeatable).

Extra answer markup on top of generate_samples.py's (~~struck~~, ^{sup}, _{sub}):
    ##word##        word scribbled out (dense zig-zag)
    [[old|new]]     "old" written, then "new" written over it in the same place
    <<a+b+c>>       caret here, "a b c" squeezed in above the line
    @N              caret here; the Note(mark="N") text is written in the margin with an arrow
    @@id            invisible anchor (used to place an ink smudge)
    `word           very faint word (light pressure)
"""
from __future__ import annotations

import io
import json
import math
import random
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf
from PIL import Image, ImageChops, ImageDraw, ImageFilter

sys.path.insert(0, r"H:\3ilens\samples")
import generate_samples as gs  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "generated" / "messy"
CATEGORY = "messy"
BICUBIC = Image.Resampling.BICUBIC


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def comp(dst: Image.Image, src: Image.Image, x: float, y: float) -> None:
    """alpha_composite `src` onto `dst` with its top-left at (x, y), clipped to `dst`."""
    x, y = int(round(x)), int(round(y))
    sx, sy = max(0, -x), max(0, -y)
    dx, dy = max(0, x), max(0, y)
    w, h = min(src.width - sx, dst.width - dx), min(src.height - sy, dst.height - dy)
    if w > 0 and h > 0:
        dst.alpha_composite(src, (dx, dy), (sx, sy, sx + w, sy + h))


def noise(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """Seeded uniform noise (L mode)."""
    return Image.frombytes("L", size, rng.randbytes(size[0] * size[1]))


def smooth_noise(size: tuple[int, int], cell: int, rng: random.Random) -> Image.Image:
    small = noise((max(2, size[0] // cell), max(2, size[1] // cell)), rng)
    return small.filter(ImageFilter.GaussianBlur(1.0)).resize(size, BICUBIC)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# --------------------------------------------------------------------------- #
# Answer tokens
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Note:
    """Margin note linked by an arrow to the caret written as `@<mark>` in the text."""

    mark: str
    lines: tuple[str, ...]


@dataclass
class Tok:
    kind: str                       # word | over | insert | mark | anchor
    word: gs.Word | None = None
    alt: gs.Word | None = None      # over: the correction written on top
    text: str = ""                  # insert text / mark id
    scribble: bool = False
    faint: bool = False


def parse_tok(raw: str) -> Tok:
    faint = raw.startswith("`")
    raw = raw.lstrip("`")
    if m := re.fullmatch(r"\[\[(.+?)\|(.+?)\]\]", raw):
        return Tok("over", gs.parse_word(m.group(1)), gs.parse_word(m.group(2)))
    if m := re.fullmatch(r"<<(.+?)>>", raw):
        return Tok("insert", text=m.group(1).replace("+", " "))
    if m := re.fullmatch(r"@@(\w+)", raw):
        return Tok("anchor", text=m.group(1))
    if m := re.fullmatch(r"@(\w+)", raw):
        return Tok("mark", text=m.group(1))
    if m := re.fullmatch(r"##(.+)##", raw):
        return Tok("word", gs.parse_word(m.group(1)), scribble=True)
    return Tok("word", gs.parse_word(raw), faint=faint)


def toks(text: str) -> list[Tok]:
    return [parse_tok(t) for t in text.split(" ") if t]


# --------------------------------------------------------------------------- #
# Messy handwriting
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Style:
    fonts: tuple[str, ...]
    alt_fonts: tuple[str, ...] = ()
    alt_prob: float = 0.0           # chance a letter comes out in an alternate letterform
    stroke: int = 0
    slant: float = 0.0              # shear (right lean > 0)
    slant_jitter: float = 0.0       # per word
    char_rot: float = 0.0           # degrees (sd) per letter
    char_dy: float = 0.0            # baseline jitter per letter (fraction of size, sd)
    char_scale: float = 0.0         # size jitter per letter (sd)
    word_scale: float = 0.03        # size jitter per word (sd)
    track: float = 0.0              # letter spacing (fraction of advance; < 0 overlaps)
    track_jitter: float = 0.0
    word_space: tuple[float, float] = (0.85, 1.2)
    word_rot: float = 0.35          # degrees (sd) per word
    word_dy: float = 0.02           # fraction of size (sd)
    line_slope: tuple[float, float] = (-0.35, 0.35)   # degrees, + = drifts downwards
    line_wave: float = 0.0          # baseline wander amplitude (fraction of size)
    alpha: tuple[int, int] = (222, 250)
    char_alpha: int = 0             # per-letter pressure variation
    faint_prob: float = 0.0
    faint_alpha: tuple[int, int] = (38, 62)
    strike: str = "line"            # line | scribble
    colour_jitter: int = 14
    squash: float = 1.0             # horizontal compression of every word (cramped writing < 1)


class Hand:
    def __init__(self, style: Style, size: float, ink: tuple[int, int, int], rng: random.Random, s: float):
        self.st = style
        self.size = size
        self.ink = ink
        self.rng = rng
        self.s = s
        self.path = gs.find_font(*style.fonts, *gs.HANDWRITING_FALLBACKS)
        self.alt_paths = [p for p in (gs.find_font(f) for f in style.alt_fonts) if p]
        self.extra_stroke = 0
        self.marks: dict[str, tuple[float, float]] = {}

    # ---- metrics -------------------------------------------------------- #
    def font(self, size: float, path: str | None = None):
        return gs.load_font(path or self.path, max(7, int(round(size))))

    def word_width(self, word: gs.Word, size: float | None = None) -> float:
        size = size or self.size
        total = sum(self.font(size if k == "n" else size * 0.62).getlength(t) for t, k in word.segments)
        return total * (1 + self.st.track) * self.st.squash

    def space(self, size: float | None = None) -> float:
        return self.font(size or self.size).getlength(" ") * 1.15

    def tok_width(self, tok: Tok) -> float:
        if tok.kind == "word":
            return self.word_width(tok.word)
        if tok.kind == "over":
            return max(self.word_width(tok.word), self.word_width(tok.alt))
        if tok.kind in ("insert", "mark"):
            return self.space() * 0.4
        return 0.0

    def line_colour(self) -> tuple[int, int, int]:
        j = self.st.colour_jitter
        return tuple(int(clamp(v + self.rng.randint(-j, j), 0, 255)) for v in self.ink)  # type: ignore[return-value]

    # ---- drawing -------------------------------------------------------- #
    def _glyph(self, canvas: Image.Image, ch: str, x: float, base: float, size: float,
               colour: tuple[int, int, int, int], angle: float, path: str | None) -> float:
        f = self.font(size, path)
        sw = self.st.stroke + self.extra_stroke
        if abs(angle) < 0.05:
            ImageDraw.Draw(canvas).text((x, base), ch, font=f, fill=colour, anchor="ls",
                                        stroke_width=sw, stroke_fill=colour)
        else:
            side = int(size * 2.8) + 10
            ax, ay = int(size * 0.75), int(size * 1.9)
            g = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            ImageDraw.Draw(g).text((ax, ay), ch, font=f, fill=colour, anchor="ls",
                                   stroke_width=sw, stroke_fill=colour)
            g = g.rotate(angle, resample=BICUBIC, center=(ax, ay))
            comp(canvas, g, x - ax, base - ay)
        return f.getlength(ch)

    def _strike(self, canvas: Image.Image, x0: float, x1: float, base: float, size: float,
                colour: tuple[int, int, int], kind: str) -> None:
        d = ImageDraw.Draw(canvas)
        rng = self.rng
        width = max(2, int(size / 12))
        if kind == "scribble":
            pts, x, up = [], x0 - 4, True
            while x < x1 + 6:
                pts.append((x + rng.uniform(-3, 3), base - size * (0.78 if up else 0.02) + rng.uniform(-4, 4)))
                x += size * rng.uniform(0.11, 0.2)
                up = not up
            d.line(pts, fill=(*colour, 235), width=width, joint="curve")
            # second pass the other way so the word really is blacked out
            d.line([(px + rng.uniform(-6, 6), py + size * 0.12) for px, py in reversed(pts)],
                   fill=(*colour, 220), width=width, joint="curve")
            return
        mid = base - size * 0.3
        for k in range(rng.choice((1, 2, 2))):
            tilt = rng.uniform(-0.09, 0.09) * size
            off = (k - 0.5) * size * 0.16
            d.line([(x0 - 5, mid + off + tilt), (x1 + 5, mid + off - tilt)], fill=(*colour, 235), width=width)

    def render_word(self, word: gs.Word, size: float, colour: tuple[int, int, int], alpha: int,
                    scribble: bool = False) -> tuple[Image.Image, int, int, float]:
        """Render one word letter by letter; returns (image, anchor_x, baseline_y, advance)."""
        st, rng = self.st, self.rng
        est = self.word_width(word, size) * 1.35 + size
        k = st.slant + rng.gauss(0, st.slant_jitter)
        padx = int(size * 0.9)
        hc = int(size * 3.4 + est * 0.12)
        base = int(hc * 0.62)
        wc = int(est + 2 * padx + abs(k) * hc)
        canvas = Image.new("RGBA", (wc, hc), (0, 0, 0, 0))
        cx = float(padx)
        for text, kind in word.segments:
            ssize = size if kind == "n" else size * 0.62
            yoff = 0.0 if kind == "n" else (-size * 0.42 if kind == "sup" else size * 0.16)
            if kind != "n" and cx > padx:
                cx += size * 0.07           # keep a small index clear of the letter before it
            for ch in text:
                if ch.isspace():
                    cx += self.space(ssize) * 0.6
                    continue
                cs = ssize * clamp(1 + rng.gauss(0, st.char_scale), 0.6, 1.55)
                path = rng.choice(self.alt_paths) if self.alt_paths and rng.random() < st.alt_prob else None
                a = int(clamp(alpha + rng.randint(-st.char_alpha, st.char_alpha), 12, 255))
                adv = self._glyph(canvas, ch, cx, base + yoff + rng.gauss(0, st.char_dy) * size, cs,
                                  (*colour, a), rng.gauss(0, st.char_rot), path)
                cx += adv * (1 + st.track + rng.gauss(0, st.track_jitter))
        if word.struck or scribble:
            self._strike(canvas, padx, cx, base, size, colour, "scribble" if scribble else st.strike)
        if abs(k) > 1e-3:
            canvas = canvas.transform(canvas.size, Image.Transform.AFFINE, (1, k, -k * base, 0, 1, 0),
                                      resample=BICUBIC)
        adv = cx - padx
        if st.squash != 1.0:
            canvas = canvas.resize((max(1, int(wc * st.squash)), hc), Image.Resampling.LANCZOS)
            padx, adv = int(padx * st.squash), adv * st.squash
        return canvas, padx, base, adv

    def place_word(self, ink: Image.Image, word: gs.Word, x: float, y: float, size: float,
                   colour: tuple[int, int, int], alpha: int, scribble: bool = False,
                   rot: float | None = None) -> float:
        img, ax, ay, adv = self.render_word(word, size, colour, alpha, scribble)
        rot = self.rng.gauss(0, self.st.word_rot) if rot is None else rot
        if abs(rot) > 0.02:
            img = img.rotate(rot, resample=BICUBIC, center=(ax, ay))
        comp(ink, img, x - ax, y - ay)
        return adv

    def word_alpha(self, faint: bool = False) -> int:
        st = self.st
        if faint or self.rng.random() < st.faint_prob:
            return self.rng.randint(*st.faint_alpha)
        return self.rng.randint(*st.alpha)

    def caret(self, ink: Image.Image, x: float, y: float, colour) -> None:
        d = ImageDraw.Draw(ink)
        sz = self.size
        w = max(2, int(sz / 14))
        pts = [(x - sz * 0.2, y + sz * 0.28), (x + self.rng.uniform(-2, 2), y - sz * 0.22),
               (x + sz * 0.2, y + sz * 0.26)]
        d.line(pts, fill=(*colour, 240), width=w, joint="curve")

    def render_line(self, ink: Image.Image, line: list[Tok], x0: float, y0: float,
                    flat: bool = False, insert_rise: float | None = None) -> float:
        """Render tokens along a drifting, wavy baseline starting at (x0, y0); returns end x."""
        st, rng, size = self.st, self.rng, self.size
        slope = 0.0 if flat else math.tan(math.radians(rng.uniform(*st.line_slope)))
        amp = 0.0 if flat else st.line_wave * size
        period, phase = rng.uniform(420, 820) * self.s, rng.uniform(0, 2 * math.pi)

        def yat(x: float) -> float:
            return y0 + (x - x0) * slope + amp * math.sin(2 * math.pi * (x - x0) / period + phase)

        colour = self.line_colour()
        x = x0
        for tok in line:
            y = yat(x) + rng.gauss(0, st.word_dy) * size
            if tok.kind == "anchor":
                self.marks[tok.text] = (x, y)
                continue
            if tok.kind in ("insert", "mark"):
                cx = x - self.space() * 0.45
                self.caret(ink, cx, y, colour)
                if tok.kind == "mark":
                    self.marks[tok.text] = (cx, y - size * 0.25)
                else:
                    rise = insert_rise if insert_rise is not None else size * 1.02
                    isize = size * 0.74
                    iw = sum(self.word_width(gs.parse_word(w), isize) + self.space(isize) for w in tok.text.split())
                    ix = cx - iw / 2
                    for w in tok.text.split():
                        ix += self.place_word(ink, gs.parse_word(w), ix, y - rise, isize, colour,
                                              self.word_alpha()) + self.space(isize) * 0.9
                x += self.space() * 0.3
                continue
            wsize = size * clamp(1 + rng.gauss(0, st.word_scale), 0.7, 1.4)
            alpha = self.word_alpha(tok.faint)
            if tok.kind == "over":
                # Replay the same jitter so shared letters land on top of each other and only
                # the changed letters show the correction (e.g. dominent -> dominant).
                rot = rng.gauss(0, st.word_rot)
                state = rng.getstate()
                adv = self.place_word(ink, tok.word, x, y, wsize, colour, alpha, rot=rot)
                rng.setstate(state)
                self.extra_stroke = 1
                adv2 = self.place_word(ink, tok.alt, x, y, wsize, colour, min(255, alpha + 15), rot=rot)
                self.extra_stroke = 0
                adv = max(adv, adv2)
            else:
                adv = self.place_word(ink, tok.word, x, y, wsize, colour, alpha, tok.scribble)
            x += adv + self.space() * rng.uniform(*st.word_space)
        return x

    def text_at(self, ink: Image.Image, text: str, x: float, y: float, flat: bool = True) -> float:
        return self.render_line(ink, toks(text), x, y, flat=flat)

    def centered(self, ink: Image.Image, text: str, cx: float, y: float, scale: float = 1.0) -> None:
        w = parse_tok(text)
        size = self.size * scale
        width = self.word_width(w.word, size)
        self.place_word(ink, w.word, cx - width / 2, y, size, self.line_colour(), self.word_alpha())


# --------------------------------------------------------------------------- #
# Sheet description and geometry
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Paper:
    tone: tuple[int, int, int] = (251, 249, 242)
    mottle: float = 0.05
    rule: tuple[int, int, int] = (158, 189, 226)
    margin: tuple[int, int, int] = (222, 96, 96)
    print_grey: tuple[int, int, int] = (48, 50, 60)
    bed: tuple[int, int, int] = (236, 236, 233)      # scanner lid colour shown by the skew


@dataclass
class Sheet:
    nn: int
    slug: str
    ext: str
    student: str
    roll_no: str
    style: Style
    size: float                      # handwriting size in px at the output resolution
    ink: tuple[int, int, int]
    seed: int
    W: int
    H: int
    answers: dict[int, list]
    rule_gap: float = 55             # in 1700-px-wide units (scaled with the page)
    pitch: float = 1.0               # writing line pitch as a multiple of the rule gap
    margin_x: float = 150            # in 1700-px-wide units
    label_fmt: str = "Q{n}."
    answer_gap: int = 1              # blank writing lines between answers
    pages: int = 1
    page_break_before: frozenset[int] = frozenset()
    paper: Paper = field(default_factory=Paper)
    skew: float = 0.3                # degrees
    grain: float = 0.0
    pencil: bool = False
    smudges: tuple[str, ...] = ()    # anchor ids
    slack: float = 30                # wrap slack (px at 1700 width)
    bottom_reserve: float = 0        # extra px kept free at page bottom (for drifting lines)
    insert_rise: float | None = None
    ink_soften: float = 0.55
    punnett_cell: tuple[float, float] = (120, 55)   # cell w, h in 1700-px units
    punnett_text: float = 0.85                      # cell text size relative to handwriting

    @property
    def filename(self) -> str:
        return f"answer_sheet_{CATEGORY}_{self.nn:02d}_{self.slug}.{self.ext}"


@dataclass
class Geom:
    W: int
    H: int
    s: float
    margin_x: float
    label_x: float
    text_x: float
    right_x: float
    first_rule: float
    rule_gap: float
    last_rule: float
    pitch: float
    n_slots: int

    @classmethod
    def of(cls, sh: Sheet) -> Geom:
        s = sh.W / 1700
        first, gap = 290 * s, sh.rule_gap * s
        last = first + int((sh.H - 50 * s - first) / gap) * gap
        pitch = gap * sh.pitch
        n = int((last - first - sh.bottom_reserve * s) / pitch) + 1
        return cls(sh.W, sh.H, s, sh.margin_x * s, 30 * s, sh.margin_x * s + 28 * s, sh.W - 75 * s,
                   first, gap, last, pitch, n)

    def base_y(self, slot: float) -> float:
        return self.first_rule + slot * self.pitch - 8 * self.s


@dataclass
class Op:
    kind: str                        # label | text | punnett | note
    slot: int
    payload: object
    x: float = 0.0


class Overflow(Exception):
    pass


def place_question(sh: Sheet, q: int, items: list, hand: Hand, g: Geom, slot: int) -> tuple[list[Op], int]:
    ops = [Op("label", slot, sh.label_fmt.format(n=q), g.label_x)]
    floats: list[tuple[int, int, float]] = []
    cw, chh = sh.punnett_cell[0] * g.s, sh.punnett_cell[1] * g.s
    slack = sh.slack * g.s
    st = hand.st

    def right_edge(i: int) -> float:
        return min([g.right_x] + [xl - 30 * g.s for a, b, xl in floats if a <= i < b])

    for item in items:
        if isinstance(item, gs.Punnett):
            x_left = g.right_x - (len(item.cols) + 1) * cw
            need = math.ceil((len(item.rows) + 1) * chh / g.pitch) + 1
            floats.append((slot, slot + need, x_left))
            ops.append(Op("punnett", slot, item, x_left))
            continue
        if isinstance(item, Note):
            ops.append(Op("note", slot, item))
            continue
        words = toks(item)
        i = 0
        while i < len(words):
            limit = right_edge(slot) - g.text_x - slack
            j, width = i, 0.0
            while j < len(words):
                add = hand.tok_width(words[j]) * (1 + 1.6 * st.word_scale + 0.5 * st.track_jitter)
                add += hand.space() * st.word_space[1] if j > i else 0
                if j > i and width + add > limit:
                    break
                width += add
                j += 1
            ops.append(Op("text", slot, words[i:j], g.text_x))
            slot += 1
            i = j
    return ops, max([slot] + [b for _, b, _ in floats])


def layout(sh: Sheet, hand: Hand, g: Geom) -> list[list[Op]]:
    pages: list[list[Op]] = [[]]
    slot = 0
    for q in sorted(sh.answers):
        ops, end = place_question(sh, q, sh.answers[q], hand, g, slot)
        if pages[-1] and (q in sh.page_break_before or end > g.n_slots):
            pages.append([])
            ops, end = place_question(sh, q, sh.answers[q], hand, g, 0)
        if end > g.n_slots:
            raise Overflow(f"{sh.filename}: Q{q} alone is taller than a page")
        pages[-1].extend(ops)
        slot = end + sh.answer_gap
    if len(pages) != sh.pages:
        raise Overflow(f"{sh.filename}: laid out on {len(pages)} page(s), expected {sh.pages}")
    return pages


# --------------------------------------------------------------------------- #
# Paper, header, Punnett squares, notes, smudges
# --------------------------------------------------------------------------- #
def make_paper(sh: Sheet, g: Geom, rng: random.Random) -> Image.Image:
    p = sh.paper
    m = smooth_noise((g.W, g.H), 14, rng)
    chans = [m.point(lambda v, b=b: int(clamp(b + (v - 128) * p.mottle, 0, 255))) for b in p.tone]
    paper = Image.merge("RGB", chans)
    d = ImageDraw.Draw(paper)
    lw = max(1, round(2 * g.s))
    y = g.first_rule
    while y <= g.last_rule + 1:
        d.line([(0, y), (g.W, y)], fill=p.rule, width=lw)
        y += g.rule_gap
    d.line([(g.margin_x, 0), (g.margin_x, g.H)], fill=p.margin, width=max(2, round(3 * g.s)))
    d.line([(g.margin_x + 6 * g.s, 0), (g.margin_x + 6 * g.s, g.H)],
           fill=tuple(int(c + (255 - c) * 0.4) for c in p.margin), width=1)
    return paper


def draw_header(paper: Image.Image, sh: Sheet, g: Geom, rubric: dict, page_no: int,
                total_pages: int) -> dict[str, tuple[float, float]]:
    """Printed form header (same layout as samples/generate_samples.py, scaled to the page)."""
    s, W = g.s, g.W
    d = ImageDraw.Draw(paper)
    bold = gs.load_font(gs.find_font(*gs.PRINT_BOLD), int(34 * s))
    reg = gs.load_font(gs.find_font(*gs.PRINT_REGULAR), int(30 * s))
    small = gs.load_font(gs.find_font(*gs.PRINT_REGULAR), int(26 * s))
    grey, line_c = sh.paper.print_grey, (90, 92, 104)
    lw = max(1, round(2 * s))
    tx = max(178 * s, g.text_x)
    d.text((tx, 70 * s), "ANSWER SHEET", font=bold, fill=grey, anchor="ls")
    d.text((W - 70 * s, 70 * s), f"Page {page_no} of {total_pages}", font=small, fill=grey, anchor="rs")
    y1 = 140 * s
    prefix = f"{gs.EXAM}   |   {rubric['name']}   |   Name:"
    d.text((tx, y1), prefix, font=reg, fill=grey, anchor="ls")
    name_x = tx + reg.getlength(prefix) + 16 * s
    d.line([(name_x, y1 + 8 * s), (W - 70 * s, y1 + 8 * s)], fill=line_c, width=lw)
    y2 = 205 * s
    d.text((tx, y2), "Roll No:", font=reg, fill=grey, anchor="ls")
    roll_x = tx + reg.getlength("Roll No:") + 16 * s
    d.line([(roll_x, y2 + 8 * s), (roll_x + 300 * s, y2 + 8 * s)], fill=line_c, width=lw)
    date_label_x = roll_x + 360 * s
    d.text((date_label_x, y2), "Date:", font=reg, fill=grey, anchor="ls")
    date_x = date_label_x + reg.getlength("Date:") + 16 * s
    d.line([(date_x, y2 + 8 * s), (date_x + 240 * s, y2 + 8 * s)], fill=line_c, width=lw)
    total = sum(q["max_marks"] for q in rubric["questions"])
    d.text((W - 70 * s, y2), f"Max. Marks: {total}", font=reg, fill=grey, anchor="rs")
    d.line([(40 * s, 232 * s), (W - 40 * s, 232 * s)], fill=line_c, width=max(2, round(3 * s)))
    return {"name": (name_x + 14 * s, y1 - 2 * s), "roll": (roll_x + 14 * s, y2 - 2 * s),
            "date": (date_x + 14 * s, y2 - 2 * s)}


def draw_punnett(ink: Image.Image, hand: Hand, p: gs.Punnett, x_left: float, top: float,
                 cw: float, chh: float, skew: float, text_scale: float) -> None:
    d = ImageDraw.Draw(ink)
    rng = hand.rng
    colour = (*hand.line_colour(), 235)
    n_rows, n_cols = len(p.rows) + 1, len(p.cols) + 1
    lw = max(2, int(hand.size / 13))

    def pt(cx: float, ry: float) -> tuple[float, float]:     # column x, row y -> skewed point
        return cx + (ry - top) * skew, ry

    bottom, right = top + n_rows * chh, x_left + n_cols * cw
    for r in range(n_rows + 1):
        y = top + r * chh + rng.uniform(-2, 2) * hand.s
        gs.wobbly_line(d, pt(x_left - rng.uniform(0, 8), y), pt(right + rng.uniform(0, 10), y), rng, colour, lw)
    for c in range(n_cols + 1):
        x = x_left + c * cw + rng.uniform(-3, 3) * hand.s
        gs.wobbly_line(d, pt(x, top - rng.uniform(0, 6)), pt(x, bottom + rng.uniform(0, 8)), rng, colour, lw)
    gs.wobbly_line(d, pt(x_left + 6, top + 6), pt(x_left + cw - 6, top + chh - 6), rng, colour, max(1, lw - 1))
    off = chh * 0.28
    for ci, gam in enumerate(p.cols):
        hand.centered(ink, gam, *pt(x_left + (ci + 1.5) * cw, top + chh - off), text_scale)
    for ri, gam in enumerate(p.rows):
        y = top + (ri + 2) * chh - off
        hand.centered(ink, gam, *pt(x_left + 0.5 * cw, y), text_scale)
        for ci, cell in enumerate(p.cells[ri]):
            hand.centered(ink, cell, *pt(x_left + (ci + 1.5) * cw, y), text_scale)


def draw_arrow(ink: Image.Image, hand: Hand, p0: tuple[float, float], p1: tuple[float, float],
               lift: float) -> None:
    """Hand-drawn curved arrow from p0 to p1 (quadratic Bezier bowed upwards by `lift`)."""
    d = ImageDraw.Draw(ink)
    rng = hand.rng
    colour = (*hand.line_colour(), 235)
    (x0, y0), (x1, y1) = p0, p1
    cx, cy = (x0 + x1) / 2, min(y0, y1) - lift
    pts = []
    n = 28
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1
        j = rng.uniform(-1.2, 1.2) if 0 < i < n else 0
        pts.append((x + j, y + j))
    lw = max(2, int(hand.size / 14))
    d.line(pts, fill=colour, width=lw, joint="curve")
    ang = math.atan2(pts[-1][1] - pts[-3][1], pts[-1][0] - pts[-3][0])
    head = hand.size * 0.45
    for da in (2.6, -2.6):
        d.line([(x1, y1), (x1 + head * math.cos(ang + da), y1 + head * math.sin(ang + da))],
               fill=colour, width=lw)


def draw_note(ink: Image.Image, hand: Hand, g: Geom, note: Note, label_bottom: float) -> None:
    if note.mark not in hand.marks:
        raise ValueError(f"note @{note.mark} has no caret in the text")
    mx, my = hand.marks[note.mark]
    y = max(my + hand.size * 0.2, label_bottom + g.pitch * 0.9)
    x = g.label_x - 6 * g.s
    widest = 0.0
    first_y = y
    for line in note.lines:
        end = hand.render_line(ink, toks(line), x, y, flat=True)
        widest = max(widest, end - x)
        y += g.pitch * 0.92
    start = (x + widest + 2 * g.s, first_y - hand.size * 0.35)
    draw_arrow(ink, hand, start, (mx, my - hand.size * 0.55), lift=g.pitch * 0.45)


def smudge(ink: Image.Image, hand: Hand, x: float, y: float) -> None:
    """Ink smudge: a dragged ghost of the nearby writing plus a blotch."""
    rng, s = hand.rng, hand.s
    box = (int(x - 40 * s), int(y - 80 * s), int(x + 330 * s), int(y + 25 * s))
    region = ink.crop(box)
    r, gch, b, a = region.split()
    a = a.point(lambda v: int(v * 0.42)).filter(ImageFilter.GaussianBlur(2.2 * s))
    ghost = Image.merge("RGBA", (r, gch, b, a))
    for k in range(1, 4):
        comp(ink, ghost, box[0] + k * 9 * s, box[1] + k * 6 * s)
    blob = Image.new("RGBA", (int(220 * s), int(150 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(blob)
    for _ in range(7):
        cx, cy = rng.uniform(70, 150) * s, rng.uniform(55, 95) * s
        rx, ry = rng.uniform(14, 38) * s, rng.uniform(10, 24) * s
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(*hand.ink, rng.randint(110, 170)))
    blob = blob.filter(ImageFilter.GaussianBlur(6 * s))
    comp(ink, blob, x + 120 * s, y - 85 * s)


def pencil_texture(ink: Image.Image, rng: random.Random, s: float) -> Image.Image:
    """Graphite: grainy strokes plus a low-frequency pressure field."""
    r, g, b, a = ink.split()
    grain = noise(ink.size, rng).point(lambda v: int(95 + v * 0.63))          # 95..255
    pressure = smooth_noise(ink.size, int(90 * s), rng).point(lambda v: int(clamp(205 + (v - 128) * 1.7, 105, 255)))
    a = ImageChops.multiply(ImageChops.multiply(a, grain), pressure)
    return Image.merge("RGBA", (r, g, b, a))


def scan(img: Image.Image, sh: Sheet, rng: random.Random) -> Image.Image:
    """Flat-bed scan look: slight skew (sharp, no blur) and optional seeded grain."""
    out = img.rotate(sh.skew, resample=BICUBIC, fillcolor=sh.paper.bed)
    if sh.grain:
        n = noise(out.size, rng).point(lambda v: int(128 + (v - 128) * sh.grain / 128))
        out = ImageChops.add(out, Image.merge("RGB", (n, n, n)), scale=1.0, offset=-128)
    return out


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def render_sheet(sh: Sheet, rubric: dict) -> list[Image.Image]:
    rng = random.Random(sh.seed)
    g = Geom.of(sh)
    hand = Hand(sh.style, sh.size, sh.ink, rng, g.s)
    pages = layout(sh, hand, g)
    cw, chh = sh.punnett_cell[0] * g.s, sh.punnett_cell[1] * g.s
    images = []
    for page_no, ops in enumerate(pages, start=1):
        hand.marks = {}
        paper = make_paper(sh, g, rng)
        ink = Image.new("RGBA", (g.W, g.H), (0, 0, 0, 0))
        fields = draw_header(paper, sh, g, rubric, page_no, len(pages))
        hand.text_at(ink, sh.student, *fields["name"])
        hand.text_at(ink, sh.roll_no, *fields["roll"])
        hand.text_at(ink, gs.EXAM_DATE, *fields["date"])
        notes, label_y = [], 0.0
        for op in ops:
            y = g.base_y(op.slot)
            if op.kind == "label":
                hand.text_at(ink, str(op.payload), op.x, y, flat=False)
                label_y = y
            elif op.kind == "text":
                hand.render_line(ink, op.payload, op.x + rng.uniform(-2, 5) * g.s, y,  # type: ignore[arg-type]
                                 insert_rise=sh.insert_rise * g.s if sh.insert_rise else None)
            elif op.kind == "punnett":
                skew = rng.uniform(-0.06, 0.06) + sh.style.slant * 0.5
                draw_punnett(ink, hand, op.payload, op.x, y - sh.size * 0.95, cw, chh, skew,  # type: ignore[arg-type]
                             sh.punnett_text)
            elif op.kind == "note":
                notes.append((op.payload, label_y))
        for note, ly in notes:
            draw_note(ink, hand, g, note, ly)
        for anchor in sh.smudges:
            if anchor in hand.marks:
                smudge(ink, hand, *hand.marks[anchor])
        if sh.pencil:
            ink = pencil_texture(ink, rng, g.s)
        ink = ink.filter(ImageFilter.GaussianBlur(sh.ink_soften * g.s))
        page = paper.convert("RGBA")
        page.alpha_composite(ink)
        images.append(scan(page.convert("RGB"), sh, rng))
    return images


def save_pdf_a4(pages: list[Image.Image], path: Path, quality: int = 90) -> None:
    doc = pymupdf.open()
    for img in pages:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=True)
        page = doc.new_page(width=595.28, height=595.28 * img.height / img.width)   # A4 width
        page.insert_image(page.rect, stream=buf.getvalue())
    fixed = "D:20261114000000Z"          # fixed dates + no random /ID keep the PDF byte-identical
    doc.set_metadata({"title": path.stem, "creator": "3iLens messy-handwriting test generator",
                      "producer": "PyMuPDF", "creationDate": fixed, "modDate": fixed})
    doc.save(str(path), garbage=3, deflate=True, no_new_id=True)
    doc.close()


def write_sheet(sh: Sheet, rubric: dict) -> Path:
    unknown = set(sh.answers) - {q["question"] for q in rubric["questions"]}
    if unknown:
        raise ValueError(f"{sh.filename}: unknown questions {sorted(unknown)}")
    pages = render_sheet(sh, rubric)
    out = OUT / sh.filename
    if sh.ext == "pdf":
        save_pdf_a4(pages, out)
    elif sh.ext == "png":
        pages[0].save(out, "PNG", optimize=True)
    elif sh.ext == "webp":
        pages[0].save(out, "WEBP", quality=90, method=6)
    else:
        pages[0].save(out, "JPEG", quality=90, optimize=True)
    return out


# --------------------------------------------------------------------------- #
# The six sheets
# --------------------------------------------------------------------------- #
BALLPOINT_BLUE = (22, 40, 128)
BLACK_GEL = (22, 22, 28)
BLUE_BLACK = (28, 30, 66)
FOUNTAIN_BLUE = (30, 56, 156)
GRAPHITE = (58, 60, 68)

Q1_SQ = gs.Punnett(cols=("T", "t"), rows=("t",), cells=(("Tt", "tt"),))
Q4_SQ = gs.Punnett(cols=("X^{c}", "Y"), rows=("X", "X^{c}"), cells=(("XX^{c}", "XY"), ("X^{c}X^{c}", "X^{c}Y")))

SHEETS: list[Sheet] = [
    # 01 mild - good student; rushed right-leaning hand, uneven baseline and letter size.
    # Planted: Q2 wrong incomplete-dominance example (pea flower colour), Q3 says 2nd generation
    # is still all hybrid and omits polymerase, Q5 calls it a Mendelian disorder.
    Sheet(
        nn=1, slug="mild_rushed_slant", ext="jpg", student="Ishaan Mehta", roll_no="NA07-052",
        style=Style(fonts=("Inkfree.ttf",), stroke=1, slant=0.24, slant_jitter=0.05, char_rot=2.0,
                    char_dy=0.035, char_scale=0.09, word_scale=0.09, word_rot=0.9, word_dy=0.03,
                    line_slope=(-0.5, 1.1), line_wave=0.09, word_space=(0.8, 1.35)),
        size=42, ink=BALLPOINT_BLUE, seed=101, W=1700, H=2200, skew=-0.4, grain=5,
        answers={
            1: ["Tt (tall) x tt (dwarf)", Q1_SQ,
                "Gametes : T, t and t",
                "Genotypic ratio - 1 Tt : 1 tt",
                "Phenotypic ratio - 1 tall : 1 dwarf",
                "This is a test cross, it shows whether the tall plant is homozygous or heterozygous."],
            2: ["Incomplete dominance - neither allele is completely dominant, so the heterozygote is "
                "intermediate between the two parents. Eg. flower colour in Mendel's garden pea, red x "
                "white gives pink.",
                "Codominance - both alleles express themselves fully in the hybrid. Eg. ABO blood group, "
                "I^{A}I^{B} gives AB."],
            3: ["Semi-conservative - each daughter DNA has one old (parent) strand and one new strand.",
                "Meselson and Stahl grew E. coli in ^{15}N medium and then moved it to ^{14}N, DNA was "
                "separated by CsCl density gradient centrifugation.",
                "After 1st generation the DNA was hybrid and after 2nd generation all the DNA was still hybrid."],
            4: ["Colour blind man = X^{c}Y", Q4_SQ,
                "Woman is normal but her father was colour blind so she is a carrier XX^{c}",
                "Daughters - 50% colour blind, 50% carrier",
                "Sons - 50% colour blind, 50% normal"],
            5: ["Down's syndrome is a Mendelian disorder caused by trisomy of chromosome 21 (47 chromosomes).",
                "Cause - non-disjunction of chromosome 21 during meiosis.",
                "Symptoms - short stature, furrowed tongue, partially open mouth, mental retardation."],
        },
    ),
    # 02 moderate - average student; condensed hand crammed onto the ruling, words run together,
    # scribbled cross-outs, overwritten corrections and an ink smudge across Q3.
    # Planted: Q2 codominance defined as blending, Q3 describes conservative replication and
    # "radioactive 32P", Q4 woman taken as XX (no carrier) so 0% colour blind.
    Sheet(
        nn=2, slug="cramped_crossouts_smudge", ext="png", student="Sneha Kulkarni", roll_no="NA07-061",
        style=Style(fonts=("mvboli.ttf",), slant=0.12, slant_jitter=0.05, char_rot=3.5, char_dy=0.05,
                    char_scale=0.1, word_scale=0.07, track=-0.05, track_jitter=0.05, squash=0.7,
                    word_space=(0.1, 0.5), word_rot=1.1, word_dy=0.05, line_slope=(-0.7, 0.7),
                    line_wave=0.08, strike="line", colour_jitter=8),
        size=44, ink=BLUE_BLACK, seed=202, W=1240, H=1754, rule_gap=50, answer_gap=0,
        label_fmt="{n})", skew=0.5, smudges=("smudge",), slack=20, punnett_cell=(110, 55),
        paper=Paper(tone=(247, 247, 244), rule=(150, 170, 200), margin=(205, 90, 100)),
        answers={
            1: ["Tt x tt -> ~~TT~~ Tt , tt",
                "genotypic ratio [[3:1|1:1]] (Tt:tt) phenotypic ratio 1 tall : 1 dwarf",
                "this is ##monohybrid## test cross"],
            2: ["Incomplete dominance - F1 is intermediate, neither allele is [[dominent|dominant]] eg ~~pea~~ "
                "Mirabilis jalapa red x white = pink, F2 1:2:1",
                "Codominance - the two alleles ~~mix~~ blend together and give an intermediate colour in "
                "F1. eg AB blood group (I^{A}I^{B})."],
            3: ["Semi conservative means the parent DNA stays together in one daughter molecule and the "
                "other @@smudge daughter molecule is fully new.",
                "Proved by Meselson & Stahl using radioactive ^{32}P and ~~ultra~~ centrifugation.",
                "Leading strand is continuous, lagging strand makes Okazaki fragments."],
            4: ["Man X^{c}Y x Woman XX",
                "gametes X^{c} , Y and X",
                "XX^{c} = daughters [[normal|carrier]] , XY = sons normal",
                "so 0% sons colour blind and 0% daughters colour blind, all daughters are carriers."],
            5: ["Down's syndrome - trisomy 21, extra chromosome 21 so total 47, due to non-disjunction "
                "during gamete formation (meiosis). Symptoms - flat face, small round head, ~~tall~~ "
                "short height, mental retardation, palm crease."],
        },
    ),
    # 03 cursive - strong student; connected script with heavy per-letter jitter.
    # Planted: Q3 isotopes reversed (14N first, then 15N) and Okazaki fragments on the leading
    # strand, Q5 lists "tall stature" as a symptom.
    Sheet(
        nn=3, slug="jittery_cursive", ext="webp", student="Rahul Deshpande", roll_no="NA07-066",
        style=Style(fonts=("FREESCPT.TTF",), stroke=1, slant=0.08, slant_jitter=0.05, char_rot=6.0,
                    char_dy=0.06, char_scale=0.13, word_scale=0.07, track=0.02, track_jitter=0.05,
                    word_rot=1.0, word_dy=0.03, line_slope=(-0.6, 0.6), line_wave=0.1),
        size=60, ink=FOUNTAIN_BLUE, seed=303, W=1700, H=2200, rule_gap=58, skew=0.25, grain=4,
        label_fmt="Ans {n}.", margin_x=160, punnett_cell=(140, 60), punnett_text=0.72,
        paper=Paper(tone=(250, 247, 236), rule=(170, 186, 214), margin=(214, 120, 120)),
        answers={
            1: ["Tt x tt (heterozygous tall x dwarf)", Q1_SQ,
                "Gametes T, t and t",
                "Genotypic ratio 1 Tt : 1 tt",
                "Phenotypic ratio 1 tall : 1 dwarf",
                "It is a test cross, used to find the genotype of the tall plant."],
            2: ["Incomplete dominance: the F1 shows an intermediate phenotype, eg. snapdragon red RR x "
                "white rr gives pink Rr.",
                "Codominance: both alleles express equally in the F1, eg. AB blood group I^{A}I^{B} in man."],
            3: ["Each daughter DNA has one parental strand and one new strand.",
                "Meselson and Stahl (1958) grew E. coli in ^{14}N, then transferred it to ^{15}N and used "
                "CsCl gradient centrifugation; hybrid DNA after one generation.",
                "Okazaki fragments are formed on the leading strand."],
            4: ["Man X^{c}Y, woman carrier XX^{c} (from her father).", Q4_SQ,
                "X^{c}Y x XX^{c}",
                "Daughters: 50% colour blind, 50% carrier",
                "Sons: 50% colour blind, 50% normal"],
            5: ["Chromosomal disorder - trisomy 21 (47 chromosomes) due to non-disjunction in meiosis.",
                "Symptoms: tall stature, broad palm with simian crease, mental retardation."],
        },
    ),
    # 04 tiny - top student who writes tiny, two writing lines per ruled gap, with insertions:
    # carets with words squeezed above the line and margin notes joined by arrows. Key content
    # lives ONLY in the insertions (Q1 "TEST cross", Q2 "ABO blood group", Q3 "Meselson & Stahl",
    # Q3 "old (parental)"). Planted: Q5 says non-disjunction during mitosis (meiosis expected).
    Sheet(
        nn=4, slug="tiny_margin_notes", ext="png", student="Ananya Reddy", roll_no="NA07-070",
        style=Style(fonts=("PRISTINA.TTF",), stroke=1, slant=-0.04, slant_jitter=0.03, char_rot=1.5,
                    char_dy=0.03, char_scale=0.06, word_scale=0.05, word_space=(0.7, 1.0), word_rot=0.6,
                    line_slope=(-0.25, 0.25), line_wave=0.05, colour_jitter=5),
        size=36, ink=BLACK_GEL, seed=404, W=2480, H=3508, rule_gap=55, pitch=0.5, margin_x=250,
        answer_gap=2, skew=-0.2, ink_soften=0.4, insert_rise=19, slack=40, punnett_cell=(80, 42),
        paper=Paper(tone=(252, 252, 250), rule=(165, 195, 225), margin=(225, 105, 105)),
        answers={
            1: ["Cross: Tt (heterozygous tall) x tt (dwarf). Gametes: T and t from the tall parent, only t "
                "from the dwarf parent.", Q1_SQ,
                "Offspring: Tt (tall) and tt (dwarf).",
                "Genotypic ratio 1 Tt : 1 tt, phenotypic ratio 1 tall : 1 dwarf.",
                "This is a @1 cross. The unknown plant is always crossed with the homozygous recessive "
                "parent, because tt can only give t gametes, so the offspring show directly which "
                "gametes the tall plant makes. If the tall plant were TT, all the offspring would be "
                "tall (Tt); half dwarf offspring means it was Tt.",
                Note("1", ("TEST cross -", "tells if a tall", "plant is TT", "or Tt"))],
            2: ["Incomplete dominance - neither allele is completely dominant so the heterozygote has an "
                "intermediate phenotype. Eg. snapdragon / Mirabilis: red RR x white rr -> pink Rr in F1; "
                "F2 ratio 1 red : 2 pink : 1 white (genotypic = phenotypic).",
                "Codominance - both alleles are expressed fully and at the same time in the heterozygote, "
                "no blending. Eg. @2 I^{A}I^{B} gives blood group AB (both A and B antigens on the RBC). "
                "Both I^{A} and I^{B} are dominant over i, so here dominance is complete for i but the "
                "two dominant alleles are codominant to each other; I^{A}I^{B} x I^{A}I^{B} gives "
                "1 A : 2 AB : 1 B.",
                Note("2", ("ABO blood", "group in man"))],
            3: ["Semi-conservative: the two strands separate and each acts as a template, so each daughter "
                "molecule has one <<old+(parental)>> strand and one newly synthesised strand.",
                "Proved by @3 - E. coli grown for many generations in ^{15}NH_{4}Cl (heavy), then shifted "
                "to ^{14}N medium; DNA separated by CsCl density gradient centrifugation. After 20 min "
                "(1 gen) all DNA hybrid ^{15}N/^{14}N, after 40 min (2 gen) half hybrid and half light.",
                "DNA polymerase adds nucleotides only 5'->3'; leading strand continuous, lagging strand "
                "discontinuous (Okazaki fragments joined by DNA ligase).",
                "Replication starts at the origin (ori); helicase unwinds the helix and forms a "
                "replication fork, and an RNA primer is needed before DNA polymerase III can start. "
                "Errors are proof-read, so replication is very accurate.",
                Note("3", ("Meselson &", "Stahl (1958)"))],
            4: ["Man is colour blind = X^{c}Y. Woman has normal vision but got X^{c} from her "
                "<<colour-blind>> father, so she is a carrier XX^{c}.", Q4_SQ,
                "Daughters: XX^{c} (carrier, normal) and X^{c}X^{c} (colour blind)",
                "-> 50% of daughters colour blind.",
                "Sons: XY normal and X^{c}Y colour blind -> 50% of sons colour blind.",
                "Overall 1/4 of all children are colour blind. Sons get their X only from the mother, "
                "which is why colour blindness shows criss-cross inheritance (grandfather -> "
                "carrier daughter -> grandson)."],
            5: ["Down's syndrome is a chromosomal disorder (aneuploidy) - trisomy of chromosome 21, so the "
                "person has 47 chromosomes (2n+1). Cause: non-disjunction of chromosome 21 during mitosis "
                "in the zygote.",
                "Symptoms: short stature, small round head, furrowed tongue, partially open mouth, broad "
                "palm with palm crease, mental retardation, congenital heart disease.",
                "Karyotype 47, XX, +21 or 47, XY, +21. Risk increases with the age of the mother; "
                "it can be detected before birth by amniocentesis."],
        },
    ),
    # 05 severe - weak student, severe scrawl: mixed letterforms, big size/rotation jitter,
    # overlapping letters, lines drifting down across the ruling. Short answers.
    # Planted: Q1 "back cross", Q3 credits Watson and Crick, Q4 all sons colour blind, Q5 no cause.
    Sheet(
        nn=5, slug="severe_scrawl", ext="jpg", student="Vikram Singh", roll_no="NA07-077",
        style=Style(fonts=("RAGE.TTF",), alt_fonts=("CHILLER.TTF", "Inkfree.ttf"), alt_prob=0.15, stroke=1,
                    slant=0.16, slant_jitter=0.12, char_rot=9.0, char_dy=0.09, char_scale=0.2,
                    word_scale=0.15, track=-0.08, track_jitter=0.07, word_space=(0.45, 1.5), word_rot=2.8,
                    word_dy=0.07, line_slope=(2.8, 4.2), line_wave=0.25, strike="scribble",
                    colour_jitter=5),
        size=58, ink=BLACK_GEL, seed=505, W=1700, H=2200, pitch=1.5, skew=0.8, grain=5,
        label_fmt="{n}", bottom_reserve=140, slack=120, punnett_cell=(120, 60),
        paper=Paper(tone=(246, 245, 240), rule=(160, 186, 220), margin=(220, 100, 100)),
        answers={
            1: ["Tt x tt = Tt , tt",
                "ratio 1 : 1 tall dwarf",
                "it is ~~test~~ back cross"],
            2: ["incomplete dominance - pink flower from red and white",
                "codominance - both genes show, AB blood"],
            3: ["DNA makes copy of itself, half old half new",
                "proved by Watson and Crick"],
            4: ["X^{c}Y x XX",
                "all sons colour blind, daughters normal"],
            5: ["extra chromosome 21, mongolism",
                "flat face, slanting eyes, mental retardation"],
        },
    ),
    # 06 faint pencil - capable student writing in light pencil with uneven pressure; some key
    # words are very faint. Two A4 pages scanned to a PDF.
    # Planted: Q4 says no daughter is colour blind, Q5 says 45 chromosomes.
    Sheet(
        nn=6, slug="faint_pencil", ext="pdf", student="Meera Pillai", roll_no="NA07-083",
        style=Style(fonts=("BRADHITC.TTF",), stroke=0, slant=0.03, slant_jitter=0.03, char_rot=2.0,
                    char_dy=0.03, char_scale=0.07, word_scale=0.06, word_rot=0.7, line_slope=(-0.5, 0.5),
                    line_wave=0.06, alpha=(115, 185), char_alpha=35, faint_prob=0.08,
                    faint_alpha=(62, 92), colour_jitter=6),
        size=44, ink=GRAPHITE, seed=606, W=1240, H=1754, rule_gap=62, pages=2,
        page_break_before=frozenset({4}),
        skew=-0.35, pencil=True, ink_soften=0.45, punnett_cell=(118, 58),
        paper=Paper(tone=(244, 243, 238), mottle=0.07, rule=(186, 200, 220), margin=(226, 150, 150),
                    bed=(230, 230, 228)),
        answers={
            1: ["Tt x tt", Q1_SQ,
                "Gametes - T, t and t",
                "Offspring - Tt tall and tt dwarf",
                "Genotypic ratio 1 : 1 (Tt : tt)",
                "Phenotypic ratio 1 tall : 1 dwarf",
                "This is called a `test cross."],
            2: ["Incomplete dominance - F1 hybrid has a phenotype in between the two parents (the genes "
                "do not mix). Eg. Snapdragon - red x white gives pink.",
                "Codominance - both the alleles express themselves in the F1. Eg. AB blood group in "
                "humans (I^{A}I^{B})."],
            3: ["In semi-conservative replication one strand of each new DNA is from the parent and the "
                "other strand is newly formed.",
                "Meselson and Stahl proved this using heavy nitrogen.",
                "Replication is continuous on the leading strand and discontinuous on the lagging strand "
                "`(Okazaki fragments)."],
            4: ["Man - X^{c}Y   Woman - XX^{c} (carrier)", Q4_SQ,
                "Sons - 50% colour blind",
                "Daughters - none are colour blind, 50% are carriers"],
            5: ["Down's syndrome is caused by an extra copy of chromosome 21 `(trisomy 21), total 45 "
                "chromosomes.",
                "It happens due to `non-disjunction during meiosis.",
                "Symptoms - small round head, flat nose, furrowed tongue and mental retardation."],
        },
    ),
]


def main(argv: list[str]) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rubric = json.loads(gs.RUBRIC_PATH.read_text(encoding="utf-8"))
    wanted = {int(a) for a in argv} if argv else None
    for sh in SHEETS:
        if wanted and sh.nn not in wanted:
            continue
        path = write_sheet(sh, rubric)
        print(f"  wrote {path.name:<52} {path.stat().st_size / 1024:8.0f} KB  {gs.verify(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
