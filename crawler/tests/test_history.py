"""Replaying the practice-history journal back into the database."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from beecrawl import history

SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema.sql"


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    connection.execute("PRAGMA foreign_keys = ON")
    for qid in (101, 102, 103):
        connection.execute(
            """INSERT INTO questions (id, type, origin, difficulty, answer, fingerprint)
               VALUES (?, 'tossup', 'official', 'middle', ?, ?)""",
            (qid, f"Answer {qid}", f"fp-{qid}"),
        )
    connection.commit()
    return connection


def session_event(
    sid: int,
    started: str = "2026-07-30 10:00:00",
    user_id: int = 1,
    user_name: str = "Student",
) -> dict:
    return {
        "kind": "session",
        "sessionId": sid,
        "userId": user_id,
        "userName": user_name,
        "format": "buzz",
        "origin": "both",
        "difficulty": None,
        "filters": {"tags": [], "mode": "mixed"},
        "startedAt": started,
    }


def attempt_event(sid: int, qid: int, created: str, verdict: str = "correct") -> dict:
    return {
        "kind": "attempt",
        "attemptId": qid,
        "sessionId": sid,
        "questionId": qid,
        "buzzClueOrdinal": 1,
        "clueCount": 4,
        "response": "spoken answer",
        "verdict": verdict,
        "judgedBy": "exact",
        "latencyMs": 2500,
        "createdAt": created,
    }


def write(tmp_path: Path, events: list[dict]) -> Path:
    path = tmp_path / "history.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")
    return path


def counts(conn: sqlite3.Connection) -> tuple[int, int]:
    return (
        conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
        conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0],
    )


def test_restores_sessions_and_attempts_into_an_empty_database(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            attempt_event(1, 102, "2026-07-30 10:00:20", "incorrect"),
            {"kind": "session_end", "sessionId": 1, "endedAt": "2026-07-30 10:05:00"},
        ],
    )

    report = history.restore(conn, path)

    assert (report.sessions_added, report.attempts_added) == (1, 2)
    assert counts(conn) == (1, 2)
    assert conn.execute("SELECT ended_at FROM sessions").fetchone()[0] == "2026-07-30 10:05:00"


def test_preserves_the_recorded_fields(conn, tmp_path):
    path = write(tmp_path, [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")])
    history.restore(conn, path)

    row = conn.execute(
        """SELECT buzz_clue_ordinal, clue_count, response_text, verdict, judged_by,
                  latency_ms, created_at FROM attempts"""
    ).fetchone()
    assert row == (1, 4, "spoken answer", "correct", "exact", 2500, "2026-07-30 10:00:05")


def test_restore_is_idempotent(conn, tmp_path):
    path = write(
        tmp_path,
        [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")],
    )

    history.restore(conn, path)
    second = history.restore(conn, path)

    assert (second.sessions_added, second.attempts_added) == (0, 0)
    assert (second.sessions_skipped, second.attempts_skipped) == (1, 1)
    assert counts(conn) == (1, 1)


def test_remaps_session_ids_that_were_reissued_after_the_loss(conn, tmp_path):
    """The journal's session id 1 must not collide with a different session 1."""
    conn.execute(
        """INSERT INTO sessions (id, format, origin_filter, filters_json, started_at)
           VALUES (1, 'mcq', 'both', '{}', '2026-07-31 09:00:00')"""
    )
    conn.commit()

    path = write(
        tmp_path,
        [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")],
    )
    history.restore(conn, path)

    assert counts(conn) == (2, 1)
    # The restored attempt hangs off the new row, not the unrelated pre-existing one.
    session_id, started = conn.execute(
        """SELECT s.id, s.started_at FROM attempts a JOIN sessions s ON s.id = a.session_id"""
    ).fetchone()
    assert session_id != 1
    assert started == "2026-07-30 10:00:00"


def test_merges_into_a_database_that_already_has_newer_practice(conn, tmp_path):
    path = write(tmp_path, [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")])
    history.restore(conn, path)

    # A later session is journalled and restored; the first must survive.
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            session_event(2, "2026-07-31 11:00:00"),
            attempt_event(2, 103, "2026-07-31 11:00:09"),
        ],
    )
    report = history.restore(conn, path)

    assert (report.sessions_added, report.attempts_added) == (1, 1)
    assert counts(conn) == (2, 2)


def test_skips_attempts_whose_question_is_gone(conn, tmp_path):
    path = write(tmp_path, [session_event(1), attempt_event(1, 999, "2026-07-30 10:00:05")])
    report = history.restore(conn, path)

    assert report.orphan_attempts == 1
    assert counts(conn) == (1, 0)


def test_skips_an_attempt_whose_session_line_is_missing(conn, tmp_path):
    path = write(tmp_path, [attempt_event(7, 101, "2026-07-30 10:00:05")])
    report = history.restore(conn, path)

    assert report.orphan_attempts == 1
    assert counts(conn) == (0, 0)


def test_a_truncated_final_line_does_not_lose_the_rest(conn, tmp_path):
    path = write(tmp_path, [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")])
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"kind":"attempt","sessionId":1,"quest')  # killed mid-append

    report = history.restore(conn, path)

    assert report.malformed_lines == 1
    assert counts(conn) == (1, 1)


def test_blank_lines_are_ignored(conn, tmp_path):
    path = write(tmp_path, [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05")])
    path.write_text(path.read_text() + "\n\n\n", encoding="utf-8")

    report = history.restore(conn, path)
    assert report.malformed_lines == 0
    assert counts(conn) == (1, 1)


def test_dry_run_changes_nothing_but_reports_the_same_totals(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            attempt_event(1, 102, "2026-07-30 10:00:20"),
        ],
    )

    planned = history.restore(conn, path, dry_run=True)
    assert (planned.sessions_added, planned.attempts_added) == (1, 2)
    assert counts(conn) == (0, 0)

    applied = history.restore(conn, path)
    assert (applied.sessions_added, applied.attempts_added) == (1, 2)
    assert counts(conn) == (1, 2)


def test_missing_journal_is_not_an_error(conn, tmp_path):
    report = history.restore(conn, tmp_path / "nope.jsonl")
    assert report.added == 0
    assert counts(conn) == (0, 0)


def queue(conn: sqlite3.Connection) -> dict[int, tuple[float, int]]:
    return {
        row[0]: (row[1], row[2])
        for row in conn.execute("SELECT question_id, ease, lapses FROM review_queue")
    }


def test_restore_re_queues_questions_whose_last_attempt_was_a_miss(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect"),
            attempt_event(1, 102, "2026-07-30 10:00:20", "timeout"),
            attempt_event(1, 103, "2026-07-30 10:00:35", "correct"),
        ],
    )
    report = history.restore(conn, path)

    assert report.review_queued == 2
    assert set(queue(conn)) == {101, 102}  # 103 was answered correctly


def test_a_question_missed_then_answered_correctly_is_not_re_queued(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect"),
            attempt_event(1, 101, "2026-07-30 10:01:05", "correct"),
        ],
    )
    history.restore(conn, path)
    assert queue(conn) == {}


def test_repeated_misses_lower_the_ease_and_count_as_lapses(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect"),
            attempt_event(1, 101, "2026-07-30 10:01:05", "incorrect"),
            attempt_event(1, 101, "2026-07-30 10:02:05", "timeout"),
        ],
    )
    history.restore(conn, path)

    ease, lapses = queue(conn)[101]
    assert lapses == 3
    assert ease == pytest.approx(2.5 - 0.2 * 2)


def test_ease_never_falls_below_the_floor(conn, tmp_path):
    events = [session_event(1)]
    for i in range(20):
        events.append(attempt_event(1, 101, f"2026-07-30 10:{i:02d}:00", "incorrect"))
    history.restore(conn, write(tmp_path, events))

    ease, lapses = queue(conn)[101]
    assert lapses == 20
    assert ease == pytest.approx(1.3)


def test_an_existing_queue_entry_is_left_alone(conn, tmp_path):
    conn.execute(
        """INSERT INTO review_queue (question_id, due_at, interval_days, ease, lapses)
           VALUES (101, datetime('now', '+30 day'), 30, 2.9, 1)"""
    )
    conn.commit()
    path = write(
        tmp_path,
        [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect")],
    )
    report = history.restore(conn, path)

    assert report.review_queued == 0
    # The live scheduler's state wins; restore must not reset a real interval.
    assert conn.execute("SELECT interval_days FROM review_queue").fetchone()[0] == 30


def test_dry_run_does_not_touch_or_project_the_review_queue(conn, tmp_path):
    path = write(
        tmp_path,
        [session_event(1), attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect")],
    )
    report = history.restore(conn, path, dry_run=True)

    # No attempts were written, so there is nothing to derive the queue from.
    # Reporting 0 here would read as "nothing to re-queue", which is why the
    # CLI omits the line entirely on a dry run.
    assert report.review_queued == 0
    assert queue(conn) == {}


def test_journal_stats_counts_by_kind(tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            attempt_event(1, 102, "2026-07-30 10:00:20"),
            {"kind": "session_end", "sessionId": 1, "endedAt": "2026-07-30 10:05:00"},
        ],
    )
    assert history.journal_stats(path) == {
        "sessions": 1,
        "attempts": 2,
        "session_ends": 1,
        "malformed": 0,
    }


def test_journal_stats_on_a_missing_file(tmp_path):
    assert history.journal_stats(tmp_path / "nope.jsonl")["attempts"] == 0


def test_restore_recreates_a_profile_the_journal_names(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1, user_id=1, user_name="Student"),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            session_event(2, "2026-07-30 11:00:00", user_id=7, user_name="Alex"),
            attempt_event(2, 102, "2026-07-30 11:00:09", "incorrect"),
        ],
    )
    report = history.restore(conn, path)

    assert report.users_added == 1  # Alex; "Student" already exists as user 1
    names = [r[0] for r in conn.execute("SELECT name FROM users ORDER BY id")]
    assert names == ["Student", "Alex"]

    # Each session lands under its own profile, by name rather than journal id.
    rows = dict(
        conn.execute(
            """SELECT u.name, COUNT(a.id) FROM users u
               JOIN sessions s ON s.user_id = u.id
               JOIN attempts a ON a.session_id = s.id
               GROUP BY u.id"""
        )
    )
    assert rows == {"Student": 1, "Alex": 1}


