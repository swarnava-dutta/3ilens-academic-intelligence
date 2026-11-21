"""Generate the "photo" category of synthetic answer sheets for 3iLens live tests.

Phone-photo / scanner capture conditions with neat-to-average handwriting, all answering
the Biology - Genetics paper (backend/rubrics/biology_genetics_v1.json, Q1..Q5).

    backend/.venv/Scripts/python.exe test-pages/generators/gen_photo.py

Writes test-pages/generated/photo/answer_sheet_photo_<NN>_<desc>.<ext>:

    01  720x960 low-res phone photo, mild tilt                      JPEG
    02  3024x4032 12-MP photo, desk, keystone, hand/phone shadow    JPEG
    03  uneven light, strong vignette, warm cast, crumpled + folds  WEBP
    04  heavy JPEG compression (q25) + slight motion smear          JPEG
    05  pixels stored sideways + EXIF Orientation=6                 JPEG
    06  flatbed scan fed upside down (180 deg), no EXIF, greyscale  PNG

Reuses samples/generate_samples.py (layout, header, Punnett squares, wobbly lines, verify)
without modifying it. Everything is seeded; no numpy - noise comes from random.Random
(Pillow's effect_noise uses the C rand() and is not seedable).
"""
from __future__ import annotations

import json
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps

sys.path.insert(0, r"H:\3ilens\samples")
import generate_samples as gs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "test-pages" / "generated" / "photo"
RUBRIC = json.loads((ROOT / "backend" / "rubrics" / "biology_genetics_v1.json").read_text(encoding="utf-8"))
W, H = gs.W, gs.H
BICUBIC = Image.Resampling.BICUBIC
LANCZOS = Image.Resampling.LANCZOS


# --------------------------------------------------------------------------- #
# Handwriting with per-character / per-word jitter
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Style:
    word_rot: float = 0.8           # sd of per-word rotation (deg)
    char_jit: float = 0.8           # per-character baseline jitter (px)
    char_size: float = 0.8          # per-character size jitter (px)
    track: float = 0.02             # per-character advance jitter (fraction)
    drift: float = 1.5              # baseline random-walk step per word (px)
    drift_max: float = 6.0
    slant: float = 0.0              # shear; >0 leans right
    spacing: tuple[float, float] = (0.85, 1.2)
    line_rot: float = 0.5           # max per-line rotation (deg)
    alpha: tuple[int, int] = (220, 250)
    char_alpha: int = 10            # ballpoint skips: per-char alpha jitter
    size_jit: int = 1               # per-word size jitter (px)
    tt_gap: float = 0.0             # extra gap between "tt" (fraction of size)


@dataclass
class PSheet(gs.Sheet):
    style: Style = field(default_factory=Style)
    paper: str = "blue"             # blue | grey | cream


