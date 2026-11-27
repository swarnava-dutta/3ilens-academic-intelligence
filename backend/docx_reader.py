"""Typed Word (.docx) answer sheets and rubric sources - stdlib zipfile + xml.etree only.

validate_docx() is the security gate (zip sanity, size/entry caps, real WordprocessingML,
no macros). docx_text() extracts plain text (rubric parsing), numbered_text() the same with Word's
automatic list numbers written out (answer keys); docx_to_html() produces simple
escaped HTML + embedded images, which preprocessing renders to PDF so typed sheets take the
same vision route as scans (no separate text path).
"""
from __future__ import annotations

import html
import io
import posixpath
import re
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
V_NS = "urn:schemas-microsoft-com:vml"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

DOCX_MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
MACRO_MARKERS = ("macroenabled", "vbaproject", "vbadata", "ms-office.activex")

MAX_UNCOMPRESSED = 50 * 1024 * 1024
MAX_ENTRIES = 2000


class DocxError(ValueError):
    """Rejected .docx. code: 'corrupt_docx' | 'macro_docx' | 'docx_too_large'."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def _w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


def _open(data: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        raise DocxError("The Word document could not be opened - it may be corrupt.", "corrupt_docx") from exc


MACRO_MAIN_TYPE = "application/vnd.ms-word.document.macroenabled.main+xml"


def package_kind(data: bytes) -> str:
    """'docx' (declares a Word main document, macro-enabled included), 'zip' (a valid ZIP that is
    not a Word document, e.g. .xlsx or a plain archive) or 'corrupt' (not a readable ZIP).
    Upload sniffing uses it to answer 415 for other zips and 422 for broken Word files."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError):
        return "corrupt"
    with archive:
        try:
            if "[Content_Types].xml" not in archive.namelist():
                return "zip"
            content_types = ET.fromstring(archive.read("[Content_Types].xml"))
        except (ET.ParseError, KeyError, zipfile.BadZipFile, RuntimeError, OSError, ValueError):
            return "corrupt"
    declared = {
        (el.get("ContentType") or "").lower()
        for el in content_types.iter()
        if el.tag in (f"{{{CT_NS}}}Override", f"{{{CT_NS}}}Default")
    }
    return "docx" if DOCX_MAIN_TYPE in declared or MACRO_MAIN_TYPE in declared else "zip"


def validate_docx(data: bytes, *, max_uncompressed: int = MAX_UNCOMPRESSED, max_entries: int = MAX_ENTRIES) -> None:
    """Raise DocxError unless `data` is a sane, macro-free WordprocessingML document."""
    with _open(data) as archive:
        infos = archive.infolist()
        if len(infos) > max_entries:
            raise DocxError(f"The Word document has too many parts ({len(infos)}).", "docx_too_large")
        if sum(max(0, info.file_size) for info in infos) > max_uncompressed:
            raise DocxError(
                f"The Word document expands to more than {max_uncompressed // (1024 * 1024)} MB.", "docx_too_large"
            )
        names = {info.filename for info in infos}
        lowered = {name.lower() for name in names}
        if any(name.endswith("vbaproject.bin") for name in lowered):
            raise DocxError("Macro-enabled Word documents are not accepted.", "macro_docx")
        if "[Content_Types].xml" not in names:
            raise DocxError("The file is not a Word document (no content types).", "corrupt_docx")
        try:
            content_types = ET.fromstring(archive.read("[Content_Types].xml"))
        except (ET.ParseError, KeyError, zipfile.BadZipFile, RuntimeError) as exc:
            raise DocxError("The Word document's content types are unreadable.", "corrupt_docx") from exc
        declared = [
            (el.get("ContentType") or "").lower()
            for el in content_types.iter()
            if el.tag in (f"{{{CT_NS}}}Override", f"{{{CT_NS}}}Default")
        ]
        if any(marker in ct for ct in declared for marker in MACRO_MARKERS):
            raise DocxError("Macro-enabled Word documents are not accepted.", "macro_docx")
        if DOCX_MAIN_TYPE not in declared:
            raise DocxError("The file is not a Word (.docx) document.", "corrupt_docx")
        if "word/document.xml" not in names:
            raise DocxError("The Word document has no main body (word/document.xml).", "corrupt_docx")
        try:
            ET.fromstring(archive.read("word/document.xml"))
        except (ET.ParseError, zipfile.BadZipFile, RuntimeError, OSError) as exc:
            raise DocxError("The Word document body is corrupt.", "corrupt_docx") from exc


