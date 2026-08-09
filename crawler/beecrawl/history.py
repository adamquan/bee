"""Replay the web app's append-only practice-history journal into the database.

`data/bee.db` holds both the question bank and the student's history. The bank
is reproducible — re-run the crawler — but the history is not, so the web app
mirrors every session and attempt to `data/history.jsonl` as it happens. This
module puts it back.

Restore never trusts the journal's row ids. A database whose history was lost
and then practised against again will have reissued those ids to different
events, so sessions are matched on a natural key (started_at + format +
filters) and attempts on (session, question, created_at). That makes restore
idempotent: running it twice adds nothing the second time.
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from . import config

HISTORY_PATH = Path(os.environ.get("BEE_HISTORY_PATH") or config.DATA_DIR / "history.jsonl")


@dataclass
class RestoreReport:
    users_added: int = 0
    sessions_added: int = 0
    sessions_skipped: int = 0
    attempts_added: int = 0
    attempts_skipped: int = 0
    orphan_attempts: int = 0
    malformed_lines: int = 0
    ended: int = 0
    review_queued: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def added(self) -> int:
        return self.sessions_added + self.attempts_added


def read_journal(path: Path) -> Iterator[tuple[int, dict[str, Any]]]:
    """Yield (line number, event) for every well-formed line.

    A truncated final line — the app killed mid-append — must not abort the
    restore of everything before it, so bad lines are counted, not raised.
    """
    with path.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                yield number, {}
                continue
            if isinstance(event, dict) and event.get("kind"):
                yield number, event
            else:
                yield number, {}


def restore(
    conn: sqlite3.Connection,
    path: Path | None = None,
    *,
    dry_run: bool = False,
) -> RestoreReport:
    """Replay `path` into `conn`. Idempotent; safe to run against a live bank."""
    path = path or HISTORY_PATH
    report = RestoreReport()
    if not path.exists():
        return report

    # journal session id -> database session id, which differ whenever ids were
    # reissued after the history was lost.
    session_map: dict[int, int] = {}
    ends: list[tuple[int, str]] = []
    # journal user id -> database user id. Profiles are matched by name, not
    # id, for the same reason sessions are: ids get reissued.
    user_map: dict[int, int] = {}

    for number, event in read_journal(path):
        kind = event.get("kind")
        if not kind:
            report.malformed_lines += 1
            continue

        try:
            if kind == "session":
                _restore_session(conn, event, session_map, user_map, report, dry_run)
            elif kind == "attempt":
                _restore_attempt(conn, event, session_map, report, dry_run)
            elif kind == "session_end":
                ends.append((int(event["sessionId"]), str(event["endedAt"])))
        except (KeyError, TypeError, ValueError) as error:
            report.malformed_lines += 1
            if len(report.errors) < 5:
                report.errors.append(f"line {number}: {error}")
        except sqlite3.Error as error:
            if len(report.errors) < 5:
                report.errors.append(f"line {number}: {error}")

    for journal_id, ended_at in ends:
        db_id = session_map.get(journal_id)
        if db_id is None or dry_run:
            continue
        conn.execute(
            "UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
            (ended_at, db_id),
        )
        report.ended += 1

    # Only meaningful once the attempts are actually in the table — a dry run
    # has nothing to read, so it reports no projection rather than a false zero.
    if not dry_run:
        report.review_queued = rebuild_review_queue(conn)
        conn.commit()
    return report


# `review_queue` is not journalled: it is a function of the attempt sequence,
# and keeping a second copy of the web app's SM-2 rules here would be two
# implementations to drift apart. It is reconstructed instead.
_MIN_EASE = 1.3


def rebuild_review_queue(conn: sqlite3.Connection) -> int:
    """Re-queue, per profile, questions whose most recent attempt was a miss.

    This is a reconstruction, not an exact replay: a question that was missed
    and later answered correctly is left out, and intervals restart at one day
    rather than resuming where they were. Both are deliberate — the queue's job
    is to bring misses back, and it self-heals from the next attempt onward,
    since the web app runs the real scheduler on every answer.
    """
    rows = conn.execute(
        """
        WITH answered AS (
            SELECT se.user_id AS user_id, a.question_id AS question_id,
                   a.verdict AS verdict, a.created_at AS created_at, a.id AS id
            FROM attempts a JOIN sessions se ON se.id = a.session_id
        ),
        latest AS (
            SELECT user_id, question_id, verdict,
                   ROW_NUMBER() OVER (PARTITION BY user_id, question_id
                                      ORDER BY created_at DESC, id DESC) AS rn
            FROM answered
        )
        SELECT l.user_id, l.question_id,
               (SELECT COUNT(*) FROM answered x
                WHERE x.user_id = l.user_id AND x.question_id = l.question_id
                  AND x.verdict IN ('incorrect', 'timeout')) AS misses
        FROM latest l
        WHERE l.rn = 1 AND l.verdict IN ('incorrect', 'timeout')
        """
    ).fetchall()

    queued = 0
    for user_id, question_id, misses in rows:
        already = conn.execute(
            "SELECT 1 FROM review_queue WHERE user_id = ? AND question_id = ?",
            (user_id, question_id),
        ).fetchone()
        if already:
            continue
        queued += 1
        ease = max(_MIN_EASE, 2.5 - 0.2 * max(0, misses - 1))
        conn.execute(
            """INSERT INTO review_queue
                 (user_id, question_id, due_at, interval_days, ease, lapses, updated_at)
               VALUES (?, ?, datetime('now', '+1 day'), 1, ?, ?, datetime('now'))""",
            (user_id, question_id, ease, misses),
        )
    return queued


def _resolve_user(
    conn: sqlite3.Connection,
    event: dict[str, Any],
    user_map: dict[int, int],
    report: RestoreReport,
    dry_run: bool,
) -> int:
    """Database id of the profile this session belongs to, creating it if new.

    Journals written before profiles existed carry no user, so those sessions
    go to profile 1 — which is exactly where the migration put them.
    """
    journal_id = int(event.get("userId") or 1)
    if journal_id in user_map:
        return user_map[journal_id]

    name = str(event.get("userName") or "").strip()
    if not name:
        user_map[journal_id] = 1
        return 1

    row = conn.execute(
        "SELECT id FROM users WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if row:
        user_map[journal_id] = int(row[0])
        return user_map[journal_id]

    if dry_run:
        report.users_added += 1
        user_map[journal_id] = 1
        return 1

    cursor = conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
    report.users_added += 1
    user_map[journal_id] = int(cursor.lastrowid)
    return user_map[journal_id]


def _restore_session(
    conn: sqlite3.Connection,
    event: dict[str, Any],
    session_map: dict[int, int],
    user_map: dict[int, int],
    report: RestoreReport,
    dry_run: bool,
) -> None:
    started_at = str(event["startedAt"])
    fmt = str(event["format"])
    filters_json = json.dumps(event.get("filters") or {}, separators=(",", ":"))
    journal_id = int(event["sessionId"])

    user_id = _resolve_user(conn, event, user_map, report, dry_run)

    existing = conn.execute(
        """SELECT id FROM sessions
           WHERE started_at = ? AND format = ? AND filters_json = ? AND user_id = ?""",
        (started_at, fmt, filters_json, user_id),
    ).fetchone()
    if existing:
        session_map[journal_id] = existing[0]
        report.sessions_skipped += 1
        return

    if dry_run:
        # No row is written, but the attempts that follow still need a mapping
        # or they would all be reported as orphans. A negative placeholder can
        # never match a real row, so their dedup lookups correctly miss.
        session_map[journal_id] = -journal_id
        report.sessions_added += 1
        return

    cursor = conn.execute(
        """INSERT INTO sessions
             (user_id, format, origin_filter, difficulty, filters_json, started_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            user_id,
            fmt,
            str(event.get("origin") or "both"),
            event.get("difficulty"),
            filters_json,
            started_at,
        ),
    )
    session_map[journal_id] = int(cursor.lastrowid)
    report.sessions_added += 1


