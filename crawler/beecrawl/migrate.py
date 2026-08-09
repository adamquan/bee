"""In-place upgrades for databases created before a schema change.

`shared/schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so it builds a correct
database from nothing but never alters one that already exists. Anything that
changes an existing table — a new column, a different primary key — has to be
done here.

The web app carries the same migrations in `web/lib/migrate.ts`; either process
may open the database first, so both must be able to perform them. Keep the two
in step when adding one.
"""

from __future__ import annotations

import sqlite3


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


DEFAULT_USER_ID = 1
DEFAULT_USER_NAME = "Student"


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Bring an existing database up to the current schema. Idempotent."""
    applied: list[str] = []

    # Profiles. Everything recorded before they existed belongs to user 1.
    if not _table_exists(conn, "users"):
        conn.execute(
            """CREATE TABLE users (
                 id         INTEGER PRIMARY KEY,
                 name       TEXT NOT NULL UNIQUE,
                 created_at TEXT NOT NULL DEFAULT (datetime('now'))
               )"""
        )
        applied.append("created users")
    conn.execute(
        "INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)",
        (DEFAULT_USER_ID, DEFAULT_USER_NAME),
    )

    if _table_exists(conn, "sessions") and "user_id" not in _columns(conn, "sessions"):
        # A constant default is the only kind SQLite allows on ADD COLUMN, which
        # is exactly what backfilling every existing session to user 1 needs.
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1"
        )
        applied.append("sessions.user_id")

    # Accounts grew credentials, a role, and an approval state. SQLite cannot
    # ALTER a column into being UNIQUE, so `email` gets a unique index instead
    # (which permits the many NULLs that pre-auth accounts have).
    if _table_exists(conn, "users"):
        existing = _columns(conn, "users")
        for column, ddl in (
            ("email", "TEXT"),
            ("password_hash", "TEXT"),
            ("password_salt", "TEXT"),
            ("role", "TEXT NOT NULL DEFAULT 'member'"),
            ("status", "TEXT NOT NULL DEFAULT 'approved'"),
            ("approved_at", "TEXT"),
            ("last_login_at", "TEXT"),
        ):
            if column not in existing:
                conn.execute(f"ALTER TABLE users ADD COLUMN {column} {ddl}")
                applied.append(f"users.{column}")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)")

    # review_queue was keyed by question alone, so two students shared one
    # schedule. Changing a primary key means rebuilding the table.
    if _table_exists(conn, "review_queue") and "user_id" not in _columns(conn, "review_queue"):
        conn.execute(
            """CREATE TABLE review_queue_migrated (
                 user_id       INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
                 question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                 due_at        TEXT NOT NULL,
                 interval_days REAL NOT NULL DEFAULT 1,
                 ease          REAL NOT NULL DEFAULT 2.5,
                 lapses        INTEGER NOT NULL DEFAULT 0,
                 updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
                 PRIMARY KEY (user_id, question_id)
               )"""
        )
        conn.execute(
            """INSERT INTO review_queue_migrated
                 (user_id, question_id, due_at, interval_days, ease, lapses, updated_at)
               SELECT ?, question_id, due_at, interval_days, ease, lapses, updated_at
               FROM review_queue""",
            (DEFAULT_USER_ID,),
        )
        conn.execute("DROP TABLE review_queue")
        conn.execute("ALTER TABLE review_queue_migrated RENAME TO review_queue")
        applied.append("review_queue keyed by (user, question)")

    # Recreated last: a rebuild above drops the table's indexes with it, and
    # schema.sql has already run by this point.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_review_queue_due ON review_queue(user_id, due_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")

    conn.commit()
    return applied
