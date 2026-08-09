import { db } from "./db";
import type { Verdict } from "./types";

/**
 * Spaced repetition over missed questions (bee.md requirement 2: "Save wrong
 * questions for retaking").
 *
 * SM-2 in miniature: a miss resets the interval and lowers ease; a later
 * correct answer grows the interval by the ease factor. Getting it right on
 * the first showing never schedules a review at all.
 */

const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 180;

export function recordReview(userId: number, questionId: number, verdict: Verdict): void {
  const conn = db();
  const existing = conn
    .prepare(
      "SELECT interval_days, ease, lapses FROM review_queue WHERE user_id = ? AND question_id = ?",
    )
    .get(userId, questionId) as
    | { interval_days: number; ease: number; lapses: number }
    | undefined;

  const missed = verdict === "incorrect" || verdict === "timeout";

  if (!existing) {
    if (!missed) return; // nothing to review
    conn
      .prepare(
        `INSERT INTO review_queue
           (user_id, question_id, due_at, interval_days, ease, lapses, updated_at)
         VALUES (?, ?, datetime('now', '+1 day'), 1, 2.5, 1, datetime('now'))`,
      )
      .run(userId, questionId);
    return;
  }

  if (missed) {
    const ease = Math.max(MIN_EASE, existing.ease - 0.2);
    conn
      .prepare(
        `UPDATE review_queue
         SET due_at = datetime('now', '+1 day'), interval_days = 1,
             ease = ?, lapses = lapses + 1, updated_at = datetime('now')
         WHERE user_id = ? AND question_id = ?`,
      )
      .run(ease, userId, questionId);
    return;
  }

  const nextInterval = Math.min(
    MAX_INTERVAL_DAYS,
    Math.max(1, Math.round(existing.interval_days * existing.ease)),
  );
  // Graduated: answered correctly after a lapse and now far out. Drop it.
  if (nextInterval >= MAX_INTERVAL_DAYS) {
    conn.prepare("DELETE FROM review_queue WHERE user_id = ? AND question_id = ?")
      .run(userId, questionId);
    return;
  }

  conn
    .prepare(
      `UPDATE review_queue
       SET due_at = datetime('now', '+' || ? || ' days'),
           interval_days = ?, ease = ?, updated_at = datetime('now')
       WHERE user_id = ? AND question_id = ?`,
    )
    .run(nextInterval, nextInterval, Math.min(3.0, existing.ease + 0.05), userId, questionId);
}

export function reviewCounts(userId: number): { total: number; due: number } {
  const conn = db();
  const total = conn
    .prepare("SELECT COUNT(*) AS n FROM review_queue WHERE user_id = ?")
    .get(userId) as { n: number };
  const due = conn
    .prepare(
      "SELECT COUNT(*) AS n FROM review_queue WHERE user_id = ? AND due_at <= datetime('now')",
    )
    .get(userId) as { n: number };
  return { total: total.n, due: due.n };
}

export interface ReviewItem {
  questionId: number;
  type: "tossup" | "mcq";
  answer: string;
  prompt: string;
  lapses: number;
  dueAt: string;
  overdue: boolean;
}

export function reviewList(userId: number, limit = 40): ReviewItem[] {
  const rows = db()
    .prepare(
      `SELECT r.question_id, r.due_at, r.lapses, q.type, q.answer, q.stem,
              (SELECT text FROM tossup_clues
               WHERE question_id = q.id ORDER BY ordinal DESC LIMIT 1) AS giveaway,
              (r.due_at <= datetime('now')) AS overdue
       FROM review_queue r JOIN questions q ON q.id = r.question_id
       WHERE r.user_id = ?
       ORDER BY r.due_at LIMIT ?`,
    )
    .all(userId, limit) as {
    question_id: number;
    due_at: string;
    lapses: number;
    type: "tossup" | "mcq";
    answer: string;
    stem: string | null;
    giveaway: string | null;
    overdue: number;
  }[];

  return rows.map((r) => ({
    questionId: r.question_id,
    type: r.type,
    answer: r.answer,
    prompt: (r.type === "mcq" ? r.stem : r.giveaway) ?? "",
    lapses: r.lapses,
    dueAt: r.due_at,
    overdue: Boolean(r.overdue),
  }));
}
