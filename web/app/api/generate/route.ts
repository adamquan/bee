import { NextResponse } from "next/server";
import { db, hasApiKey } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Queue a targeted generation job (the dashboard's "drill this" action).
 *
 * The crawler container runs the actual Claude calls via
 * `beecrawl generate --jobs`, so the web process never blocks on a batch.
 */
export async function POST(request: Request) {
  if (!hasApiKey()) {
    return NextResponse.json(
      { error: "Question generation needs ANTHROPIC_API_KEY to be set." },
      { status: 400 },
    );
  }

  const body = (await request.json()) as {
    tag?: string;
    difficulty?: string;
    format?: "tossup" | "mcq";
    count?: number;
  };

  const info = db()
    .prepare(
      `INSERT INTO generation_jobs (tag_name, difficulty, format, count)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      body.tag ?? null,
      body.difficulty ?? "middle",
      body.format ?? "tossup",
      Math.min(50, Math.max(1, body.count ?? 10)),
    );

  return NextResponse.json({ jobId: Number(info.lastInsertRowid), status: "pending" });
}

export async function GET() {
  const jobs = db()
    .prepare(
      `SELECT id, tag_name, difficulty, format, count, status, status_detail, created_at
       FROM generation_jobs ORDER BY id DESC LIMIT 20`,
    )
    .all();
  return NextResponse.json({ jobs });
}