# --------------------------------------------------------------------------- #
# Text extraction
# --------------------------------------------------------------------------- #
def _document(archive: zipfile.ZipFile) -> ET.Element:
    try:
        root = ET.fromstring(archive.read("word/document.xml"))
    except (KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
        raise DocxError("The Word document body is corrupt.", "corrupt_docx") from exc
    body = root.find(_w("body"))
    if body is None:
        raise DocxError("The Word document has no body.", "corrupt_docx")
    return body


def _run_text(element: ET.Element) -> str:
    parts: list[str] = []
    for node in element.iter():
        if node.tag == _w("t"):
            parts.append(node.text or "")
        elif node.tag == _w("tab"):
            parts.append("\t")
        elif node.tag in (_w("br"), _w("cr")):
            parts.append("\n")
    return "".join(parts)


def _paragraph_text(paragraph: ET.Element) -> str:
    return _run_text(paragraph).strip()


def _cell_text(cell: ET.Element) -> str:
    return " ".join(t for t in (_paragraph_text(p) for p in cell.iter(_w("p"))) if t)


def _table_rows(table: ET.Element) -> list[list[str]]:
    rows = []
    for row in table.findall(_w("tr")):
        rows.append([_cell_text(cell) for cell in row.findall(_w("tc"))])
    return rows


def docx_text(data: bytes) -> str:
    """Plain text: one line per paragraph; table rows as ' | '-separated cells."""
    with _open(data) as archive:
        body = _document(archive)
        lines: list[str] = []
        for child in body:
            if child.tag == _w("p"):
                lines.append(_paragraph_text(child))
            elif child.tag == _w("tbl"):
                lines.extend(" | ".join(cells) for cells in _table_rows(child))
    return _joined(lines)


def _joined(lines: list[str]) -> str:
    """The lines as one text, runs of blank lines collapsed."""
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


_ROMAN = ((1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"),
          (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i"))


def _list_label(value: int, number_format: str) -> str | None:
    if number_format in ("decimal", "decimalZero"):
        return str(value)
    if number_format in ("lowerLetter", "upperLetter") and 1 <= value <= 26:
        letter = chr(ord("a") + value - 1)
        return letter if number_format == "lowerLetter" else letter.upper()
    if number_format in ("lowerRoman", "upperRoman") and 1 <= value < 4000:
        roman = ""
        for amount, digits in _ROMAN:
            while value >= amount:
                roman += digits
                value -= amount
        return roman if number_format == "lowerRoman" else roman.upper()
    return None


def _list_levels(numbering: ET.Element) -> dict[str, dict[int, tuple[int, str, str]]]:
    """numId -> ilvl -> (start, numFmt, lvlText) from word/numbering.xml."""
    w = _w
    abstract: dict[str | None, dict[int, tuple[int, str, str]]] = {}
    for definition in numbering.findall(w("abstractNum")):
        levels: dict[int, tuple[int, str, str]] = {}
        for level in definition.findall(w("lvl")):
            ilvl = int(level.get(w("ilvl"), "0") or 0)
            start, fmt, text = level.find(w("start")), level.find(w("numFmt")), level.find(w("lvlText"))
            levels[ilvl] = (
                int(start.get(w("val"), "1")) if start is not None else 1,
                fmt.get(w("val"), "decimal") if fmt is not None else "decimal",
                text.get(w("val"), f"%{ilvl + 1}.") if text is not None else f"%{ilvl + 1}.",
            )
        abstract[definition.get(w("abstractNumId"))] = levels
    nums: dict[str, dict[int, tuple[int, str, str]]] = {}
    for num in numbering.findall(w("num")):
        reference = num.find(w("abstractNumId"))
        levels = dict(abstract.get(reference.get(w("val")) if reference is not None else None, {}))
        for override in num.findall(w("lvlOverride")):
            start = override.find(w("startOverride"))
            ilvl = int(override.get(w("ilvl"), "0") or 0)
            if start is not None and ilvl in levels:
                levels[ilvl] = (int(start.get(w("val"), "1")), *levels[ilvl][1:])
        nums[num.get(w("numId"), "")] = levels
    return nums


def numbered_text(data: bytes) -> str | None:
    """docx_text with Word's automatic list numbers written out ("1.", "(a)"): a typed
    key or paper whose numbers come from a numbered list has them only in word/numbering.xml.
    None when no paragraph is numbered (docx_text is used)."""
    w = _w
    with _open(data) as archive:
        body = _document(archive)
        if body.find(f".//{w('numPr')}") is None:
            return None
        try:
            levels = _list_levels(ET.fromstring(archive.read("word/numbering.xml")))
        except (KeyError, ET.ParseError):
            levels = {}  # a list with no definition: Word's default numbered list, "1.", "2." ...
        counters: dict[str, list[int | None]] = {}
        lines: list[str] = []
        for child in body:
            if child.tag == w("tbl"):
                lines.extend(" | ".join(cells) for cells in _table_rows(child))
                continue
            if child.tag != w("p"):
                continue
            text = _paragraph_text(child)
            numbered = child.find(f"{w('pPr')}/{w('numPr')}")
            num_id = numbered.find(w("numId")) if numbered is not None else None
            definition = None
            if num_id is not None and num_id.get(w("val"), "0") != "0":  # numId 0 switches numbering off
                definition = levels.get(num_id.get(w("val"), "")) or {0: (1, "decimal", "%1.")}
            if numbered is None or not definition:
                lines.append(text)
                continue
            level = numbered.find(w("ilvl"))
            ilvl = int(level.get(w("val"), "0") or 0) if level is not None else 0
            counts = counters.setdefault(num_id.get(w("val"), ""), [])  # type: ignore[union-attr]
            counts.extend([None] * (ilvl + 1 - len(counts)))
            start = definition.get(ilvl, (1, "decimal", ""))[0]
            counts[ilvl] = start if counts[ilvl] is None else counts[ilvl] + 1  # type: ignore[operator]
            del counts[ilvl + 1:]

            def render(match: re.Match[str]) -> str:
                at = int(match.group(1)) - 1
                start_at, number_format, _text = definition.get(at, (1, "decimal", ""))
                value = counts[at] if at < len(counts) and counts[at] is not None else start_at
                return _list_label(value, number_format) or "\x00"  # type: ignore[arg-type]

            label = re.sub(r"%(\d)", render, definition.get(ilvl, (1, "decimal", "%1."))[2])
            lines.append(f"{label} {text}".strip() if label.strip() and "\x00" not in label else text)
    return _joined(lines)


# --------------------------------------------------------------------------- #
# HTML conversion (rendered to PDF by preprocessing)
# --------------------------------------------------------------------------- #
def _relationships(archive: zipfile.ZipFile) -> dict[str, str]:
    try:
        root = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
    except (KeyError, ET.ParseError):
        return {}
    rels: dict[str, str] = {}
    for rel in root.iter(f"{{{PR_NS}}}Relationship"):
        if (rel.get("TargetMode") or "").lower() == "external":
            continue
        target = rel.get("Target") or ""
        rid = rel.get("Id")
        if not rid or not target:
            continue
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("word", target))
        rels[rid] = path
    return rels


def _image_ids(element: ET.Element) -> list[str]:
    ids: list[str] = []
    for node in element.iter():
        if node.tag == f"{{{A_NS}}}blip":
            rid = node.get(f"{{{R_NS}}}embed")
            if rid:
                ids.append(rid)
        elif node.tag == f"{{{V_NS}}}imagedata":
            rid = node.get(f"{{{R_NS}}}id")
            if rid:
                ids.append(rid)
    return ids


def docx_to_html(data: bytes) -> tuple[str, dict[str, bytes]]:
    """Escaped HTML of paragraphs and tables, plus word/media images (r:embed order) keyed by
    file name; <img src="<file name>"> marks where each image appears."""
    images: dict[str, bytes] = {}
    with _open(data) as archive:
        body = _document(archive)
        rels = _relationships(archive)
        names = set(archive.namelist())

        def image_tags(element: ET.Element) -> str:
            tags = []
            for rid in _image_ids(element):
                path = rels.get(rid)
                if not path or path not in names:
                    continue
                name = posixpath.basename(path)
                if name not in images:
                    try:
                        images[name] = archive.read(path)
                    except (KeyError, zipfile.BadZipFile):
                        continue
                tags.append(f'<img src="{html.escape(name, quote=True)}"/>')
            return "".join(tags)

        def paragraph_html(paragraph: ET.Element) -> str:
            style = paragraph.find(f"{_w('pPr')}/{_w('pStyle')}")
            style_name = (style.get(_w("val")) if style is not None else "") or ""
            text = html.escape(_run_text(paragraph).strip()).replace("\n", "<br/>")
            pictures = image_tags(paragraph)
            if not text and not pictures:
                return ""
            tag = "p"
            lowered = style_name.lower()
            if lowered.startswith("heading1") or lowered == "title":
                tag = "h2"
            elif lowered.startswith("heading"):
                tag = "h3"
            return f"<{tag}>{text}{pictures}</{tag}>"

        parts: list[str] = []
        for child in body:
            if child.tag == _w("p"):
                rendered = paragraph_html(child)
                if rendered:
                    parts.append(rendered)
            elif child.tag == _w("tbl"):
                rows_html = []
                for row in child.findall(_w("tr")):
                    cells = []
                    for cell in row.findall(_w("tc")):
                        cell_parts = [paragraph_html(p) for p in cell.findall(_w("p"))]
                        cells.append(f"<td>{''.join(c for c in cell_parts if c)}</td>")
                    rows_html.append(f"<tr>{''.join(cells)}</tr>")
                parts.append(f"<table>{''.join(rows_html)}</table>")
    return "\n".join(parts), images


def describe(data: bytes) -> dict[str, Any]:
    """Small summary for logs: paragraph/table/image counts (never the text itself)."""
    with _open(data) as archive:
        body = _document(archive)
        return {
            "paragraphs": sum(1 for c in body if c.tag == _w("p")),
            "tables": sum(1 for c in body if c.tag == _w("tbl")),
            "images": len([n for n in archive.namelist() if n.startswith("word/media/")]),
        }
