"""Bring user-supplied PDFs, DOCX files, and links into the same pipeline.

The web app's Library page writes files into `data/inbox/` and adds an `inbox`
row; `beecrawl ingest` drains that queue through extract -> parse -> enrich,
so uploads land in the bank exactly like crawled material (bee.md req. 4).
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

from . import config, db, pipeline
from .extract import extract_text
from .extract.html import normalize_doc_url
from .fetch import Fetcher


def _register_upload(conn: sqlite3.Connection, path: Path) -> int:
    """Create (or find) a `sources` row for a local file."""
    url = path.resolve().as_uri()
    source_id = db.upsert_source(conn, url, host="local-upload", kind="upload")
    data = path.read_bytes()
    db.record_fetch(
        conn,
        source_id,
        content_type=None,
        sha256=hashlib.sha256(data).hexdigest(),
        cache_path=str(path),
        size=len(data),
        title=path.name,
        kind="upload",
    )
    return source_id


def ingest_file(conn: sqlite3.Connection, path: Path) -> dict[str, int]:
    source_id = _register_upload(conn, path)
    data = path.read_bytes()
    _, text = extract_text(str(path), None, data)
    if len(text.strip()) < 100:
        db.set_source_status(conn, source_id, "skipped", "extracted text too short")
        return {"tossups": 0, "mcqs": 0, "duplicates": 0, "quarantined": 0}

    db.save_text(conn, source_id, text)
    counts = pipeline.parse_source(conn, source_id, text)
    db.set_source_status(
        conn,
        source_id,
        "parsed",
        f"{counts['tossups']} tossups, {counts['mcqs']} mcqs",
    )
    conn.commit()
    return counts


def ingest_url(conn: sqlite3.Connection, url: str, fetcher: Fetcher) -> dict[str, int]:
    url = normalize_doc_url(url)
    source_id = db.upsert_source(conn, url, host=urlparse(url).netloc, kind="upload")

    result = fetcher.fetch(url)
    if not result.ok:
        db.set_source_status(conn, source_id, result.status, result.detail)
        conn.commit()
        raise RuntimeError(f"{result.status}: {result.detail}")

    pol = fetcher.policy(urlparse(url).netloc)
    db.record_fetch(
        conn,
        source_id,
        content_type=result.content_type,
        sha256=result.sha256 or "",
        cache_path=result.cache_path or "",
        size=result.size,
        kind="upload",
    )
    conn.execute(
        "UPDATE sources SET ai_train_ok = ? WHERE id = ?",
        (1 if pol.ai_train_ok else 0, source_id),
    )

    _, text = extract_text(url, result.content_type, result.content or b"")
    db.save_text(conn, source_id, text)
    counts = pipeline.parse_source(conn, source_id, text)
    db.set_source_status(
        conn, source_id, "parsed", f"{counts['tossups']} tossups, {counts['mcqs']} mcqs"
    )
    conn.commit()
    return counts


def drain_inbox(conn: sqlite3.Connection, *, on_event=None) -> dict[str, int]:
    """Process every pending `inbox` row queued by the web app."""
    totals = {"processed": 0, "errors": 0, "tossups": 0, "mcqs": 0}
    rows = conn.execute("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id").fetchall()
    if not rows:
        return totals

    with Fetcher() as fetcher:
        for row in rows:
            conn.execute("UPDATE inbox SET status = 'processing' WHERE id = ?", (row["id"],))
            conn.commit()
            try:
                if row["kind"] == "file":
                    path = Path(row["path_or_url"])
                    if not path.is_absolute():
                        path = config.INBOX_DIR / path
                    counts = ingest_file(conn, path)
                else:
                    counts = ingest_url(conn, row["path_or_url"], fetcher)

                totals["processed"] += 1
                totals["tossups"] += counts["tossups"]
                totals["mcqs"] += counts["mcqs"]
                detail = f"{counts['tossups']} tossups, {counts['mcqs']} mcqs"
                conn.execute(
                    """
                    UPDATE inbox SET status = 'done', status_detail = ?,
                                     processed_at = datetime('now')
                    WHERE id = ?
                    """,
                    (detail, row["id"]),
                )
                if on_event:
                    on_event("ok", row["path_or_url"], detail)
            except Exception as exc:
                totals["errors"] += 1
                conn.execute(
                    """
                    UPDATE inbox SET status = 'error', status_detail = ?,
                                     processed_at = datetime('now')
                    WHERE id = ?
                    """,
                    (f"{exc.__class__.__name__}: {exc}", row["id"]),
                )
                if on_event:
                    on_event("fail", row["path_or_url"], str(exc))
            conn.commit()

    return totals
