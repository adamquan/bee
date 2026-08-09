import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appendHistory } from "@/lib/history";
import { NotSignedInError, currentUserId } from "@/lib/users";
import type { QuizFilters } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Start a practice session and get its id back. */
export async function POST(request: Request) {
  const filters = (await request.json()) as QuizFilters;
  const conn = db();

  let userId: number;
  try {
    userId = await currentUserId();
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  const origin = filters.origin ?? "both";
  const difficulty = filters.difficulty === "any" ? null : (filters.difficulty ?? null);
  const filtersJson = JSON.stringify({ tags: filters.tags ?? [], mode: filters.mode ?? "mixed" });

  const info = conn
    .prepare(
      `INSERT INTO sessions (user_id, format, origin_filter, difficulty, filters_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, filters.format, origin, difficulty, filtersJson);

  const sessionId = Number(info.lastInsertRowid);
  const row = conn.prepare("SELECT started_at FROM sessions WHERE id = ?").get(sessionId) as {
    started_at: string;
  };

  appendHistory({
    kind: "session",
    sessionId,
    userId,
    userName: (
      conn.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string }
    ).name,
    format: filters.format,
    origin,
    difficulty,
    filters: JSON.parse(filtersJson),
    startedAt: row.started_at,
  });

  return NextResponse.json({ sessionId });
}

/** Close a session. */
export async function PATCH(request: Request) {
  const { sessionId } = (await request.json()) as { sessionId: number };
  const conn = db();

  let userId: number;
  try {
    userId = await currentUserId();
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }
  conn
    .prepare(
      `UPDATE sessions SET ended_at = datetime('now')
       WHERE id = ? AND user_id = ? AND ended_at IS NULL`,
    )
    .run(sessionId, userId);

  const row = conn.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId) as
    | { ended_at: string | null }
    | undefined;
  if (row?.ended_at) {
    appendHistory({ kind: "session_end", sessionId, endedAt: row.ended_at });
  }

  return NextResponse.json({ ok: true });
}
