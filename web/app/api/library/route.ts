import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/users";
import fs from "node:fs/promises";
import path from "node:path";
import { INBOX_DIR, db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Uploads and the queue are admin-only, the same as the page they serve. */
async function denyIfNotAdmin(): Promise<NextResponse | null> {
  try {
    await requireAdmin();
    return null;
  } catch {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }
}

const ALLOWED_EXT = new Set([".pdf", ".docx", ".doc", ".txt", ".rtf"]);
const MAX_BYTES = 64 * 1024 * 1024;

/** Strip any directory component a browser or crafted request might supply. */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return base && base !== "." && base !== ".." ? base : "upload";
}

/**
 * Accept a file upload or a link and queue it for ingestion.
 *
 * The crawler picks the queue up on `beecrawl ingest --inbox`, running the same
 * extract -> parse -> enrich path as crawled material (bee.md requirement 4).
 */
export async function POST(request: Request) {
  const denied = await denyIfNotAdmin();
  if (denied) return denied;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const { url, title } = (await request.json()) as { url?: string; title?: string };
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "Provide an http(s) URL." }, { status: 400 });
    }
    db()
      .prepare("INSERT INTO inbox (kind, path_or_url, title) VALUES ('url', ?, ?)")
      .run(url, title ?? null);
    return NextResponse.json({ ok: true, queued: url });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  const name = safeName(file.name);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type "${ext || "none"}". Use PDF, DOCX, or TXT.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is larger than 64 MB." }, { status: 400 });
  }

  await fs.mkdir(INBOX_DIR, { recursive: true });
  // Prefix with a timestamp so two uploads of the same name don't collide.
  const stored = `${Date.now()}-${name}`;
  const target = path.join(INBOX_DIR, stored);
  await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));

  db()
    .prepare("INSERT INTO inbox (kind, path_or_url, title) VALUES ('file', ?, ?)")
    .run(stored, name);

  return NextResponse.json({ ok: true, queued: name });
}

export async function GET() {
  const denied = await denyIfNotAdmin();
  if (denied) return denied;

  const items = db()
    .prepare(
      `SELECT id, kind, path_or_url, title, status, status_detail, created_at, processed_at
       FROM inbox ORDER BY id DESC LIMIT 50`,
    )
    .all();
  return NextResponse.json({ items });
}
