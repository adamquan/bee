"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Erase practice history, behind a confirmation.
 *
 * The confirmation is inline rather than `window.confirm` so it can name what
 * is about to be destroyed — a bare "Are you sure?" gives the student nothing
 * to check the decision against.
 */

interface Props {
  attempts: number;
  sessions: number;
  review: number;
}

export default function ClearHistoryButton({ attempts, sessions, review }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus to the confirm button so the choice is reachable from the
  // keyboard, and Escape backs out of it.
  useEffect(() => {
    if (!confirming) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/history", { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${response.status})`);
      }
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button type="button" className="btn-quiet text-bad-400" onClick={() => setConfirming(true)}>
          Clear history
        </button>
        {error && <span className="text-xs text-bad-400">{error}</span>}
      </div>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="clear-history-title"
      className="card w-full max-w-md border-bad-600/50 p-4"
    >
      <p id="clear-history-title" className="text-sm font-medium">
        Delete all practice history?
      </p>
      <p className="mt-1 text-sm text-ink-300">
        This removes <strong>{attempts.toLocaleString()}</strong> attempt
        {attempts === 1 ? "" : "s"} across <strong>{sessions.toLocaleString()}</strong> session
        {sessions === 1 ? "" : "s"}, and empties the {review.toLocaleString()}-question review
        queue. Your question bank is not affected.
      </p>
      <p className="mt-1 text-xs text-ink-400">
        The history journal is archived to <code>data/</code> first, so this can still be undone
        with <code>crawler history --restore --path</code>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          ref={confirmRef}
          type="button"
          className="btn-primary bg-bad-600 text-white hover:bg-bad-400"
          onClick={clear}
          disabled={busy}
        >
          {busy ? "Clearing…" : "Yes, delete it"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-bad-400">{error}</p>}
    </div>
  );
}
