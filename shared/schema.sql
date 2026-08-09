-- History Bee/Bowl Trainer — shared SQLite schema.
-- Applied by both the Python crawler and the Next.js web app; safe to re-run.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- sources ---
-- One row per fetched URL (web page, PDF, DOCX, Google Doc) or user upload.
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  host          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'unknown',
                -- 'packet' | 'exam' | 'studyguide' | 'rules' | 'index' | 'upload' | 'unknown'
  content_type  TEXT,
  title         TEXT,
  sha256        TEXT,
  cache_path    TEXT,
  bytes         INTEGER,
  fetched_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- 'pending' | 'fetched' | 'extracted' | 'parsed' | 'robots_denied' | 'error' | 'skipped'
  status_detail TEXT,
  depth         INTEGER NOT NULL DEFAULT 0,
  discovered_from INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  -- Content-Signal / robots.txt derived. 0 => never use this text as LLM
  -- training or fine-tuning input; reference + quizzing use only.
  ai_train_ok   INTEGER NOT NULL DEFAULT 1,
  license_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_kind   ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_host   ON sources(host);

-- Extracted plain text, kept separate so `sources` stays cheap to scan.
CREATE TABLE IF NOT EXISTS source_texts (
  source_id    INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  char_count   INTEGER NOT NULL,
  extracted_at TEXT NOT NULL
);

-- -------------------------------------------------------------- questions ---
CREATE TABLE IF NOT EXISTS questions (
  id                INTEGER PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN ('tossup', 'mcq')),
  origin            TEXT NOT NULL CHECK (origin IN ('official', 'generated')),
  source_id         INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  difficulty        TEXT NOT NULL DEFAULT 'middle'
                    CHECK (difficulty IN ('elementary', 'middle', 'high', 'open')),
  -- MCQ stem. NULL for tossups (their text lives in tossup_clues).
  stem              TEXT,
  answer            TEXT NOT NULL,
  answer_alternates TEXT NOT NULL DEFAULT '[]',   -- JSON array of accepted strings
  explanation       TEXT,
  -- sha256 of (normalized answer || first clue/stem) — the dedup key.
  fingerprint       TEXT NOT NULL UNIQUE,
  enriched          INTEGER NOT NULL DEFAULT 0,   -- 1 once tags/explanation exist
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_type_origin ON questions(type, origin);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty  ON questions(difficulty);
CREATE INDEX IF NOT EXISTS idx_questions_enriched    ON questions(enriched);

-- Pyramidal tossup clues, revealed one at a time.
CREATE TABLE IF NOT EXISTS tossup_clues (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,           -- 0-based reveal order
  tier        TEXT NOT NULL CHECK (tier IN ('leadin', 'middle', 'giveaway')),
  text        TEXT NOT NULL,
  PRIMARY KEY (question_id, ordinal)
);

CREATE TABLE IF NOT EXISTS mcq_options (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,              -- 'A' | 'B' | 'C' | 'D'
  text        TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, label)
);

-- ------------------------------------------------------------------- tags ---
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'topic'      -- 'era' | 'region' | 'topic'
);

CREATE TABLE IF NOT EXISTS question_tags (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_question_tags_tag ON question_tags(tag_id);

-- Every source a question appears in, not just the one that contributed it.
--
-- IHBB republishes the same tossup across regional and divisional packets, so
-- a question is imported once from whichever copy the crawler parsed first and
-- rejected as a duplicate everywhere else. `questions.source_id` names only
-- that first copy, which made the Library page report packets of 60 questions
-- as having contributed "1". This records the rest of the appearances.
CREATE TABLE IF NOT EXISTS question_sources (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_question_sources_source ON question_sources(source_id);

-- Study resources suggested per weak area — real crawled URLs, never invented.
CREATE TABLE IF NOT EXISTS source_tags (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
);

-- ------------------------------------------------------- full-text search ---
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  body,
  answer,
  question_id UNINDEXED,
  tokenize = 'porter unicode61'
);

-- --------------------------------------------------------------- practice ---
-- Accounts. Every page of the app requires a signed-in one.
--
-- Anyone may register; an admin approves. Approval issues a single-use link by
-- email through which the account sets its own password — no password is ever
-- chosen for someone else, and none is transmitted.
--
-- `email` carries a UNIQUE index rather than a column constraint, because the
-- migration adds the column to existing databases and SQLite cannot ALTER a
-- column into being UNIQUE.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  email         TEXT,
  -- scrypt. NULL until the account sets a password from its invite link, so a
  -- freshly approved account can never be signed into with a guessable value.
  password_hash TEXT,
  password_salt TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  -- 'pending'  registered, waiting on the admin
  -- 'approved' may sign in (once a password is set)
  -- 'rejected' turned down; kept so the address cannot silently re-register
  status        TEXT NOT NULL DEFAULT 'approved'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  last_login_at TEXT
);

