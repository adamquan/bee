"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/** Upload files or add links (bee.md requirement 4). */
export default function LibraryUploader() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function send(body: FormData | string) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/library", {
        method: "POST",
        ...(typeof body === "string"
          ? { headers: { "content-type": "application/json" }, body }
          : { body }),
      });
      const data = (await response.json()) as { error?: string; queued?: string };
      if (!response.ok) throw new Error(data.error ?? "Upload failed.");
      setNote({ tone: "ok", text: `Queued ${data.queued} for ingestion.` });
      router.refresh();
    } catch (error) {
      setNote({ tone: "bad", text: error instanceof Error ? error.message : "Upload failed." });
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      await send(form);
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <section className="card p-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <span className="label">Upload documents</span>
          <label
            className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-ink-600 px-4 py-8 text-center transition-colors hover:border-honey-500 hover:bg-ink-850"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void onFiles(event.dataTransfer.files);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.docx,.doc,.txt,.rtf"
              className="sr-only"
              onChange={(event) => void onFiles(event.target.files)}
              disabled={busy}
            />
            <span className="text-sm text-ink-300">Drop files here, or click to choose</span>
            <span className="mt-1 text-xs text-ink-400">PDF, DOCX, or TXT · up to 64 MB each</span>
          </label>
        </div>

        <div>
          <span className="label">Add a link</span>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!url.trim()) return;
              void send(JSON.stringify({ url: url.trim() }));
              setUrl("");
            }}
          >
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/packet.pdf"
              className="field"
              disabled={busy}
            />
            <button type="submit" className="btn-primary shrink-0" disabled={busy || !url.trim()}>
              Add
            </button>
          </form>
          <p className="mt-2 text-xs text-ink-400">
            Links are fetched with the same robots.txt and rate-limit rules as the crawler.
          </p>
        </div>
      </div>

      {note && (
        <p className={`mt-4 text-sm ${note.tone === "ok" ? "text-good-400" : "text-bad-400"}`}>
          {note.text}
        </p>
      )}
    </section>
  );
}
