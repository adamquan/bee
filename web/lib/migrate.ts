import type Database from "better-sqlite3";

/**
 * In-place upgrades for databases created before a schema change.
 *
 * `shared/schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so it builds a
 * correct database from nothing but never alters one that already exists.
 *
 * The crawler carries the same migrations in `crawler/beecrawl/migrate.py`;
 * either process may open the database first, so both must be able to perform
 * them. Keep the two in step when adding one.
 */

export const DEFAULT_USER_ID = 1;
export const DEFAULT_USER_NAME = "Student";

function columns(conn: Database.Database, table: string): Set<string> {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function tableExists(conn: Database.Database, table: string): boolean {
  return (
    conn
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

export function migrate(conn: Database.Database): string[] {
  const applied: string[] = [];

  if (!tableExists(conn, "users")) {
    conn.exec(`CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    applied.push("created users");
  }
  conn
    .prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)")
    .run(DEFAULT_USER_ID, DEFAULT_USER_NAME);

  if (tableExists(conn, "sessions") && !columns(conn, "sessions").has("user_id")) {
    // A constant default is the only kind SQLite allows on ADD COLUMN, which is
    // exactly what backfilling every existing session to user 1 needs.
    conn.exec("ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
    applied.push("sessions.user_id");
  }

  // Accounts grew credentials, a role, and an approval state. SQLite cannot
  // ALTER a column into being UNIQUE, so `email` gets a unique index instead
  // (which permits the many NULLs that pre-auth accounts have).
  if (tableExists(conn, "users")) {
    const existing = columns(conn, "users");
    const additions: [string, string][] = [
      ["email", "TEXT"],
      ["password_hash", "TEXT"],
      ["password_salt", "TEXT"],
      ["role", "TEXT NOT NULL DEFAULT 'member'"],
      ["status", "TEXT NOT NULL DEFAULT 'approved'"],
      ["approved_at", "TEXT"],
      ["last_login_at", "TEXT"],
    ];
    for (const [column, ddl] of additions) {
      if (!existing.has(column)) {
        conn.exec(`ALTER TABLE users ADD COLUMN ${column} ${ddl}`);
        applied.push(`users.${column}`);
      }
    }
    conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)");
  }

  // review_queue was keyed by question alone, so two students shared one
  // schedule. Changing a primary key means rebuilding the table.
  if (tableExists(conn, "review_queue") && !columns(conn, "review_queue").has("user_id")) {
    conn.exec(`CREATE TABLE review_queue_migrated (
      user_id       INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
      question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      due_at        TEXT NOT NULL,
      interval_days REAL NOT NULL DEFAULT 1,
      ease          REAL NOT NULL DEFAULT 2.5,
      lapses        INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, question_id)
    )`);
    conn
      .prepare(
        `INSERT INTO review_queue_migrated
           (user_id, question_id, due_at, interval_days, ease, lapses, updated_at)
         SELECT ?, question_id, due_at, interval_days, ease, lapses, updated_at
         FROM review_queue`,
      )
      .run(DEFAULT_USER_ID);
    conn.exec("DROP TABLE review_queue");
    conn.exec("ALTER TABLE review_queue_migrated RENAME TO review_queue");
    applied.push("review_queue keyed by (user, question)");
  }

  // Recreated last: a rebuild above drops the table's indexes with it, and
  // schema.sql has already run by this point.
  conn.exec("CREATE INDEX IF NOT EXISTS idx_review_queue_due ON review_queue(user_id, due_at)");
  conn.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");

  return applied;
}
