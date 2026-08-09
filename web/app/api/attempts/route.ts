import { NextResponse } from "next/server";
import { db, parseJsonArray } from "@/lib/db";
import { appendHistory } from "@/lib/history";
import { judge } from "@/lib/judge";
import { recordReview } from "@/lib/review";
import { revealOf } from "@/lib/selection";
import { NotSignedInError, currentUserId } from "@/lib/users";
import type { JudgeResult, Verdict } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AttemptBody {
  sessionId: number;
  questionId: number;
  /** Spoken or typed answer. Absent for MCQ and for timeouts. */
  response?: string;
  /** MCQ only: the option the student picked. */
  selectedLabel?: string;
  /** Tossup only: which clue was on screen at buzz time. */
  buzzClueOrdinal?: number | null;
  clueCount?: number | null;
  /** Set when the 30-second window expired with no answer. */
  timedOut?: boolean;
  latencyMs?: number;
}

/**
 * Grade an attempt, record it, and return the answer + explanation.
 *
 * Grading is server-side so the correct answer never ships to the client
 * before the student has committed to a response.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as AttemptBody;
  const conn = db();

  let userId: number;
  try {
    userId = await currentUserId();
  } catch (error) {
    // A cookie for a revoked session gets past the middleware, which can only
    // see that one exists.
    if (error instanceof NotSignedInError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  // The session must belong to the profile making the request, or a stale tab
  // left open after a profile switch would file answers under the wrong name.
  const owns = conn
    .prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
    .get(body.sessionId, userId);
  if (!owns) {
    return NextResponse.json({ error: "session belongs to another profile" }, { status: 409 });
  }

  const question = conn
    .prepare("SELECT id, type, answer, answer_alternates FROM questions WHERE id = ?")
    .get(body.questionId) as
    | { id: number; type: "tossup" | "mcq"; answer: string; answer_alternates: string }
    | undefined;

  if (!question) {
    return NextResponse.json({ error: "unknown question" }, { status: 404 });
  }

  let result: JudgeResult;

  if (body.timedOut) {
    result = { verdict: "timeout", judgedBy: "timeout", reason: "no answer within 30 seconds" };
  } else if (question.type === "mcq") {
    const correct = conn
      .prepare("SELECT label FROM mcq_options WHERE question_id = ? AND is_correct = 1")
      .get(question.id) as { label: string } | undefined;
    const verdict: Verdict = body.selectedLabel === correct?.label ? "correct" : "incorrect";
    result = { verdict, judgedBy: "mcq" };
  } else {
    result = await judge(
      body.response ?? "",
      question.answer,
      parseJsonArray(question.answer_alternates),
    );
  }

  const response = body.response ?? body.selectedLabel ?? null;
  const info = conn
    .prepare(
      `INSERT INTO attempts
         (session_id, question_id, buzz_clue_ordinal, clue_count, response_text,
          verdict, judged_by, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.sessionId,
      body.questionId,
      body.buzzClueOrdinal ?? null,
      body.clueCount ?? null,
      response,
      result.verdict,
      result.judgedBy,
      body.latencyMs ?? null,
    );

  // Mirror to the append-only journal so the attempt survives the database.
  const row = conn
    .prepare("SELECT created_at FROM attempts WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as { created_at: string };
  appendHistory({
    kind: "attempt",
    attemptId: Number(info.lastInsertRowid),
    sessionId: body.sessionId,
    userId,
    questionId: body.questionId,
    buzzClueOrdinal: body.buzzClueOrdinal ?? null,
    clueCount: body.clueCount ?? null,
    response,
    verdict: result.verdict,
    judgedBy: result.judgedBy ?? null,
    latencyMs: body.latencyMs ?? null,
    createdAt: row.created_at,
  });

  recordReview(userId, body.questionId, result.verdict);

  return NextResponse.json({ ...result, reveal: revealOf(body.questionId) });
}
