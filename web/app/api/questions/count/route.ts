import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { QuizFilters } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * How many questions match the setup screen's current filters, plus a per-tag
 * breakdown under the chosen format/difficulty/source.
 *
 * The setup screen needs this to stop offering combinations that have nothing
 * behind them — "elementary + Art History" was startable and then immediately
 * ended the session.
 */
export async function POST(request: Request) {
  const filters = (await request.json()) as QuizFilters;
  const conn = db();

  const where: string[] = ["q.type = ?"];
  const params: unknown[] = [filters.format === "buzz" ? "tossup" : "mcq"];

  if (filters.origin && filters.origin !== "both") {
    where.push("q.origin = ?");
    params.push(filters.origin);
  }
  if (filters.difficulty && filters.difficulty !== "any") {
    where.push("q.difficulty = ?");
    params.push(filters.difficulty);
  }
  const base = where.join(" AND ");

  // Total for the selected categories (or everything when none are selected).
  let total: number;
  if (filters.tags?.length) {
    const placeholders = filters.tags.map(() => "?").join(", ");
    const row = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM questions q WHERE ${base} AND EXISTS (
           SELECT 1 FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
           WHERE qt.question_id = q.id AND t.name IN (${placeholders}) COLLATE NOCASE
         )`,
      )
      .get(...params, ...filters.tags) as { n: number };
    total = row.n;
  } else {
    const row = conn
      .prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${base}`)
      .get(...params) as { n: number };
    total = row.n;
  }

  // Per-category counts under the same format/difficulty/source, so a chip
  // that would yield nothing can be shown as unavailable before it's picked.
  const rows = conn
    .prepare(
      `SELECT t.name, COUNT(*) AS n
       FROM questions q
       JOIN question_tags qt ON qt.question_id = q.id
       JOIN tags t ON t.id = qt.tag_id
       WHERE ${base}
       GROUP BY t.name`,
    )
    .all(...params) as { name: string; n: number }[];

  const byTag: Record<string, number> = {};
  for (const r of rows) byTag[r.name] = r.n;

  return NextResponse.json({ total, byTag });
}
