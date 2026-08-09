"""Bootstrap and repair the admin account from the command line.

The web app cannot create the first admin — every page of it requires being
signed in already. This is the way in, and it is deliberately the only one:
no default password ships anywhere, so a fresh install has nothing to guess.
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3

TOKEN_HOURS = 48


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_set_password_token(conn: sqlite3.Connection, user_id: int) -> str:
    """Mint a single-use link. Only its hash is stored."""
    token = secrets.token_urlsafe(32)
    conn.execute(
        """INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
           VALUES (?, ?, 'set-password', datetime('now', ?))""",
        (_token_hash(token), user_id, f"+{TOKEN_HOURS} hours"),
    )
    conn.commit()
    return token


def ensure_admin(conn: sqlite3.Connection, name: str, email: str) -> tuple[int, str, bool]:
    """Make `email` the admin, and return `(id, invite token, created)`.

    Which row gets claimed, in order:

    1. One already carrying that email address.
    2. One already carrying that display name — a profile the person made for
       themselves before accounts had logins is still their account.
    3. Account 1, if it never got an email. It owns the practice recorded
       before profiles existed, so claiming it keeps that history attached to
       a real person instead of stranding it on an anonymous row.
    4. Otherwise a new account.

    Never renames a row out from under a different account.
    """
    email = email.strip().lower()
    created = False

    row = conn.execute(
        "SELECT id FROM users WHERE email = ? COLLATE NOCASE", (email,)
    ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT id FROM users WHERE name = ? COLLATE NOCASE AND email IS NULL", (name,)
        ).fetchone()
    if not row:
        row = conn.execute("SELECT id FROM users WHERE id = 1 AND email IS NULL").fetchone()

    if row:
        user_id = int(row[0])
    else:
        cursor = conn.execute(
            """INSERT INTO users (name, email, role, status, approved_at)
               VALUES (?, ?, 'admin', 'approved', datetime('now'))""",
            (name, email),
        )
        user_id = int(cursor.lastrowid)
        created = True

    clash = conn.execute(
        "SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?", (name, user_id)
    ).fetchone()
    if clash:
        raise ValueError(
            f"Another account (id {clash[0]}) is already called {name!r}. "
            "Rename or remove it first, or choose a different --name."
        )

    conn.execute(
        """UPDATE users
           SET name = ?, email = ?, role = 'admin', status = 'approved',
               approved_at = COALESCE(approved_at, datetime('now'))
           WHERE id = ?""",
        (name, email, user_id),
    )
    conn.commit()

    return user_id, issue_set_password_token(conn, user_id), created


def clear_password(conn: sqlite3.Connection, user_id: int) -> None:
    """Forget a password so the invite link is the only way back in."""
    conn.execute(
        "UPDATE users SET password_hash = NULL, password_salt = NULL WHERE id = ?",
        (user_id,),
    )
    conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
    conn.commit()
