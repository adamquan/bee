import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db";

/**
 * Append-only journal of practice history.
 *
 * `data/bee.db` holds both the question bank and the student's history, which
 * makes the history the fragile half: the bank can always be rebuilt by
 * re-running the crawler, but a wiped or corrupted database takes every
 * recorded attempt with it — and this project has already seen one FTS
 * corruption serious enough to need a reindex.
 *
 * So every session and attempt is also appended here as one JSON object per
 * line. Appends are atomic for the small records we write, the file survives
 * anything that happens to the database, and `crawler history --restore`
 * replays it. A failed write must never break the quiz, so errors are
 * swallowed after one warning.
 */

export const HISTORY_PATH = process.env.BEE_HISTORY_PATH ?? path.join(DATA_DIR, "history.jsonl");

export type HistoryEvent =
  | {
      kind: "session";
      sessionId: number;
      /** Profile that practised. The name is carried too so a restore into a
       *  database without this profile can recreate it by name. */
      userId: number;
      userName: string;
      format: string;
      origin: string;
      difficulty: string | null;
      filters: unknown;
      startedAt: string;
    }
  | { kind: "session_end"; sessionId: number; endedAt: string }
  | {
      kind: "attempt";
      attemptId: number;
      sessionId: number;
      userId: number;
      questionId: number;
      buzzClueOrdinal: number | null;
      clueCount: number | null;
      response: string | null;
      verdict: string;
      judgedBy: string | null;
      latencyMs: number | null;
      createdAt: string;
    };

export interface ClearResult {
  cleared: { attempts: number; sessions: number; review: number };
  /** File name the journal was moved to, or null if there was none. */
  archived: string | null;
}

/**
 * Erase one profile's practice history: its attempts, sessions, and review
 * queue. Other profiles and the question bank are untouched.
 *
 * The journal is archived, not deleted. Leaving it would let
 * `crawler history --restore` silently undo the clear; deleting it would make
 * a mis-click unrecoverable, and this is the only destructive action in the
 * app. Archiving keeps both properties.
 *
 * The journal covers every profile, so archiving it also stops the *other*
 * profiles' events replaying. That is why restore recreates profiles by name
 * and skips what is already present — putting the archive back is safe.
 */
export function clearHistory(userId: number): ClearResult {
  const conn = db();

  const cleared = conn
    .prepare(
      `SELECT (SELECT COUNT(*) FROM attempts a JOIN sessions s ON s.id = a.session_id
               WHERE s.user_id = ?) AS attempts,
              (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS sessions,
              (SELECT COUNT(*) FROM review_queue WHERE user_id = ?) AS review`,
    )
    .get(userId, userId, userId) as ClearResult["cleared"];

  let archived: string | null = null;
  if (fs.existsSync(HISTORY_PATH)) {
    // Colons are illegal in Windows filenames, and this runs on Windows too.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(path.dirname(HISTORY_PATH), `history-cleared-${stamp}.jsonl`);
    // Deliberately unguarded: if the journal cannot be moved, the database
    // must not be cleared either, or a later restore would replay it.
    fs.renameSync(HISTORY_PATH, target);
    archived = path.basename(target);
  }

  // One transaction, so a partial clear cannot leave attempts pointing at
  // sessions that no longer exist.
  conn.transaction(() => {
    conn
      .prepare(
        `DELETE FROM attempts WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
      )
      .run(userId);
    conn.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    conn.prepare("DELETE FROM review_queue WHERE user_id = ?").run(userId);
  })();

  return { cleared, archived };
}

let warned = false;

export function appendHistory(event: HistoryEvent): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    // Journalling is a safety net, not a dependency. Losing it must not cost
    // the student the answer they just gave.
    if (!warned) {
      warned = true;
      console.warn(`[history] cannot write ${HISTORY_PATH}:`, error);
    }
  }
}
