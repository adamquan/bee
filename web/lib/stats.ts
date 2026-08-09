import { db } from "./db";
import type { TagAccuracy, WeakArea } from "./types";

/** Dashboard aggregates: history, accuracy, buzz position, and weak areas. */

export interface Overview {
  attempts: number;
  correct: number;
  accuracy: number;
  sessions: number;
  /** Mean fraction of clues heard before buzzing; lower is better. */
  buzzPosition: number | null;
  bankTotal: number;
  bankOfficial: number;
  bankGenerated: number;
}

export function overview(userId: number): Overview {
  const conn = db();
  const a = conn
    .prepare(
      `SELECT COUNT(*) AS attempts,
              SUM(a.verdict = 'correct') AS correct,
              AVG(CASE WHEN a.buzz_clue_ordinal IS NOT NULL AND a.clue_count > 1
                       THEN CAST(a.buzz_clue_ordinal AS REAL) / (a.clue_count - 1) END) AS buzz
       FROM attempts a JOIN sessions s ON s.id = a.session_id
       WHERE s.user_id = ?`,
    )
    .get(userId) as { attempts: number; correct: number | null; buzz: number | null };

  const s = conn
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
    .get(userId) as { n: number };
  const bank = conn
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(origin = 'official') AS official,
              SUM(origin = 'generated') AS generated
       FROM questions`,
    )
    .get() as { total: number; official: number | null; generated: number | null };

  return {
    attempts: a.attempts,
    correct: a.correct ?? 0,
    accuracy: a.attempts ? (a.correct ?? 0) / a.attempts : 0,
    sessions: s.n,
    buzzPosition: a.buzz,
    bankTotal: bank.total,
    bankOfficial: bank.official ?? 0,
    bankGenerated: bank.generated ?? 0,
  };
}

export interface SessionSummary {
  id: number;
  format: "buzz" | "mcq";
  startedAt: string;
  questions: number;
  correct: number;
  accuracy: number;
}

export function recentSessions(userId: number, limit = 12): SessionSummary[] {
  const rows = db()
    .prepare(
      `SELECT s.id, s.format, s.started_at,
              COUNT(a.id) AS questions,
              COALESCE(SUM(a.verdict = 'correct'), 0) AS correct
       FROM sessions s LEFT JOIN attempts a ON a.session_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id HAVING questions > 0
       ORDER BY s.started_at DESC LIMIT ?`,
    )
    .all(userId, limit) as {
    id: number;
    format: "buzz" | "mcq";
    started_at: string;
    questions: number;
    correct: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    format: r.format,
    startedAt: r.started_at,
    questions: r.questions,
    correct: r.correct,
    accuracy: r.questions ? r.correct / r.questions : 0,
  }));
}

export function accuracyByTag(userId: number, minAttempts = 1): TagAccuracy[] {
  const rows = db()
    .prepare(
      `SELECT t.name AS tag, COUNT(*) AS attempts,
              COALESCE(SUM(a.verdict = 'correct'), 0) AS correct
       FROM attempts a
       JOIN sessions se ON se.id = a.session_id
       JOIN question_tags qt ON qt.question_id = a.question_id
       JOIN tags t ON t.id = qt.tag_id
       WHERE se.user_id = ?
       GROUP BY t.id HAVING attempts >= ?
       ORDER BY (CAST(correct AS REAL) / attempts) ASC, attempts DESC`,
    )
    .all(userId, minAttempts) as { tag: string; attempts: number; correct: number }[];

  return rows.map((r) => ({ ...r, accuracy: r.correct / r.attempts }));
}

/**
 * Categories worth studying: below the student's own overall accuracy, with
 * enough attempts to be meaningful (bee.md requirement 5).
 *
 * Resources come from `sources` the crawler actually fetched, so the links are
 * real. Nothing here is model-invented.
 */
export function weakAreas(userId: number, minAttempts = 4, limit = 6): WeakArea[] {
  const conn = db();
  const o = overview(userId);
  if (o.attempts === 0) return [];

  const candidates = accuracyByTag(userId, minAttempts).filter((t) => t.accuracy < o.accuracy);

  return candidates.slice(0, limit).map((t) => {
    const unseen = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM questions q
         JOIN question_tags qt ON qt.question_id = q.id
         JOIN tags tg ON tg.id = qt.tag_id
         WHERE tg.name = ?
           AND NOT EXISTS (
                 SELECT 1 FROM attempts a JOIN sessions se ON se.id = a.session_id
                 WHERE a.question_id = q.id AND se.user_id = ?
               )`,
      )
      .get(t.tag, userId) as { n: number };

    const resources = conn
      .prepare(
        `SELECT DISTINCT COALESCE(s.title, s.url) AS title, s.url
         FROM sources s
         LEFT JOIN source_tags st ON st.source_id = s.id
         LEFT JOIN tags tg ON tg.id = st.tag_id
         WHERE s.status IN ('fetched', 'extracted', 'parsed')
           AND s.kind IN ('studyguide', 'index', 'rules')
           AND (tg.name = ? OR s.title LIKE ?)
         LIMIT 3`,
      )
      .all(t.tag, `%${t.tag}%`) as { title: string; url: string }[];

    return { ...t, unseen: unseen.n, resources };
  });
}

/** Questions the student has missed most often, for the "retake" list. */
export function mostMissed(userId: number, limit = 10) {
  return db()
    .prepare(
      `SELECT q.id, q.type, q.answer,
              COUNT(*) AS attempts,
              SUM(a.verdict != 'correct') AS misses
       FROM attempts a
       JOIN sessions se ON se.id = a.session_id
       JOIN questions q ON q.id = a.question_id
       WHERE se.user_id = ?
       GROUP BY q.id HAVING misses > 0
       ORDER BY misses DESC, attempts DESC LIMIT ?`,
    )
    .all(userId, limit) as {
    id: number;
    type: "tossup" | "mcq";
    answer: string;
    attempts: number;
    misses: number;
  }[];
}
