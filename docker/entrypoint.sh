#!/bin/sh
# Install the bundled database before the app starts.
#
# The application also does this lazily on first database access, but that is
# not good enough for a deployment: rendering the sign-in page touches no
# tables, so a fresh container looked empty until somebody tried to log in —
# and a permissions problem on the volume would have surfaced then too, as a
# 500 rather than at boot.
set -eu

SEED="${BEE_SEED_DB:-/opt/bee/seed.db}"
DB="${BEE_DB_PATH:-/data/bee.db}"

if [ -s "$DB" ]; then
  echo "[bee] using the existing database at $DB"
elif [ -f "$SEED" ]; then
  mkdir -p "$(dirname "$DB")"
  # A plain copy is safe here: nothing has opened either file yet, so there is
  # no WAL to tear. `crawler seed` already took its snapshot consistently.
  cp "$SEED" "$DB"
  echo "[bee] installed the bundled database ($(wc -c < "$DB") bytes) at $DB"
else
  echo "[bee] no database and no bundled seed — starting empty"
fi

exec "$@"