-- The indexes on `email` and `status` live in the migration, not here. This
-- file is applied to older databases too, where those columns do not exist
-- yet, and indexing a missing column aborts the whole script before the
-- migration gets a chance to add it. (SQLite lets a unique index hold many
-- NULLs, which is what accounts predating emails need.)

-- Signed-in browsers. Server-side rather than a self-contained cookie so an
-- admin rejecting an account cuts its access immediately.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,          -- random, opaque; the cookie value
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Single-use links: "set your password" after approval, and password resets.
-- Only a hash of the token is stored, so a leaked database cannot be used to
-- claim an outstanding invite.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('set-password')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

-- Failed sign-in attempts, for rate limiting. Keyed by email and by client
-- address so neither a single account nor a single host can be hammered.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id       INTEGER PRIMARY KEY,
  key      TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_key ON auth_attempts(key, at);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
  format       TEXT NOT NULL CHECK (format IN ('buzz', 'mcq')),
  origin_filter TEXT NOT NULL DEFAULT 'both'
               CHECK (origin_filter IN ('official', 'generated', 'both')),
  difficulty   TEXT,
  filters_json TEXT NOT NULL DEFAULT '{}',   -- {"tags": [...], "mode": "..."}
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id      INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  -- For tossups: which clue was on screen when the student buzzed. Lower is
  -- better; NULL means they never buzzed. Powers the "buzz position" metric.
  buzz_clue_ordinal INTEGER,
  clue_count       INTEGER,
  response_text    TEXT,
  verdict          TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'timeout', 'skipped')),
  judged_by        TEXT,                  -- 'exact' | 'fuzzy' | 'llm' | 'mcq' | 'timeout'
  latency_ms       INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_session  ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
CREATE INDEX IF NOT EXISTS idx_attempts_created  ON attempts(created_at);

-- SM-2-ish spaced repetition over missed questions.
-- One schedule per user per question: two students miss different things, so a
-- globally-keyed queue would let one person's misses drive another's drills.
CREATE TABLE IF NOT EXISTS review_queue (
  user_id       INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  due_at        TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 1,
  ease          REAL NOT NULL DEFAULT 2.5,
  lapses        INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);

-- The indexes on user_id live in the migration, not here. This file is applied
-- to old databases too, where those columns do not exist yet — and an index on
-- a missing column aborts the whole script before the migration can add it.

CREATE INDEX IF NOT EXISTS idx_review_due ON review_queue(due_at);

-- -------------------------------------------------------------- pipeline ----
-- Text that looked like a question but failed to parse cleanly. Surfaced by
-- `crawler stats` rather than silently dropped.
CREATE TABLE IF NOT EXISTS quarantine (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Web app drops uploads/links here; the crawler picks them up on `ingest`.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('file', 'url')),
  path_or_url  TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'done', 'error')),
  status_detail TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

-- Targeted generation requests queued by the dashboard's "drill this" action.
CREATE TABLE IF NOT EXISTS generation_jobs (
  id           INTEGER PRIMARY KEY,
  tag_name     TEXT,
  difficulty   TEXT NOT NULL DEFAULT 'middle',
  format       TEXT NOT NULL DEFAULT 'tossup' CHECK (format IN ('tossup', 'mcq')),
  count        INTEGER NOT NULL DEFAULT 10,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'error')),
  status_detail TEXT,
  batch_id     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

-- ------------------------------------------------------------ tag seeding ---
-- Controlled vocabulary from bee.md requirement 3. Insert-only; re-runnable.
INSERT OR IGNORE INTO tags (name, kind) VALUES
  ('US History',           'region'),
  ('European History',     'region'),
  ('Asian History',        'region'),
  ('African History',      'region'),
  ('Latin American History','region'),
  ('Middle Eastern History','region'),
  ('World History',        'region'),
  ('Ancient World',        'era'),
  ('Middle Ages',          'era'),
  ('Renaissance',          'era'),
  ('Exploration',          'era'),
  ('Early Modern',         'era'),
  ('Modern',               'era'),
  ('Contemporary',         'era'),
  ('Revolutions',          'topic'),
  ('World Wars',           'topic'),
  ('Empires',              'topic'),
  ('Leaders',              'topic'),
  ('Religions',            'topic'),
  ('Art History',          'topic'),
  ('Sports History',       'topic'),
  ('Literature History',   'topic'),
  ('Science History',      'topic'),
  ('Military History',     'topic'),
  ('Economic History',     'topic'),
  ('Mythology',            'topic'),
  ('Historical Geography', 'topic'),
  ('Politics',             'topic'),
  ('Social Movements',     'topic'),
  ('Technology',           'topic');

-- Account 1 always exists: it owns every session recorded before accounts had
-- identities. It has no email and no password, so it cannot be signed into
-- until the bootstrap names an admin — see `crawler admin`.
--
-- Only `id` and `name` are named here on purpose. This file is also applied to
-- databases that predate the auth columns, and referencing one that does not
-- exist yet aborts the script before the migration can add it.
INSERT OR IGNORE INTO users (id, name) VALUES (1, 'Student');
