"use client";

import { useState } from "react";

/**
 * Queue a Claude generation job for a weak category (bee.md requirement 5:
 * "generate test for the area that needs more study").
 *
 * The crawler container does the actual work, so this returns immediately.
 */
export default function DrillButton({ tag, enabled }: { tag: string; enabled: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "queued" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!enabled) {
    return (
      <span
        className="chip"
        title="Set ANTHROPIC_API_KEY to generate new questions on demand."
      >
        Generation needs an API key
      </span>
    );
  }

  async function queue() {
    setState("sending");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, count: 10, format: "tossup" }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not queue the job.");
      }
      setState("queued");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not queue the job.");
    }
  }

  if (state === "queued") {
    return (
      <span className="chip chip-on" title="Run `crawler generate --jobs` to process the queue.">
        Queued — 10 new questions
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void queue()}
        disabled={state === "sending"}
        className="btn-ghost text-xs"
      >
        {state === "sending" ? "Queueing…" : "Generate more"}
      </button>
      {message && <span className="text-xs text-bad-400">{message}</span>}
    </span>
  );
}
