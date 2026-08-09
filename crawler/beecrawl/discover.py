"""Breadth-first link walk over the seed pages.

Stays on seed hosts plus the document hosts in `ALLOWED_OFFSITE_HOSTS`, records
every URL it considers in `sources`, and stops at `MAX_DEPTH` / `MAX_PAGES`.
"""

from __future__ import annotations

import re
import sqlite3
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from urllib.parse import urlparse

from . import config, db
from .extract import detect_kind, extract_links, page_title
from .fetch import Fetcher

# Link text / URL fragments that mark a document worth keeping.
_PACKET_HINTS = ("packet", "round", "question", "tossup", "bowl", "bee", "exam", "set")
_GUIDE_HINTS = ("study", "guide", "resource", "syllabus", "topic")
_RULES_HINTS = ("rule", "scoresheet", "score sheet", "format")


# Site-furniture paths that never hold questions. Skipping them keeps the page
# budget pointed at packets instead of the "About" menu.
_BOILERPLATE = (
    "/about", "/contact", "/apply", "/registration", "/privacy", "/testimonial",
    "/team", "/hosting", "/partners", "/social-media", "/cart", "/checkout",
    "/my-account", "/donate", "/shop", "/product", "/tag/", "/author/",
    "/wp-login", "/feed", "/category/",
)

_DOC_SUFFIXES = (".pdf", ".docx", ".doc", ".txt", ".rtf")


# On Google hosts, only document links are worth anything — the rest is
# Workspace marketing, and robots.txt denies most of it anyway.
_GOOGLE_DOC_PATH = re.compile(r"/(?:document|spreadsheets|presentation|file)/d/|[?&]export=")


