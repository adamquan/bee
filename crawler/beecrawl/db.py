"""SQLite access for the crawler side.

The web app talks to the same file through `web/lib/db.ts`; the schema lives in
`shared/schema.sql` so neither side owns it.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from . import config


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = Path(db_path or config.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def init_db(db_path: Path | None = None) -> sqlite3.Connection:
    """Apply `shared/schema.sql`, then any migrations. Idempotent."""
    from .migrate import migrate
    from .seed import install_if_missing

    # A fresh volume beside an image that carries a seed: populate it before
    # anything opens the file, so the app never comes up empty.
    install_if_missing(Path(db_path or config.DB_PATH), config.SEED_DB_PATH)

    conn = connect(db_path)
    conn.executescript(config.SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()
    # schema.sql only creates what is missing; altering what already exists is
    # the migration's job, and it must run second.
    migrate(conn)
    return conn


@contextmanager
def session(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = init_db(db_path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ------------------------------------------------------------ normalization --

_ARTICLES = {"the", "a", "an"}
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def normalize_answer(text: str) -> str:
    """Fold an answer to a comparable form.

    Lowercases, strips accents and punctuation, drops leading articles. Shared
    in spirit with `web/lib/judge.ts` — keep the two in sync when editing.
    """
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    text = _PUNCT.sub(" ", text)
    tokens = [t for t in _WS.split(text) if t]
    while tokens and tokens[0] in _ARTICLES:
        tokens.pop(0)
    return " ".join(tokens)


def fingerprint(answer: str, body: str) -> str:
    """Dedup key: normalized answer plus the first ~200 chars of the body."""
    key = f"{normalize_answer(answer)}|{normalize_answer(body)[:200]}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------- sources --


def upsert_source(
    conn: sqlite3.Connection,
    url: str,
    *,
    host: str,
    depth: int = 0,
    discovered_from: int | None = None,
    kind: str = "unknown",
    ai_train_ok: bool = True,
    license_note: str | None = None,
) -> int:
    row = conn.execute("SELECT id FROM sources WHERE url = ?", (url,)).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute(
        """
        INSERT INTO sources (url, host, kind, depth, discovered_from, ai_train_ok, license_note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (url, host, kind, depth, discovered_from, 1 if ai_train_ok else 0, license_note),
    )
    return int(cur.lastrowid)


def set_source_status(
    conn: sqlite3.Connection, source_id: int, status: str, detail: str | None = None
) -> None:
    conn.execute(
        "UPDATE sources SET status = ?, status_detail = ? WHERE id = ?",
        (status, detail, source_id),
    )


def record_fetch(
    conn: sqlite3.Connection,
    source_id: int,
    *,
    content_type: str | None,
    sha256: str,
    cache_path: str,
    size: int,
    title: str | None = None,
    kind: str | None = None,
) -> None:
    fields = [
        "content_type = ?",
        "sha256 = ?",
        "cache_path = ?",
        "bytes = ?",
        "fetched_at = ?",
        "status = 'fetched'",
    ]
    params: list[Any] = [content_type, sha256, cache_path, size, now()]
    if title:
        fields.append("title = ?")
        params.append(title)
    if kind:
        fields.append("kind = ?")
        params.append(kind)
    params.append(source_id)
    conn.execute(f"UPDATE sources SET {', '.join(fields)} WHERE id = ?", params)


def save_text(conn: sqlite3.Connection, source_id: int, text: str) -> None:
    conn.execute(
        """
        INSERT INTO source_texts (source_id, text, char_count, extracted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
            text = excluded.text,
            char_count = excluded.char_count,
            extracted_at = excluded.extracted_at
        """,
        (source_id, text, len(text), now()),
    )
    conn.execute("UPDATE sources SET status = 'extracted' WHERE id = ?", (source_id,))


# --------------------------------------------------------------- questions --


def _tag_id(conn: sqlite3.Connection, name: str) -> int:
    row = conn.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute("INSERT INTO tags (name, kind) VALUES (?, 'topic')", (name,))
    return int(cur.lastrowid)


def set_question_tags(conn: sqlite3.Connection, question_id: int, tags: Iterable[str]) -> None:
    conn.execute("DELETE FROM question_tags WHERE question_id = ?", (question_id,))
    for name in {t.strip() for t in tags if t and t.strip()}:
        conn.execute(
            "INSERT OR IGNORE INTO question_tags (question_id, tag_id) VALUES (?, ?)",
            (question_id, _tag_id(conn, name)),
        )


def set_source_tags(conn: sqlite3.Connection, source_id: int, tags: Iterable[str]) -> None:
    for name in {t.strip() for t in tags if t and t.strip()}:
        conn.execute(
            "INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?, ?)",
            (source_id, _tag_id(conn, name)),
        )


