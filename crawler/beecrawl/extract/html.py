"""HTML text and link extraction, plus Google Docs/Drive URL rewriting."""

from __future__ import annotations

import re
from urllib.parse import urldefrag, urljoin, urlparse

from selectolax.parser import HTMLParser

_DROP_TAGS = ("script", "style", "noscript", "nav", "footer", "svg")

_GDOC_ID = re.compile(r"/document/d/([A-Za-z0-9_-]+)")
_GDRIVE_ID = re.compile(r"/file/d/([A-Za-z0-9_-]+)")
_GDRIVE_OPEN = re.compile(r"[?&]id=([A-Za-z0-9_-]+)")


def extract_html(data: bytes) -> str:
    tree = HTMLParser(data.decode("utf-8", errors="replace"))
    for tag in _DROP_TAGS:
        for node in tree.css(tag):
            node.decompose()
    body = tree.body or tree.root
    if body is None:
        return ""
    text = body.text(separator="\n")
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def page_title(data: bytes) -> str | None:
    tree = HTMLParser(data.decode("utf-8", errors="replace"))
    node = tree.css_first("title")
    title = node.text(strip=True) if node else None
    return title[:300] if title else None


def normalize_doc_url(url: str) -> str:
    """Rewrite Google Docs/Drive viewer links to a plain-text export.

    Study guides on ihbbeurope.com and iacompetitions.com are frequently
    published as Google Docs; the viewer page is a JS shell with no content,
    while `/export?format=txt` returns the document body directly.
    """
    parsed = urlparse(url)
    if parsed.netloc not in ("docs.google.com", "drive.google.com"):
        return url

    m = _GDOC_ID.search(parsed.path)
    if m:
        return f"https://docs.google.com/document/d/{m.group(1)}/export?format=txt"

    m = _GDRIVE_ID.search(parsed.path) or _GDRIVE_OPEN.search(parsed.query)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"

    return url


def extract_links(data: bytes, base_url: str) -> list[str]:
    """Absolute, de-duplicated, fragment-stripped links from a page."""
    tree = HTMLParser(data.decode("utf-8", errors="replace"))
    seen: dict[str, None] = {}
    for node in tree.css("a[href]"):
        href = (node.attributes.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        absolute, _ = urldefrag(urljoin(base_url, href))
        if urlparse(absolute).scheme not in ("http", "https"):
            continue
        seen.setdefault(normalize_doc_url(absolute), None)
    return list(seen)