def test_profiles_are_matched_by_name_not_by_journal_id(conn, tmp_path):
    conn.execute("INSERT INTO users (id, name) VALUES (4, 'Alex')")
    conn.commit()

    path = write(
        tmp_path,
        [session_event(1, user_id=99, user_name="Alex"), attempt_event(1, 101, "2026-07-30 10:00:05")],
    )
    report = history.restore(conn, path)

    assert report.users_added == 0
    assert conn.execute("SELECT user_id FROM sessions").fetchone()[0] == 4


def test_a_journal_written_before_profiles_lands_on_the_default(conn, tmp_path):
    legacy_session = {
        "kind": "session",
        "sessionId": 1,
        "format": "buzz",
        "origin": "both",
        "difficulty": None,
        "filters": {"tags": [], "mode": "mixed"},
        "startedAt": "2026-07-30 10:00:00",
    }
    path = write(tmp_path, [legacy_session, attempt_event(1, 101, "2026-07-30 10:00:05")])
    report = history.restore(conn, path)

    assert report.users_added == 0
    assert conn.execute("SELECT user_id FROM sessions").fetchone()[0] == 1


def test_the_review_queue_is_rebuilt_per_profile(conn, tmp_path):
    path = write(
        tmp_path,
        [
            session_event(1, user_id=1, user_name="Student"),
            attempt_event(1, 101, "2026-07-30 10:00:05", "incorrect"),
            session_event(2, "2026-07-30 11:00:00", user_id=7, user_name="Alex"),
            attempt_event(2, 101, "2026-07-30 11:00:09", "incorrect"),
        ],
    )
    history.restore(conn, path)

    # The same question, missed by both, is queued once for each.
    rows = sorted(conn.execute("SELECT user_id, question_id FROM review_queue"))
    assert len(rows) == 2
    assert {r[1] for r in rows} == {101}
    assert len({r[0] for r in rows}) == 2


def test_two_profiles_with_the_same_started_at_stay_separate(conn, tmp_path):
    """The session natural key must include the profile, or one would swallow
    the other's identically-timed session."""
    path = write(
        tmp_path,
        [
            session_event(1, "2026-07-30 10:00:00", user_id=1, user_name="Student"),
            attempt_event(1, 101, "2026-07-30 10:00:05"),
            session_event(2, "2026-07-30 10:00:00", user_id=7, user_name="Alex"),
            attempt_event(2, 102, "2026-07-30 10:00:06"),
        ],
    )
    history.restore(conn, path)

    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 2