class PHand(gs.Hand):
    def __init__(self, sheet: PSheet, size: int, rng: random.Random):
        super().__init__(sheet, size, rng)
        self.style = sheet.style

    def word_width(self, word, size=None):
        size = size or self.size
        total = 0.0
        for text, kind in word.segments:
            f = self.font(size if kind == "n" else size * 0.62)
            total += sum(f.getlength(ch) for ch in text)
            total += text.count("tt") * self.style.tt_gap * size
        return total

    def draw_word(self, draw, x, baseline, word, colour, size):
        st, rng = self.style, self.rng
        start = x
        r, g, b, a = colour
        for text, kind in word.segments:
            if kind == "n":
                fsize, y0 = size, baseline
            elif kind == "sup":
                fsize, y0 = size * 0.62, baseline - size * 0.42
            else:
                fsize, y0 = size * 0.62, baseline + size * 0.16
            adv_font = self.font(fsize)
            for k, ch in enumerate(text):
                if st.tt_gap and ch == "t" and k and text[k - 1] == "t":
                    x += st.tt_gap * size
                f = self.font(fsize + rng.uniform(-st.char_size, st.char_size))
                ca = max(120, min(255, a + rng.randint(-st.char_alpha, st.char_alpha)))
                draw.text((x, y0 + rng.uniform(-st.char_jit, st.char_jit)), ch, font=f,
                          fill=(r, g, b, ca), anchor="ls", stroke_width=self.stroke, stroke_fill=(r, g, b, ca))
                x += adv_font.getlength(ch) * rng.uniform(1 - st.track, 1 + st.track)
        if word.struck:
            mid = baseline - size * 0.30
            for k in range(2):
                tilt = rng.uniform(-6, 6)
                off = (k - 0.5) * size * 0.16
                draw.line([(start - 5, mid + off + tilt), (x + 5, mid + off - tilt)],
                          fill=colour, width=max(2, size // 13))
        return x - start

    def render_line(self, ink, words, x, baseline, size=None):
        size = size or self.size
        st, rng = self.style, self.rng
        pad = 30
        margin = int(st.drift_max) + 4
        hgt = int(size * 3.2) + 2 * margin
        base_local = int(size * 2.0) + margin
        est = sum(self.word_width(w, size + 2) for w in words) + self.space(size) * 1.4 * len(words)
        shear_pad = int(abs(st.slant) * hgt) + 10
        line = Image.new("RGBA", (int(est + 2 * pad + shear_pad + 40), hgt), (0, 0, 0, 0))
        colour = self.line_colour()
        cx, drift = float(pad), 0.0
        for w in words:
            wsize = size + rng.randint(-st.size_jit, st.size_jit)
            alpha = rng.randint(*st.alpha)
            wcan = Image.new("RGBA", (int(self.word_width(w, wsize + 2) + 2 * pad + 20), hgt - 2 * margin), (0, 0, 0, 0))
            wbase = base_local - margin
            adv = self.draw_word(ImageDraw.Draw(wcan), pad, wbase, w, (*colour, alpha), wsize)
            ang = rng.gauss(0, st.word_rot)
            if abs(ang) > 0.05:
                wcan = wcan.rotate(ang, resample=BICUBIC, center=(pad, wbase))
            drift = max(-st.drift_max, min(st.drift_max, drift * 0.7 + rng.uniform(-st.drift, st.drift)))
            line.alpha_composite(wcan, (max(0, int(cx - pad)), int(round(margin + drift))))
            cx += adv + self.space(size) * rng.uniform(*st.spacing)
        if st.slant:
            line = line.transform(line.size, Image.Transform.AFFINE,
                                  (1, st.slant, -st.slant * base_local, 0, 1, 0), resample=BICUBIC)
        line = line.rotate(rng.uniform(-st.line_rot, st.line_rot), resample=BICUBIC, center=(pad, base_local))
        ox = max(0, int(x - pad + rng.uniform(-3, 3)))
        oy = max(0, int(baseline - base_local + rng.uniform(-2.5, 2.5)))
        ink.alpha_composite(line, (ox, oy))


# --------------------------------------------------------------------------- #
# Seeded noise / fields (pure Python + Pillow)
# --------------------------------------------------------------------------- #
def noise_tile(rng: random.Random, size: tuple[int, int], sigma: float) -> Image.Image:
    im = Image.new("L", size)
    im.putdata([max(0, min(255, int(128 + rng.gauss(0, sigma)))) for _ in range(size[0] * size[1])])
    return im


def tiled_noise(rng: random.Random, size: tuple[int, int], sigma: float, tile: int = 384) -> Image.Image:
    t = noise_tile(rng, (tile, tile), sigma)
    variants = [t, t.transpose(Image.Transpose.FLIP_LEFT_RIGHT), t.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
                t.transpose(Image.Transpose.ROTATE_180)]
    out = Image.new("L", size)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            out.paste(rng.choice(variants), (x, y))
    return out


def add_grain(img: Image.Image, rng: random.Random, sigma: float, chroma: float = 0.0) -> Image.Image:
    n = tiled_noise(rng, img.size, sigma)
    if img.mode == "L":
        return ImageChops.add(img, n, offset=-128)
    if chroma:
        c = [tiled_noise(rng, img.size, chroma) for _ in range(3)]
        n3 = Image.merge("RGB", [ImageChops.add(n, ci, offset=-128) for ci in c])
    else:
        n3 = Image.merge("RGB", (n, n, n))
    return ImageChops.add(img, n3, offset=-128)


def smooth_noise(rng: random.Random, size: tuple[int, int], grid: tuple[int, int], sigma: float) -> Image.Image:
    return noise_tile(rng, grid, sigma).resize(size, BICUBIC)


def field(size: tuple[int, int], fn, grid: tuple[int, int] = (60, 80)) -> Image.Image:
    """L image from fn(u, v) -> 0..1 (u, v in [0, 1]), smoothly upscaled."""
    gw, gh = grid
    im = Image.new("L", grid)
    im.putdata([max(0, min(255, int(255 * fn(x / (gw - 1), y / (gh - 1))))) for y in range(gh) for x in range(gw)])
    return im.resize(size, BICUBIC)


def multiply_rgb(img: Image.Image, lum: Image.Image, tint=(1.0, 1.0, 1.0)) -> Image.Image:
    chans = [lum.point(lambda v, k=k: int(min(255, v * k))) for k in tint]
    return ImageChops.multiply(img, Image.merge("RGB", chans))


# --------------------------------------------------------------------------- #
# Paper
# --------------------------------------------------------------------------- #
PAPERS = {
    "blue": dict(tone=(251, 249, 242), rule=(158, 189, 226), margin=(222, 96, 96)),
    "grey": dict(tone=(247, 247, 245), rule=(170, 176, 186), margin=(214, 120, 128)),
    "cream": dict(tone=(250, 244, 228), rule=(150, 178, 210), margin=(205, 90, 90)),
}


def make_paper(rng: random.Random, kind: str) -> Image.Image:
    p = PAPERS[kind]
    mott = smooth_noise(rng, (W, H), (W // 14, H // 14), 22)
    paper = Image.merge("RGB", [mott.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * 0.05))))
                                for b in p["tone"]])
    d = ImageDraw.Draw(paper)
    for i in range(gs.N_LINES):
        y = gs.rule_y(i)
        d.line([(0, y), (W, y)], fill=p["rule"], width=2)
    d.line([(gs.MARGIN_X, 0), (gs.MARGIN_X, H)], fill=p["margin"], width=3)
    d.line([(gs.MARGIN_X + 6, 0), (gs.MARGIN_X + 6, H)], fill=tuple(min(255, c + 40) for c in p["margin"]), width=1)
    return paper


