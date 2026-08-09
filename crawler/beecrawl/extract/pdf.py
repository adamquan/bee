"""PDF text extraction.

Quizbowl packets are single-column prose, so pdfplumber's layout-aware
extraction preserves the paragraph breaks the tossup parser keys on.
"""

from __future__ import annotations

import io
import re

import pdfplumber

# Packets often carry a running header/footer on every page ("2019 NHBB
# Nationals Bee — Round 3", page numbers). Dropping repeated short lines keeps
# them out of the middle of a tossup.
_PAGE_NUM = re.compile(r"^\s*(page\s+)?\d{1,3}\s*(of\s+\d{1,3})?\s*$", re.IGNORECASE)


def _strip_repeated_lines(pages: list[str]) -> list[str]:
    if len(pages) < 3:
        return pages
    counts: dict[str, int] = {}
    for page in pages:
        lines = [ln.strip() for ln in page.splitlines() if ln.strip()]
        for ln in lines[:2] + lines[-2:]:
            if len(ln) < 90:
                counts[ln] = counts.get(ln, 0) + 1
    threshold = max(3, len(pages) // 2)
    boilerplate = {ln for ln, n in counts.items() if n >= threshold}

    cleaned = []
    for page in pages:
        kept = [
            ln
            for ln in page.splitlines()
            if ln.strip() not in boilerplate and not _PAGE_NUM.match(ln)
        ]
        cleaned.append("\n".join(kept))
    return cleaned


def space_ratio(text: str) -> float:
    """Fraction of characters that are spaces. English prose sits near 0.16."""
    return text.count(" ") / len(text) if text else 0.0

# Below this, the page almost certainly lost its word boundaries rather than
# being genuinely dense. Measured against a 0.145 median across the corpus.
_MIN_SPACE_RATIO = 0.08


def page_text(page) -> str:
    """Text for one page, recovering word breaks when the PDF has no spaces.

    A quarter of the crawled packets encode no space glyphs at all — pdfplumber
    returns "TheRepublicofSanMarino". Tightening `x_tolerance` makes it infer
    word breaks from character gaps instead. The default is kept for pages that
    are already fine, since a tight tolerance can split words on wide kerning.
    """
    text = page.extract_text() or ""
    if len(text) > 80 and space_ratio(text) < _MIN_SPACE_RATIO:
        retry = page.extract_text(x_tolerance=1) or ""
        if space_ratio(retry) > space_ratio(text):
            return retry
    return text


def extract_pdf(data: bytes) -> str:
    pages: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            pages.append(page_text(page))
    pages = _strip_repeated_lines(pages)
    return "\n\n".join(p.strip() for p in pages if p.strip())
