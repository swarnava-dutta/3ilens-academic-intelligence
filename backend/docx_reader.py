"""Typed Word (.docx) answer sheets and rubric sources - stdlib zipfile + xml.etree only.

validate_docx() is the security gate (zip sanity, size/entry caps, real WordprocessingML,
no macros). docx_text() extracts plain text (rubric parsing); docx_to_html() produces simple
escaped HTML + embedded images, which preprocessing renders to PDF so typed sheets take the
same vision route as scans (no separate text path).
"""
from __future__ import annotations

import html
import io
import posixpath
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
    # Collapse runs of blank lines.
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


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