def _is_boilerplate(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.endswith("google.com") and not _GOOGLE_DOC_PATH.search(url):
        return True
    return any(frag in parsed.path.lower() for frag in _BOILERPLATE)


def _is_document(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc in config.ALLOWED_OFFSITE_HOSTS:
        return True
    return parsed.path.lower().endswith(_DOC_SUFFIXES)


def classify(url: str, title: str | None, kind: str) -> str:
    """Best-effort source `kind` from the URL, title, and payload type."""
    hay = f"{url} {title or ''}".lower()
    if kind == "html":
        return "index"
    if any(h in hay for h in _RULES_HINTS):
        return "rules"
    if any(h in hay for h in _GUIDE_HINTS):
        return "studyguide"
    if any(h in hay for h in _PACKET_HINTS):
        return "packet"
    if kind in ("pdf", "docx"):
        return "exam"
    return "unknown"


@dataclass
class CrawlPlanEntry:
    url: str
    host: str
    depth: int
    allowed: bool
    reason: str | None
    crawl_delay: float
    ai_train_ok: bool


def plan(seeds: list[str], fetcher: Fetcher) -> list[CrawlPlanEntry]:
    """Robots decisions and delays for the seed set, without fetching pages."""
    entries: list[CrawlPlanEntry] = []
    for url in seeds:
        host = urlparse(url).netloc
        pol = fetcher.policy(host)
        allowed, reason = fetcher.allowed(url)
        entries.append(
            CrawlPlanEntry(
                url=url,
                host=host,
                depth=0,
                allowed=allowed,
                reason=reason or pol.signal_note,
                crawl_delay=pol.crawl_delay,
                ai_train_ok=pol.ai_train_ok,
            )
        )
    return entries


def crawl(
    conn: sqlite3.Connection,
    fetcher: Fetcher,
    seeds: list[str],
    *,
    max_depth: int = config.MAX_DEPTH,
    max_pages: int = config.MAX_PAGES,
    resume: bool = False,
    on_event=None,
) -> dict[str, int]:
    """Walk from `seeds`, storing fetched bytes and extracted text.

    Returns a counter dict. Failures are recorded on the source row and the
    walk continues.
    """

    def emit(kind: str, url: str, detail: str = "") -> None:
        if on_event:
            on_event(kind, url, detail)

    seed_hosts = {urlparse(u).netloc for u in seeds}
    followable = seed_hosts | config.ALLOWED_OFFSITE_HOSTS

    # Per-host queues, documents before index pages. Documents are the actual
    # question sets, so a page budget spent on a site with a large nav menu
    # still reaches the packets.
    #
    # Work is round-robined across hosts: while one host is inside its
    # crawl-delay we fetch from another, rather than sleeping. Each host still
    # sees exactly the rate its robots.txt asks for, but a ten-host crawl runs
    # roughly ten times sooner.
    docs: dict[str, deque[tuple[str, int, int]]] = defaultdict(deque)
    pages: dict[str, deque[tuple[str, int, int]]] = defaultdict(deque)

    seen: set[str] = set()

    def enqueue(url: str, depth: int, source_id: int) -> None:
        host = urlparse(url).netloc
        pool = docs if _is_document(url) else pages
        pool[host].append((url, depth, source_id))
        seen.add(url)

    for url in seeds:
        host = urlparse(url).netloc
        enqueue(url, 0, db.upsert_source(conn, url, host=host, depth=0))

    if resume:
        # Pick up everything discovered by an earlier run but never fetched,
        # so a crawl that was interrupted (or capped) continues instead of
        # re-walking the index pages to rediscover the same documents.
        rows = conn.execute(
            "SELECT id, url, depth FROM sources WHERE status = 'pending' ORDER BY depth, id"
        ).fetchall()
        for row in rows:
            if row["url"] not in seen:
                enqueue(row["url"], int(row["depth"]), int(row["id"]))
        emit("ok", f"resumed {len(rows)} pending URL(s) from a previous crawl")

    def pending_hosts() -> list[str]:
        return [h for h in set(docs) | set(pages) if docs[h] or pages[h]]

    def take_next() -> tuple[str, int, int] | None:
        """Next item from whichever host is off cooldown; wait if none are."""
        hosts = pending_hosts()
        if not hosts:
            return None
        # Prefer a ready host with documents waiting.
        ready = [h for h in hosts if fetcher.seconds_until_ready(h) <= 0]
        for pool in (docs, pages):
            for host in ready:
                if pool[host]:
                    return pool[host].popleft()
        # Everything is cooling down; sleep only as long as the soonest host.
        soonest = min(fetcher.seconds_until_ready(h) for h in hosts)
        if soonest > 0:
            time.sleep(min(soonest, 15.0))
        for pool in (docs, pages):
            for host in hosts:
                if pool[host]:
                    return pool[host].popleft()
        return None

    counts = {"fetched": 0, "cached": 0, "extracted": 0, "denied": 0, "errors": 0, "queued": 0}

    while counts["fetched"] + counts["errors"] + counts["denied"] < max_pages:
        item = take_next()
        if item is None:
            break
        url, depth, source_id = item
        host = urlparse(url).netloc
        pol = fetcher.policy(host)

        result = fetcher.fetch(url)
        if not result.ok:
            db.set_source_status(conn, source_id, result.status, result.detail)
            counts["denied" if result.status == "robots_denied" else "errors"] += 1
            emit("fail", url, f"{result.status}: {result.detail}")
            conn.commit()
            continue

        counts["fetched"] += 1
        if result.from_cache:
            counts["cached"] += 1

        data = result.content or b""
        payload_kind = detect_kind(url, result.content_type, data)
        title = page_title(data) if payload_kind == "html" else None
        source_kind = classify(url, title, payload_kind)

        db.record_fetch(
            conn,
            source_id,
            content_type=result.content_type,
            sha256=result.sha256 or "",
            cache_path=result.cache_path or "",
            size=result.size,
            title=title,
            kind=source_kind,
        )
        # Propagate the host's Content-Signal onto the row so the enrichment
        # step can honor `ai-train=no`.
        conn.execute(
            "UPDATE sources SET ai_train_ok = ?, license_note = COALESCE(?, license_note) WHERE id = ?",
            (1 if pol.ai_train_ok else 0, pol.signal_note, source_id),
        )
        emit("ok", url, f"{payload_kind}/{source_kind} {result.size}B")

        if payload_kind == "html" and depth < max_depth:
            for link in extract_links(data, url):
                if link in seen:
                    continue
                link_host = urlparse(link).netloc
                if link_host not in followable:
                    continue
                if _is_boilerplate(link):
                    continue

                child_id = db.upsert_source(
                    conn, link, host=link_host, depth=depth + 1, discovered_from=source_id
                )
                # Documents are leaves and get priority; pages are recursed into.
                enqueue(link, depth + 1, child_id)
                counts["queued"] += 1

        conn.commit()

    return counts


def extract_all(conn: sqlite3.Connection, *, on_event=None) -> dict[str, int]:
    """Extract text for every fetched-but-not-yet-extracted source."""
    from .extract import extract_text

    counts = {"extracted": 0, "skipped": 0, "errors": 0}
    rows = conn.execute(
        "SELECT id, url, content_type, cache_path FROM sources WHERE status = 'fetched'"
    ).fetchall()

    for row in rows:
        path = row["cache_path"]
        if not path:
            counts["skipped"] += 1
            continue
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            _, text = extract_text(row["url"], row["content_type"], data)
        except Exception as exc:
            db.set_source_status(conn, row["id"], "error", f"extract: {exc}")
            counts["errors"] += 1
            if on_event:
                on_event("fail", row["url"], str(exc))
            continue

        if len(text.strip()) < 200:
            db.set_source_status(conn, row["id"], "skipped", "extracted text too short")
            counts["skipped"] += 1
            continue

        db.save_text(conn, row["id"], text)
        counts["extracted"] += 1
        if on_event:
            on_event("ok", row["url"], f"{len(text)} chars")
        conn.commit()

    return counts