def _restore_attempt(
    conn: sqlite3.Connection,
    event: dict[str, Any],
    session_map: dict[int, int],
    report: RestoreReport,
    dry_run: bool,
) -> None:
    session_id = session_map.get(int(event["sessionId"]))
    if session_id is None:
        # An attempt whose session line never made it to the journal. Dropping
        # it would silently lose a real answer, so it is reported instead.
        report.orphan_attempts += 1
        return

    question_id = int(event["questionId"])
    created_at = str(event["createdAt"])

    existing = conn.execute(
        """SELECT 1 FROM attempts
           WHERE session_id = ? AND question_id = ? AND created_at = ?""",
        (session_id, question_id, created_at),
    ).fetchone()
    if existing:
        report.attempts_skipped += 1
        return

    # The question must still exist: attempts.question_id is a foreign key, and
    # a bank rebuilt from scratch reissues question ids.
    if not conn.execute("SELECT 1 FROM questions WHERE id = ?", (question_id,)).fetchone():
        report.orphan_attempts += 1
        return

    if dry_run:
        report.attempts_added += 1
        return

    conn.execute(
        """INSERT INTO attempts
             (session_id, question_id, buzz_clue_ordinal, clue_count, response_text,
              verdict, judged_by, latency_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            question_id,
            event.get("buzzClueOrdinal"),
            event.get("clueCount"),
            event.get("response"),
            str(event["verdict"]),
            event.get("judgedBy"),
            event.get("latencyMs"),
            created_at,
        ),
    )
    report.attempts_added += 1


def journal_stats(path: Path | None = None) -> dict[str, int]:
    """Counts by event kind, for reporting alongside the database's own."""
    path = path or HISTORY_PATH
    counts = {"sessions": 0, "attempts": 0, "session_ends": 0, "malformed": 0}
    if not path.exists():
        return counts
    for _, event in read_journal(path):
        kind = event.get("kind")
        if kind == "session":
            counts["sessions"] += 1
        elif kind == "attempt":
            counts["attempts"] += 1
        elif kind == "session_end":
            counts["session_ends"] += 1
        else:
            counts["malformed"] += 1
    return counts
