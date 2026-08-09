import { db, parseJsonArray } from "./db";
import type { Clue, McqOption, QuizFilters, QuizQuestion, Reveal } from "./types";

/** Question selection: filters from the setup screen, plus the review queue. */

interface QuestionRow {
  id: number;
  type: "tossup" | "mcq";
  origin: "official" | "generated";
  difficulty: QuizQuestion["difficulty"];
  stem: string | null;
  source_title: string | null;
  source_url: string | null;
}

function buildWhere(filters: QuizFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = ["q.type = ?"];
  const params: unknown[] = [filters.format === "buzz" ? "tossup" : "mcq"];

  if (filters.origin !== "both") {
    clauses.push("q.origin = ?");
    params.push(filters.origin);
  }
  if (filters.difficulty && filters.difficulty !== "any") {
    clauses.push("q.difficulty = ?");
    params.push(filters.difficulty);
  }
  if (filters.tags?.length) {
    const placeholders = filters.tags.map(() => "?").join(", ");
    clauses.push(`EXISTS (
      SELECT 1 FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
      WHERE qt.question_id = q.id AND t.name IN (${placeholders}) COLLATE NOCASE
    )`);
    params.push(...filters.tags);
  }
  return { sql: clauses.join(" AND "), params };
}

function hydrate(row: QuestionRow): QuizQuestion {
  const conn = db();
  const tags = conn
    .prepare(
      `SELECT t.name FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
       WHERE qt.question_id = ? ORDER BY t.name`,
    )
    .all(row.id) as { name: string }[];

  const question: QuizQuestion = {
    id: row.id,
    type: row.type,
    origin: row.origin,
    difficulty: row.difficulty,
    tags: tags.map((t) => t.name),
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
  };

  if (row.type === "tossup") {
    question.clues = conn
      .prepare(
        "SELECT ordinal, tier, text FROM tossup_clues WHERE question_id = ? ORDER BY ordinal",
      )
      .all(row.id) as Clue[];
  } else {
    question.stem = row.stem ?? "";
    // Shuffling would break the A-D labels students read out, so options keep
    // their authored order; the correct one is never sent to the client.
    question.options = conn
      .prepare("SELECT label, text FROM mcq_options WHERE question_id = ? ORDER BY label")
      .all(row.id) as McqOption[];
  }

  return question;
}

/**
 * Pick the next question.
 *
 * `exclude` holds ids already served this session, so a short bank doesn't
 * repeat within one run. Review-mode questions (previously missed and now due)
 * are preferred in "mixed" mode, which is the default.
 */
export function nextQuestion(
  userId: number,
  filters: QuizFilters,
  exclude: number[] = [],
): QuizQuestion | null {
  const conn = db();
  const { sql, params } = buildWhere(filters);
  const notIn = exclude.length ? `AND q.id NOT IN (${exclude.map(() => "?").join(",")})` : "";

  const base = `
    SELECT q.id, q.type, q.origin, q.difficulty, q.stem,
           s.title AS source_title, s.url AS source_url
    FROM questions q
    LEFT JOIN sources s ON s.id = q.source_id
  `;

  const mode = filters.mode ?? "mixed";

  if (mode !== "fresh") {
    const due = conn
      .prepare(
        `${base}
         JOIN review_queue r ON r.question_id = q.id AND r.user_id = ?
         WHERE ${sql} ${notIn} AND r.due_at <= datetime('now')
         ORDER BY r.due_at LIMIT 1`,
      )
      .get(userId, ...params, ...exclude) as QuestionRow | undefined;
    if (due) return hydrate(due);
    if (mode === "review") return null;
  }

  // Prefer questions never attempted, then least recently attempted, so the
  // bank is worked through rather than resampled at random. Counted per user:
  // one student's progress must not make questions look stale to another.
  const fresh = conn
    .prepare(
      `${base}
       LEFT JOIN (
         SELECT a.question_id, COUNT(*) AS n, MAX(a.created_at) AS last_at
         FROM attempts a JOIN sessions se ON se.id = a.session_id
         WHERE se.user_id = ?
         GROUP BY a.question_id
       ) a ON a.question_id = q.id
       WHERE ${sql} ${notIn}
       ORDER BY COALESCE(a.n, 0) ASC, COALESCE(a.last_at, '') ASC, RANDOM()
       LIMIT 1`,
    )
    .get(userId, ...params, ...exclude) as QuestionRow | undefined;

  return fresh ? hydrate(fresh) : null;
}

export function countAvailable(filters: QuizFilters): number {
  const { sql, params } = buildWhere(filters);
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${sql}`)
    .get(...params) as { n: number };
  return row.n;
}

/** The answer side of a question, returned only after an attempt is recorded. */
export function revealOf(questionId: number): Reveal | null {
  const conn = db();
  const row = conn
    .prepare("SELECT type, answer, answer_alternates, explanation FROM questions WHERE id = ?")
    .get(questionId) as
    | { type: string; answer: string; answer_alternates: string; explanation: string | null }
    | undefined;
  if (!row) return null;

  const reveal: Reveal = {
    answer: row.answer,
    alternates: parseJsonArray(row.answer_alternates),
    explanation: row.explanation,
  };

  if (row.type === "mcq") {
    const correct = conn
      .prepare("SELECT label FROM mcq_options WHERE question_id = ? AND is_correct = 1")
      .get(questionId) as { label: string } | undefined;
    reveal.correctLabel = correct?.label;
  }
  return reveal;
}

export function allTags(): { name: string; kind: string; count: number }[] {
  return db()
    .prepare(
      `SELECT t.name, t.kind, COUNT(qt.question_id) AS count
       FROM tags t LEFT JOIN question_tags qt ON qt.tag_id = t.id
       GROUP BY t.id ORDER BY count DESC, t.name`,
    )
    .all() as { name: string; kind: string; count: number }[];
}
