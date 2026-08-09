"""Turn fetched bytes into plain text, dispatching on content type."""

from __future__ import annotations

from .docx import extract_docx
from .html import extract_html, extract_links, page_title
from .pdf import extract_pdf

__all__ = [
    "extract_docx",
    "extract_html",
    "extract_links",
    "extract_pdf",
    "page_title",
    "detect_kind",
    "extract_text",
]


def detect_kind(url: str, content_type: str | None, data: bytes) -> str:
    """Classify a payload as 'html' | 'pdf' | 'docx' | 'text' | 'unknown'."""
    ct = (content_type or "").lower()
    lower = url.lower().split("?")[0]

    if data[:4] == b"%PDF" or "application/pdf" in ct or lower.endswith(".pdf"):
        return "pdf"
    # DOCX is a zip; check the magic bytes before trusting the extension.
    if data[:2] == b"PK" and (
        lower.endswith(".docx") or "wordprocessingml" in ct or "officedocument" in ct
    ):
        return "docx"
    if "text/html" in ct or "application/xhtml" in ct or data[:512].lstrip()[:1] == b"<":
        return "html"
    if "text/plain" in ct or lower.endswith(".txt"):
        return "text"
    return "unknown"


def extract_text(url: str, content_type: str | None, data: bytes) -> tuple[str, str]:
    """Return `(kind, text)`. Raises on an unsupported payload."""
    kind = detect_kind(url, content_type, data)
    if kind == "pdf":
        return kind, extract_pdf(data)
    if kind == "docx":
        return kind, extract_docx(data)
    if kind == "html":
        return kind, extract_html(data)
    if kind == "text":
        return kind, data.decode("utf-8", errors="replace")
    raise ValueError(f"unsupported content type for {url}: {content_type!r}")