def _index_fts(conn: sqlite3.Connection, question_id: int, body: str, answer: str) -> None:
    conn.execute("DELETE FROM questions_fts WHERE question_id = ?", (question_id,))
    conn.execute(
        "INSERT INTO questions_fts (body, answer, question_id) VALUES (?, ?, ?)",
        (body, answer, question_id),
    )


def insert_tossup(
    conn: sqlite3.Connection,
    *,
    clues: Sequence[tuple[str, str]],  # (tier, text) in reveal order
    answer: str,
    origin: str,
    source_id: int | None = None,
    difficulty: str = "middle",
    answer_alternates: Sequence[str] = (),
    explanation: str | None = None,
    tags: Sequence[str] = (),
) -> int | None:
    """Insert a tossup. Returns None if an identical question already exists."""
    if not clues:
        return None
    body = " ".join(text for _, text in clues)
    fp = fingerprint(answer, clues[0][1])
    try:
        cur = conn.execute(
            """
            INSERT INTO questions
                (type, origin, source_id, difficulty, answer, answer_alternates,
                 explanation, fingerprint, enriched)
            VALUES ('tossup', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                origin,
                source_id,
                difficulty,
                answer.strip(),
                json.dumps(list(answer_alternates)),
                explanation,
                fp,
                1 if (explanation and tags) else 0,
            ),
        )
    except sqlite3.IntegrityError:
        return None  # duplicate fingerprint
    qid = int(cur.lastrowid)
    for ordinal, (tier, text) in enumerate(clues):
        conn.execute(
            "INSERT INTO tossup_clues (question_id, ordinal, tier, text) VALUES (?, ?, ?, ?)",
            (qid, ordinal, tier, text),
        )
    if tags:
        set_question_tags(conn, qid, tags)
    _index_fts(conn, qid, body, answer)
    return qid


def insert_mcq(
    conn: sqlite3.Connection,
    *,
    stem: str,
    options: Sequence[tuple[str, str, bool]],  # (label, text, is_correct)
    answer: str,
    origin: str,
    source_id: int | None = None,
    difficulty: str = "middle",
    explanation: str | None = None,
    tags: Sequence[str] = (),
) -> int | None:
    fp = fingerprint(answer, stem)
    try:
        cur = conn.execute(
            """
            INSERT INTO questions
                (type, origin, source_id, difficulty, stem, answer, answer_alternates,
                 explanation, fingerprint, enriched)
            VALUES ('mcq', ?, ?, ?, ?, ?, '[]', ?, ?, ?)
            """,
            (
                origin,
                source_id,
                difficulty,
                stem.strip(),
                answer.strip(),
                explanation,
                fp,
                1 if (explanation and tags) else 0,
            ),
        )
    except sqlite3.IntegrityError:
        return None
    qid = int(cur.lastrowid)
    for label, text, correct in options:
        conn.execute(
            "INSERT INTO mcq_options (question_id, label, text, is_correct) VALUES (?, ?, ?, ?)",
            (qid, label, text, 1 if correct else 0),
        )
    if tags:
        set_question_tags(conn, qid, tags)
    _index_fts(conn, qid, stem, answer)
    return qid


def rebuild_fts(conn: sqlite3.Connection) -> int:
    """Drop and repopulate the full-text index from the questions table.

    FTS5 stores its own copy of the text, so a damaged index cannot be repaired
    in place — it has to be rebuilt from the source rows.
    """
    conn.execute("DROP TABLE IF EXISTS questions_fts")
    conn.execute(
        """
        CREATE VIRTUAL TABLE questions_fts USING fts5(
            body, answer, question_id UNINDEXED, tokenize = 'porter unicode61'
        )
        """
    )
    rows = conn.execute("SELECT id, type, stem, answer FROM questions").fetchall()
    for row in rows:
        if row["type"] == "tossup":
            clues = conn.execute(
                "SELECT text FROM tossup_clues WHERE question_id = ? ORDER BY ordinal",
                (row["id"],),
            ).fetchall()
            body = " ".join(c["text"] for c in clues)
        else:
            body = row["stem"] or ""
        conn.execute(
            "INSERT INTO questions_fts (body, answer, question_id) VALUES (?, ?, ?)",
            (body, row["answer"], row["id"]),
        )
    conn.commit()
    return len(rows)


def quarantine(
    conn: sqlite3.Connection, source_id: int | None, reason: str, raw_text: str
) -> None:
    conn.execute(
        "INSERT INTO quarantine (source_id, reason, raw_text) VALUES (?, ?, ?)",
        (source_id, reason, raw_text[:20000]),
    )


def link_question_source(
    conn: sqlite3.Connection, question_id: int | None, source_id: int | None
) -> None:
    """Record that `question_id` appears in `source_id`.

    Called both for the source that contributed a question and for every later
    packet found to be republishing it, so a source's real coverage is known.
    """
    if source_id is None or question_id is None:
        return
    conn.execute(
        "INSERT OR IGNORE INTO question_sources (question_id, source_id) VALUES (?, ?)",
        (question_id, source_id),
    )


def question_id_for_fingerprint(conn: sqlite3.Connection, answer: str, first_text: str) -> int | None:
    """Id of the question holding this exact fingerprint, if one exists.

    `insert_tossup`/`insert_mcq` return None on a UNIQUE violation without
    saying what they collided with. Coverage tracking needs the id, and an
    exact collision is the commonest way a republished packet is rejected —
    identical text produces an identical fingerprint, which the fuzzier
    near-duplicate search may never be asked about.
    """
    row = conn.execute(
        "SELECT id FROM questions WHERE fingerprint = ?", (fingerprint(answer, first_text),)
    ).fetchone()
    return int(row["id"]) if row else None


def near_duplicate_exists(
    conn: sqlite3.Connection, answer: str, body: str, qtype: str | None = None
) -> bool:
    """True when `find_near_duplicate` finds a match. See it for the details."""
    return find_near_duplicate(conn, answer, body, qtype) is not None


def find_near_duplicate(
    conn: sqlite3.Connection, answer: str, body: str, qtype: str | None = None
) -> int | None:
    """Id of a semantically-identical question already in the bank, or None.

    Guards against the same tossup appearing in two packets with light rewording,
    which the exact fingerprint would miss.

    `qtype` scopes the check to one format. A tossup and a multiple-choice
    question can share an answer — "Julius Caesar" appears in both — without
    either being a duplicate of the other; they are different practice items.
    """
    terms = [t for t in normalize_answer(body).split()[:12] if len(t) > 3]
    if len(terms) < 4:
        return None
    query = " OR ".join(terms)
    try:
        rows = conn.execute(
            """
            SELECT question_id, bm25(questions_fts) AS score
            FROM questions_fts
            WHERE questions_fts MATCH ?
            ORDER BY score LIMIT 5
            """,
            (query,),
        ).fetchall()
    except sqlite3.DatabaseError:
        # Covers malformed MATCH syntax and a damaged FTS index alike. Dedup is
        # an optimisation — losing it must not abort a multi-hour parse. Run
        # `beecrawl reindex` to rebuild the index.
        return None
    target = normalize_answer(answer)
    for row in rows:
        if qtype:
            existing = conn.execute(
                "SELECT answer FROM questions WHERE id = ? AND type = ?",
                (row["question_id"], qtype),
            ).fetchone()
        else:
            existing = conn.execute(
                "SELECT answer FROM questions WHERE id = ?", (row["question_id"],)
            ).fetchone()
        # bm25 is negative-better in SQLite's FTS5; -8 is a deliberately tight
        # threshold so only strongly-overlapping text counts as a duplicate.
        if existing and normalize_answer(existing["answer"]) == target and row["score"] < -8:
            return int(row["question_id"])
    return None


# ------------------------------------------------------------------- stats --


def stats(conn: sqlite3.Connection) -> dict[str, Any]:
    def scalar(sql: str, *params: Any) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    by_status = {
        r["status"]: r["n"]
        for r in conn.execute("SELECT status, COUNT(*) n FROM sources GROUP BY status")
    }
    by_kind = {
        r["kind"]: r["n"] for r in conn.execute("SELECT kind, COUNT(*) n FROM sources GROUP BY kind")
    }
    by_type_origin = {
        f"{r['type']}/{r['origin']}": r["n"]
        for r in conn.execute(
            "SELECT type, origin, COUNT(*) n FROM questions GROUP BY type, origin"
        )
    }
    top_tags = [
        (r["name"], r["n"])
        for r in conn.execute(
            """
            SELECT t.name, COUNT(*) n FROM question_tags qt
            JOIN tags t ON t.id = qt.tag_id
            GROUP BY t.name ORDER BY n DESC LIMIT 15
            """
        )
    ]
    return {
        "sources_total": scalar("SELECT COUNT(*) FROM sources"),
        "sources_by_status": by_status,
        "sources_by_kind": by_kind,
        "questions_total": scalar("SELECT COUNT(*) FROM questions"),
        "questions_by_type_origin": by_type_origin,
        "questions_enriched": scalar("SELECT COUNT(*) FROM questions WHERE enriched = 1"),
        "questions_untagged": scalar(
            "SELECT COUNT(*) FROM questions q "
            "WHERE NOT EXISTS (SELECT 1 FROM question_tags WHERE question_id = q.id)"
        ),
        "quarantined": scalar("SELECT COUNT(*) FROM quarantine"),
        "attempts": scalar("SELECT COUNT(*) FROM attempts"),
        "top_tags": top_tags,
    }