def render_pages(sheet: PSheet) -> list[Image.Image]:
    size = sheet.font_size
    while True:
        rng = random.Random(sheet.seed)
        hand = PHand(sheet, size, rng)
        try:
            pages = gs.layout(sheet, hand)
            break
        except gs.Overflow:
            if size <= 28:
                raise
            size -= 2
            print(f"  {sheet.filename}: shrinking handwriting to {size}px")
    out = []
    for page_no, ops in enumerate(pages, start=1):
        paper = make_paper(rng, sheet.paper)
        ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        gs.draw_header(paper, ink, hand, sheet, RUBRIC, page_no, len(pages))
        for op in ops:
            baseline = gs.rule_y(op.line) - 9
            if op.kind == "label":
                hand.text_at(ink, str(op.payload), op.x, baseline)
            elif op.kind == "text":
                hand.render_line(ink, op.payload, op.x + rng.uniform(-2, 4), baseline)
            elif op.kind == "punnett":
                gs.draw_punnett(ink, hand, op.payload, op.x, op.line)
        ink = ink.filter(ImageFilter.GaussianBlur(0.55))
        page = paper.convert("RGBA")
        page.alpha_composite(ink)
        out.append(page.convert("RGB"))
    return out


# --------------------------------------------------------------------------- #
# Camera geometry
# --------------------------------------------------------------------------- #
def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def perspective_coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """Coefficients for Image.transform(PERSPECTIVE): output point dst[i] samples source src[i]."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return _solve(a, b)


def rotate_quad(quad, deg, centre):
    cx, cy = centre
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in quad]


def place_paper(page: Image.Image, canvas: Image.Image, quad, shadow=(18, 26, 40, 0.55)) -> Image.Image:
    """Warp `page` onto `canvas` so its corners land on quad = [UL, UR, LR, LL] (output px)."""
    top = math.dist(quad[0], quad[1]); bottom = math.dist(quad[3], quad[2])
    scale = max(top, bottom) / page.width
    pw, ph = max(1, round(page.width * scale)), max(1, round(page.height * scale))
    src_img = page.resize((pw, ph), LANCZOS).convert("RGBA")
    coeffs = perspective_coeffs(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = src_img.transform(canvas.size, Image.Transform.PERSPECTIVE, coeffs, resample=BICUBIC,
                               fillcolor=(0, 0, 0, 0))
    alpha = warped.getchannel("A")
    dx, dy, blur, strength = shadow
    sh = ImageChops.offset(alpha, dx, dy).filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * strength))
    out = Image.composite(Image.new("RGB", canvas.size, (20, 16, 14)), canvas.convert("RGB"), sh)
    out.paste(warped.convert("RGB"), (0, 0), alpha)
    return out


def wood_desk(rng: random.Random, size, base=(118, 80, 50)) -> Image.Image:
    w, h = size
    streaks = noise_tile(rng, (max(8, w // 40), max(64, h // 3)), 40).resize(size, BICUBIC)
    blotch = smooth_noise(rng, size, (12, 16), 40)
    fine = tiled_noise(rng, size, 10)
    lum = ImageChops.add(ImageChops.add(streaks, blotch, scale=2.0), fine, scale=1.0, offset=-128)
    return Image.merge("RGB", [lum.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * 0.45)))) for b in base])


def laminate_desk(rng: random.Random, size, base=(176, 178, 170)) -> Image.Image:
    blotch = smooth_noise(rng, size, (10, 14), 30)
    speck = tiled_noise(rng, size, 14)
    lum = ImageChops.add(blotch, speck, scale=1.0, offset=-128)
    return Image.merge("RGB", [lum.point(lambda v, b=b: max(0, min(255, int(b + (v - 128) * 0.35)))) for b in base])


def hand_shadow_mask(size, rng: random.Random, corner="br", strength=0.5) -> Image.Image:
    """Soft shadow of a forearm + hand holding a phone, entering from one corner."""
    w, h = size
    k = 8
    sw, shh = w // k, h // k
    m = Image.new("L", (sw, shh), 0)
    d = ImageDraw.Draw(m)
    # Forearm from the bottom-right corner reaching up-left; palm + phone at its tip.
    ax, ay = sw * 1.10, shh * 1.02
    bx, by = sw * 0.64, shh * 0.66
    d.line([(ax, ay), (bx, by)], fill=255, width=int(sw * 0.20))
    d.ellipse([bx - sw * 0.12, by - shh * 0.08, bx + sw * 0.10, by + shh * 0.07], fill=255)
    for i in range(4):   # fingers
        fx = bx - sw * 0.10 + i * sw * 0.035
        d.line([(fx, by - shh * 0.02), (fx - sw * 0.05, by - shh * 0.11 + i * shh * 0.008)], fill=255,
               width=int(sw * 0.028))
    d.rectangle([bx - sw * 0.02, by - shh * 0.16, bx + sw * 0.11, by - shh * 0.04], fill=255)  # phone edge
    m = m.filter(ImageFilter.GaussianBlur(sw * 0.035)).resize(size, BICUBIC)
    if corner == "bl":
        m = m.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return m.point(lambda v: int(v * strength))


def apply_shadow(img: Image.Image, mask: Image.Image, colour=(18, 18, 30)) -> Image.Image:
    return Image.composite(Image.new("RGB", img.size, colour), img, mask)


def motion_smear(img: Image.Image, length: float, angle_deg: float, steps: int = 7) -> Image.Image:
    """Linear motion blur: average sub-pixel shifted copies along one direction."""
    t = math.radians(angle_deg)
    acc = None
    for i in range(steps):
        s = (i / (steps - 1) - 0.5) * length
        shifted = img.transform(img.size, Image.Transform.AFFINE, (1, 0, s * math.cos(t), 0, 1, s * math.sin(t)),
                                resample=Image.Resampling.BILINEAR, fillcolor=img.getpixel((2, 2)))
        acc = shifted if acc is None else Image.blend(acc, shifted, 1 / (i + 1))
    return acc


def crumple(page: Image.Image, rng: random.Random) -> Image.Image:
    """Folded-in-quarters + crumpled sheet: mesh warp, faceted shading, crease highlights."""
    w, h = page.size
    # 1. Mesh warp: displacement field from random facet tilts + steps across the folds.
    gx, gy = 17, 22
    disp = {}
    for j in range(gy + 1):
        for i in range(gx + 1):
            u, v = i / gx, j / gy
            dx = 3.5 * math.sin(6.1 * v + 1.3) * math.sin(4.3 * u) + rng.uniform(-1.6, 1.6)
            dy = 3.0 * math.sin(5.2 * u + 0.4) * math.cos(3.7 * v) + rng.uniform(-1.6, 1.6)
            dx += 2.5 if u > 0.5 else -2.5          # paper bulges at the vertical fold
            dy += 2.0 if v > 0.48 else -2.0
            if i in (0, gx):
                dx = 0
            if j in (0, gy):
                dy = 0
            disp[i, j] = (i * w / gx + dx, j * h / gy + dy)
    mesh = []
    for j in range(gy):
        for i in range(gx):
            box = (round(i * w / gx), round(j * h / gy), round((i + 1) * w / gx), round((j + 1) * h / gy))
            ul, ll, lr, ur = disp[i, j], disp[i, j + 1], disp[i + 1, j + 1], disp[i + 1, j]
            mesh.append((box, (*ul, *ll, *lr, *ur)))
    warped = page.transform(page.size, Image.Transform.MESH, mesh, resample=BICUBIC, fillcolor=(240, 236, 226))

    # 2. Facet shading: each region between creases catches the light differently.
    folds = [((0.5, 0.0), (0.503, 1.0)), ((0.0, 0.48), (1.0, 0.476)),
             ((0.0, 0.16), (0.42, 0.0)), ((0.62, 1.0), (1.0, 0.71)), ((0.08, 1.0), (0.30, 0.55))]
    gains = [rng.uniform(0.07, 0.12) for _ in folds]

    def shade(u, v):
        val = 0.93
        for ((x0, y0), (x1, y1)), g in zip(folds, gains):
            nx, ny = -(y1 - y0), (x1 - x0)
            nlen = math.hypot(nx, ny)
            sd = ((u - x0) * nx + (v - y0) * ny) / nlen
            val += g * math.tanh(sd / 0.05) * (0.6 + 0.4 * math.exp(-abs(sd) / 0.08))
        return max(0.0, min(1.0, val))

    lum = field((w, h), shade, grid=(85, 110))
    out = ImageChops.multiply(warped, Image.merge("RGB", (lum, lum, lum)))
    out = ImageChops.add(out, Image.merge("RGB", [lum.point(lambda v: max(0, v - 242) * 2)] * 3))

    # 3. Thin crease lines (dark valley + light ridge) and small crumple wrinkles.
    crease = Image.new("L", (w, h), 0)
    ridge = Image.new("L", (w, h), 0)
    dc, dr = ImageDraw.Draw(crease), ImageDraw.Draw(ridge)

    def wiggle(p0, p1, n=40, amp=3.0):
        pts = []
        for k in range(n + 1):
            t = k / n
            x = p0[0] + (p1[0] - p0[0]) * t + rng.uniform(-amp, amp)
            y = p0[1] + (p1[1] - p0[1]) * t + rng.uniform(-amp, amp)
            pts.append((x, y))
        return pts

    for (x0, y0), (x1, y1) in folds[:2]:
        pts = wiggle((x0 * w, y0 * h), (x1 * w, y1 * h))
        dc.line(pts, fill=150, width=3)
        dr.line([(x + 4, y + 4) for x, y in pts], fill=110, width=3)
    for (x0, y0), (x1, y1) in folds[2:]:
        pts = wiggle((x0 * w, y0 * h), (x1 * w, y1 * h), amp=4)
        dc.line(pts, fill=95, width=2)
        dr.line([(x + 3, y + 3) for x, y in pts], fill=70, width=2)
    for _ in range(26):           # short wrinkles
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        ang = rng.uniform(0, math.pi)
        ln = rng.uniform(60, 260)
        pts = wiggle((x, y), (x + ln * math.cos(ang), y + ln * math.sin(ang)), n=8, amp=5)
        dc.line(pts, fill=rng.randint(40, 80), width=2)
        dr.line([(px + 3, py + 2) for px, py in pts], fill=rng.randint(30, 60), width=2)
    crease = crease.filter(ImageFilter.GaussianBlur(1.6))
    ridge = ridge.filter(ImageFilter.GaussianBlur(2.0))
    out = Image.composite(Image.new("RGB", (w, h), (92, 84, 74)), out, crease)
    out = Image.composite(Image.new("RGB", (w, h), (255, 255, 250)), out, ridge)
    return out


def phone_finish(img: Image.Image, rng: random.Random, lens_blur=0.6, sharpen=True, grain=6.0,
                 chroma=2.5) -> Image.Image:
    if lens_blur:
        img = img.filter(ImageFilter.GaussianBlur(lens_blur))
    if sharpen:
        img = img.filter(ImageFilter.UnsharpMask(radius=2.2, percent=70, threshold=2))
    return add_grain(img, rng, grain, chroma)


# --------------------------------------------------------------------------- #
# Answer content (Genetics paper, Q1..Q5)
# --------------------------------------------------------------------------- #
BLUE_BALLPOINT = (26, 46, 140)
BLACK_GEL = (24, 24, 30)
BLUE_BLACK = (28, 34, 70)
ROYAL_BLUE = (32, 58, 160)
DARK_BLUE = (22, 38, 118)

Q1_SQ = gs.Q1_PUNNETT
Q4_SQ = gs.Q4_PUNNETT
Q1_WRONG_SQ = gs.Punnett(cols=("T", "t"), rows=("T", "t"), cells=(("TT", "Tt"), ("Tt", "tt")), cell_w=112)

SHEETS: list[tuple[PSheet, str]] = [
    # 01 - average student (~13/20). Neat Tempus Sans hand, blue ballpoint, low-res photo.
    (PSheet(
        filename="answer_sheet_photo_01_lowres_720x960_tilt.jpg",
        student="Ishaan Gupta", roll_no="NA07-052",
        font_files=("TEMPSITC.TTF",), font_size=44, stroke=1, ink=BLUE_BALLPOINT, seed=101,
        style=Style(word_rot=0.9, char_jit=1.0, drift=1.8, slant=0.05, char_alpha=18), paper="blue",
        answers={
            1: ["Tt x tt", "Gametes: T, t and t", Q1_SQ,
                "Offspring: Tt (tall) and tt (dwarf)",
                "Genotypic ratio 1 : 1 and phenotypic ratio 1 tall : 1 dwarf",
                "It is called a test cross."],
            2: ["Incomplete dominance - F1 hybrid shows an intermediate character, eg. red x white "
                "snapdragon gives pink flowers.",
                "Codominance - both alleles blend together and give a mixed phenotype. Eg. AB blood group."],
            3: ["Semi-conservative means each daughter DNA has one old strand and one new strand.",
                "Proved by Meselson and Stahl using ^{32}P and ^{35}S labelled ~~viruses~~ bacteria."],
            4: ["Man = X^{c}Y, woman = XX^{c} (carrier, as her father was colour blind)",
                "X^{c}Y x XX^{c}", "Sons: 50% colour blind, 50% normal",
                "Daughters: all are carriers, none are colour blind."],
            5: ["Down's syndrome is due to trisomy of chromosome 21 (47 chromosomes).",
                "Symptoms: mental retardation, flat face, short height."],
        }), "lowres"),
    # 02 - strong student (~18/20). Neat Segoe Print, black gel, 12-MP photo.
    (PSheet(
        filename="answer_sheet_photo_02_12mp_keystone_hand_shadow.jpg",
        student="Meera Krishnan", roll_no="NA07-058",
        font_files=("segoepr.ttf",), font_size=36, ink=BLACK_GEL, seed=202,
        style=Style(word_rot=0.5, char_jit=0.5, char_size=0.5, drift=1.0, char_alpha=4, alpha=(236, 252)),
        paper="blue",
        answers={
            1: ["Tt (heterozygous tall) x tt (dwarf)", Q1_SQ, "Gametes: T, t and t",
                "Genotypic ratio = 1 Tt : 1 tt", "Phenotypic ratio = 1 tall : 1 dwarf",
                "It is a test cross - used to find out if a tall plant is TT or Tt."],
            2: ["Incomplete dominance: the heterozygote shows an intermediate phenotype as neither "
                "allele is completely dominant. Eg. Mirabilis jalapa - RR (red) x rr (white) gives Rr "
                "(pink); F2 1 : 2 : 1.",
                "Codominance: both alleles express themselves fully in the heterozygote. "
                "Eg. I^{A}I^{B} gives AB blood group."],
            3: ["Each daughter DNA keeps one parental strand and one newly synthesised strand.",
                "Meselson and Stahl (1958): E. coli grown in ^{15}NH_{4}Cl, then moved to ^{14}N; "
                "DNA separated by CsCl density gradient centrifugation.",
                "Gen 1 - all hybrid DNA. Gen 2 - all DNA was light.",
                "DNA polymerase works 5'->3'; Okazaki fragments on the lagging strand."],
            4: ["Man X^{c}Y; woman is a carrier XX^{c} because her father gave her X^{c}.", Q4_SQ,
                "X^{c}Y x XX^{c}", "Daughters: 50% colour blind (X^{c}X^{c}), 50% carriers",
                "Sons: 50% colour blind (X^{c}Y), 50% normal"],
            5: ["Chromosomal disorder (aneuploidy) - trisomy 21, i.e. 47 chromosomes.",
                "Cause: non-disjunction of chromosome 21 during ~~meiosis~~ mitosis.",
                "Symptoms: short stature, furrowed tongue, palm crease, mental retardation."],
        }), "keystone"),
    # 03 - weak-average student (~9/20). Bradley Hand, blue-black, crumpled + warm light.
    (PSheet(
        filename="answer_sheet_photo_03_crumpled_vignette_warm.webp",
        student="Sahil Khan", roll_no="NA07-061",
        font_files=("BRADHITC.TTF",), font_size=44, stroke=1, ink=BLUE_BLACK, seed=303,
        style=Style(word_rot=1.2, char_jit=1.4, char_size=1.2, drift=2.2, slant=-0.04, char_alpha=12),
        paper="cream",
        answers={
            1: ["Tt x tt", Q1_WRONG_SQ, "Offsprings - TT, Tt, Tt, tt",
                "Ratio = 3 tall : 1 dwarf", "It is a test cross."],
            2: ["Incomplete dominance - both alleles are expressed fully in the F1. Eg. AB blood group.",
                "Codominance - the F1 is in between the two parents. Eg. pink flower of snapdragon."],
            3: ["Semi-conservative - the old DNA stays together and the new DNA is made ~~fully~~ "
                "separately from it.",
                "Meselson and Stahl proved it with ^{15}N."],
            4: ["Man X^{c}Y, woman XX (normal)", "All sons are normal and all daughters are carriers."],
            5: ["It is a chromosomal disorder - trisomy 21 (one extra chromosome 21).",
                "Caused by non-disjunction during meiosis.",
                "Symptoms - flat face, mental retardation, palm crease."],
        }), "crumpled"),
    # 04 - average student (~12/20). Lucida Handwriting, royal blue, heavy JPEG + motion smear.
    (PSheet(
        filename="answer_sheet_photo_04_compressed_q25_motion.jpg",
        student="Ananya Reddy", roll_no="NA07-066",
        font_files=("LHANDW.TTF",), font_size=31, ink=ROYAL_BLUE, seed=404,
        style=Style(word_rot=0.9, char_jit=1.0, drift=1.6, slant=0.03, char_alpha=14), paper="grey",
        answers={
            1: ["Tt x tt  ->  Tt, tt", "Genotypic ratio 1 Tt : 1 tt",
                "Phenotypic ratio 1 tall : 1 dwarf", "This cross is called a back cross."],
            2: ["Incomplete dominance - neither allele is completely dominant so the F1 is intermediate. "
                "Eg. Mirabilis jalapa red x white gives pink.",
                "Codominance - both alleles show their effect together. Eg. pink flowers in pea plant."],
            3: ["Each new DNA molecule has one old (parental) strand and one new strand.",
                "Meselson and Stahl grew E. coli in ^{15}N and then in ^{14}N, and separated the DNA by "
                "CsCl density gradient centrifugation - after one generation all DNA was hybrid."],
            4: ["Man = X^{c}Y, woman = XX^{c} (her father was colour blind so she is a carrier)",
                "Gametes X^{c}, Y and X, X^{c}",
                "So 1/4 of the sons are colour blind and 1/4 of the daughters are colour blind."],
            5: ["Trisomy 21 - 47 chromosomes, due to non-disjunction of chromosome 21.",
                "Symptom - mental retardation."],
        }), "compressed"),
    # 05 - good student (~15/20) who confuses Down's with Klinefelter's. Kristen ITC, dark blue.
    (PSheet(
        filename="answer_sheet_photo_05_exif_orientation6.jpg",
        student="Rahul Menon", roll_no="NA07-073",
        font_files=("ITCKRIST.TTF",), font_size=33, ink=DARK_BLUE, seed=505,
        style=Style(word_rot=0.8, char_jit=0.9, drift=1.5, char_alpha=8), paper="blue",
        answers={
            1: ["Tt x tt", Q1_SQ, "Tt (tall) : tt (dwarf)", "Genotypic ratio 1 : 1, phenotypic ratio 1 : 1",
                "This is a monohybrid cross."],
            2: ["Incomplete dominance - F1 shows a blend / intermediate phenotype because no allele is "
                "fully dominant, eg. pink snapdragon from red x white.",
                "Codominance - both alleles are equally expressed in the heterozygote, eg. AB blood "
                "group (I^{A}I^{B})."],
            3: ["Each daughter DNA has one parental strand and one new strand.",
                "Meselson and Stahl: ^{15}N then ^{14}N medium, CsCl density gradient - hybrid DNA after "
                "one generation.",
                "Leading strand is continuous, lagging strand is made as Okazaki fragments."],
            4: ["Man X^{c}Y, woman carrier XX^{c} (gets X^{c} from her father)", Q4_SQ,
                "Sons - 50% colour blind", "Daughters - 50% colour blind, 50% carriers"],
            5: ["Down's syndrome is due to an extra X chromosome (44 + XXY).",
                "Symptoms - tall, sterile, mental retardation."],
        }), "exif6"),
    # 06 - weak student (~6/20), Q3 not attempted. Segoe Script, black, upside-down greyscale scan.
    (PSheet(
        filename="answer_sheet_photo_06_upside_down_scan.png",
        student="Pooja Yadav", roll_no="NA07-079",
        font_files=("segoesc.ttf",), font_size=34, ink=BLACK_GEL, seed=606,
        style=Style(word_rot=0.7, char_jit=0.6, char_size=0.5, drift=1.4, slant=0.03, char_alpha=6, tt_gap=0.32),
        paper="blue",
        answers={
            1: ["Tt x tt", "All the offspring will be tall because T is dominant over t."],
            2: ["Incomplete dominance - the dominant allele does not express fully so the F1 is "
                "intermediate, eg. pink four o'clock flower.",
                "Codominance - ~~same~~"],
            4: ["Man = XY^{c}, woman = XX^{c}", "All daughters are colour blind and all sons are normal."],
            5: ["Trisomy 21 - an extra chromosome 21.",
                "Symptoms - mental retardation, furrowed tongue, short stature."],
        }), "scan180"),
]


# --------------------------------------------------------------------------- #
# Capture effects (one per sheet)
# --------------------------------------------------------------------------- #
def capture_lowres(page, rng):
    """01: 720x960 phone photo, paper fills most of the frame, ~2.5 deg tilt, dim indoor light."""
    big = (1440, 1920)
    desk = laminate_desk(rng, big, base=(150, 146, 136))
    quad = [(95, 120), (1330, 100), (1360, 1810), (80, 1835)]
    quad = rotate_quad(quad, 2.4, (720, 960))
    img = place_paper(page, desk, quad, shadow=(10, 14, 22, 0.5))
    lum = field(big, lambda u, v: 0.80 + 0.14 * u - 0.10 * (v - 0.5) ** 2)
    img = multiply_rgb(img, lum, (1.0, 0.98, 0.93))
    img = img.resize((720, 960), LANCZOS)
    img = phone_finish(img, rng, lens_blur=0.45, sharpen=True, grain=5.0, chroma=2.0)
    return img


def capture_keystone(page, rng):
    """02: 3024x4032, wooden desk, strong keystone trapezoid, forearm + phone shadow on a corner."""
    size = (3024, 4032)
    desk = wood_desk(rng, size)
    quad = [(470, 360), (2560, 410), (2905, 3810), (120, 3760)]
    img = place_paper(page, desk, quad, shadow=(24, 34, 50, 0.6))
    lum = field(size, lambda u, v: 0.78 + 0.18 * (1 - v) + 0.06 * u)
    img = multiply_rgb(img, lum, (1.0, 0.985, 0.95))
    img = apply_shadow(img, hand_shadow_mask(size, rng, "br", strength=0.52), colour=(22, 20, 32))
    img = ImageEnhance.Contrast(img).enhance(1.05)
    return phone_finish(img, rng, lens_blur=1.0, sharpen=True, grain=5.0, chroma=2.0)


def capture_crumpled(page, rng):
    """03: crumpled + folded sheet under a warm desk lamp, heavy vignette, dark surround."""
    page = crumple(page, rng)
    size = (1800, 2400)
    bg = laminate_desk(rng, size, base=(70, 58, 46))
    quad = [(85, 95), (1735, 140), (1720, 2330), (60, 2290)]
    img = place_paper(page, bg, quad, shadow=(14, 20, 30, 0.6))

    def light(u, v):     # lamp at upper right, falls off strongly to lower left
        d2 = ((u - 0.85) / 0.9) ** 2 + ((v - 0.1) / 1.0) ** 2
        r2 = ((u - 0.5) * 2) ** 2 + ((v - 0.5) * 2) ** 2
        vign = 1.0 - 0.25 * r2 ** 1.5
        return max(0.0, min(1.0, (1.12 - 0.62 * d2) * vign))

    lum = field(size, light)
    img = multiply_rgb(img, lum, (1.0, 0.84, 0.62))     # tungsten cast
    glare = field(size, lambda u, v: 0.42 * math.exp(-(((u - 0.80) / 0.16) ** 2 + ((v - 0.22) / 0.12) ** 2)))
    img = Image.composite(Image.new("RGB", size, (255, 246, 222)), img, glare)   # lamp glare on the paper
    img = ImageEnhance.Color(img).enhance(1.12)
    return phone_finish(img, rng, lens_blur=0.7, sharpen=True, grain=7.0, chroma=3.0)


def capture_compressed(page, rng):
    """04: 1200x1600 handheld shot with a little shake, then re-shared at JPEG quality 25."""
    size = (1200, 1600)
    desk = wood_desk(rng, size, base=(150, 110, 74))
    quad = [(70, 85), (1140, 70), (1150, 1525), (55, 1540)]
    quad = rotate_quad(quad, -1.2, (600, 800))
    img = place_paper(page, desk, quad, shadow=(8, 12, 16, 0.5))
    lum = field(size, lambda u, v: 0.86 + 0.10 * v - 0.06 * u)
    img = multiply_rgb(img, lum, (0.98, 1.0, 1.0))
    img = motion_smear(img, length=4.5, angle_deg=18)
    return phone_finish(img, rng, lens_blur=0.0, sharpen=False, grain=4.0, chroma=1.5)


def capture_exif6(page, rng):
    """05: ordinary 1536x2048 phone photo; the caller stores it sideways + EXIF Orientation=6."""
    size = (1536, 2048)
    desk = laminate_desk(rng, size, base=(196, 194, 188))
    quad = [(105, 120), (1440, 98), (1458, 1950), (88, 1968)]
    quad = rotate_quad(quad, 0.8, (768, 1024))
    img = place_paper(page, desk, quad, shadow=(12, 16, 24, 0.45))
    lum = field(size, lambda u, v: 0.83 + 0.12 * (1 - u) + 0.04 * v)
    img = multiply_rgb(img, lum, (0.97, 0.99, 1.0))
    return phone_finish(img, rng, lens_blur=0.6, sharpen=True, grain=5.0, chroma=2.0)


def capture_scan180(page, rng):
    """06: 150-dpi greyscale flatbed scan, page fed upside down, slight skew, lid shadow, dust."""
    size = (1275, 1650)
    img = page.resize(size, LANCZOS).rotate(0.6, resample=BICUBIC, fillcolor=(250, 250, 250))
    g = img.convert("L")
    g = g.point(lambda v: max(0, min(255, int((v - 35) * 255 / (222 - 35)))))   # scanner levels
    # Lid not fully closed along the right edge: grey gradient band.
    band = field(size, lambda u, v: max(0.0, (u - 0.93) / 0.07) ** 1.6 * 0.55, grid=(80, 20))
    g = Image.composite(Image.new("L", size, 70), g, band)
    d = ImageDraw.Draw(g)
    for _ in range(70):     # dust specks and a couple of hairs
        x, y = rng.uniform(0, size[0]), rng.uniform(0, size[1])
        r = rng.uniform(0.6, 1.8)
        d.ellipse([x - r, y - r, x + r, y + r], fill=rng.randint(40, 120))
    for _ in range(2):
        x, y = rng.uniform(100, size[0] - 100), rng.uniform(100, size[1] - 100)
        a0, pts = rng.uniform(0, math.pi), []
        for k in range(30):
            a0 += rng.uniform(-0.25, 0.25)
            x, y = x + 5 * math.cos(a0), y + 5 * math.sin(a0)
            pts.append((x, y))
        d.line(pts, fill=150, width=1)
    g = add_grain(g, rng, 3.0)
    return g.rotate(180)


CAPTURES = {"lowres": capture_lowres, "keystone": capture_keystone, "crumpled": capture_crumpled,
            "compressed": capture_compressed, "exif6": capture_exif6, "scan180": capture_scan180}


def save(img: Image.Image, path: Path, kind: str) -> None:
    if kind == "lowres":
        img.save(path, "JPEG", quality=78, optimize=True)
    elif kind == "keystone":
        img.save(path, "JPEG", quality=90, optimize=True, subsampling=2)
    elif kind == "crumpled":
        img.save(path, "WEBP", quality=82, method=6)
    elif kind == "compressed":
        img.save(path, "JPEG", quality=25)
    elif kind == "exif6":
        stored = img.rotate(90, expand=True)         # pixels sideways (90 deg CCW)
        exif = Image.Exif()
        exif[0x0112] = 6                             # viewer must rotate 90 deg CW to show upright
        exif[0x0131] = "3iLens test-page generator"  # Software
        stored.save(path, "JPEG", quality=88, optimize=True, exif=exif.tobytes())
    elif kind == "scan180":
        img.save(path, "PNG", optimize=True)
    else:
        raise ValueError(kind)


def main(argv: list[str]) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    preview = "--preview" in argv
    only = [a for a in argv if not a.startswith("--")]
    for sheet, kind in SHEETS:
        if only and not any(o in sheet.filename for o in only):
            continue
        pages = render_pages(sheet)
        assert len(pages) == 1
        img = CAPTURES[kind](pages[0], random.Random(sheet.seed * 7 + 1))
        path = OUT_DIR / sheet.filename
        save(img, path, kind)
        info = gs.verify(path)
        with Image.open(path) as im:
            orient = im.getexif().get(0x0112)
            upright = ImageOps.exif_transpose(im)
            info += f" | EXIF orientation={orient} -> upright {upright.width}x{upright.height}" if orient else ""
            if preview:
                run = ROOT / ".run" / "photo_preview"
                run.mkdir(parents=True, exist_ok=True)
                upright.convert("RGB").save(run / (path.stem + "_upright.jpg"), quality=90)
        mb = path.stat().st_size / 1e6
        assert mb <= 18, f"{path.name} is {mb:.1f} MB"
        print(f"  wrote {path.name:<52} {mb:6.2f} MB  {info}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
