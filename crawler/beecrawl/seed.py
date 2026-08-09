"""Build the database that ships inside the image.

`docker compose run --rm crawler seed` writes a snapshot to `data/seed.db`,
which the Dockerfile copies to `/opt/bee/seed.db`. On first boot, whichever
process opens the database first copies that seed into place — see
`db.init_db` and `web/lib/db.ts`.

**The seed lives outside `/data` on purpose.** Baking it to `/data/bee.db`
would work only until someone mounted a volume there, at which point the mount
hides the baked file and the app comes up empty. Copying it in instead means a
container with a fresh volume is fully populated *and* keeps everything written
afterwards.

The snapshot is taken through SQLite's backup API rather than by copying the
file: a plain copy of a live WAL database can capture a torn state.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

# Only needed to re-run the parser (`parse --reparse`). Together they are most
# of the file, so dropping them is the difference between a lean image and one
# carrying 30MB of extracted PDF text.
REPARSE_ONLY_TABLES = ("source_texts", "quarantine")

# Credentials and personal history. Excluded when --no-accounts is passed.
ACCOUNT_TABLES = ("auth_sessions", "auth_tokens", "auth_attempts")
HISTORY_TABLES = ("attempts", "sessions", "review_queue")


def build(
    source: Path,
    target: Path,
    *,
    accounts: bool = True,
    texts: bool = True,
) -> dict[str, int | bool]:
    """Write a snapshot of `source` to `target`. Returns a short summary."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()

    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        src.close()

    dst.execute("PRAGMA foreign_keys = ON")

    dropped: list[str] = []
    if not accounts:
        # Deleting the accounts cascades their sessions, attempts, review
        # queue, and tokens, so this has to come before the history tables or
        # the counts below would be wrong.
        dst.execute("DELETE FROM users")
        dropped.append("users")
    for table in HISTORY_TABLES if not accounts else ():
        dst.execute(f"DELETE FROM {table}")
        dropped.append(table)
    for table in ACCOUNT_TABLES:
        # Live sessions and outstanding invites are never worth shipping: the
        # sessions belong to browsers that will not exist, and a token in an
        # image is a credential in an image.
        dst.execute(f"DELETE FROM {table}")
    if not texts:
        for table in REPARSE_ONLY_TABLES:
            dst.execute(f"DELETE FROM {table}")
            dropped.append(table)

    # Anything queued for a human to process locally is meaningless elsewhere.
    dst.execute("DELETE FROM inbox")
    dst.commit()

    counts = {
        "questions": dst.execute("SELECT COUNT(*) FROM questions").fetchone()[0],
        "accounts": dst.execute("SELECT COUNT(*) FROM users").fetchone()[0],
        "attempts": dst.execute("SELECT COUNT(*) FROM attempts").fetchone()[0],
        "with_credentials": bool(
            dst.execute("SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL").fetchone()[0]
        ),
    }

    # VACUUM reclaims the space the deletes freed; without it the file stays
    # as large as the original.
    dst.execute("VACUUM")
    dst.close()

    counts["bytes"] = target.stat().st_size
    return counts


def install_if_missing(db_path: Path, seed_path: Path) -> bool:
    """Copy the seed into place when there is no database yet.

    Returns True if it copied. Never overwrites: an existing database has the
    real accounts and practice in it, and the seed is by definition older.
    """
    if db_path.exists() and db_path.stat().st_size > 0:
        return False
    if not seed_path.exists():
        return False

    db_path.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f"file:{seed_path}?mode=ro", uri=True)
    dst = sqlite3.connect(db_path)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()
    return True
