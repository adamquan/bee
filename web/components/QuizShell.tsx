"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { endSession, filtersFromParams, startSession } from "@/lib/client-api";
import type { QuizFilters } from "@/lib/types";
import BuzzRunner from "./BuzzRunner";
import McqRunner from "./McqRunner";

/**
 * Opens a practice session from the URL's filters, then hands off to the
 * runner for the chosen format. Closing the tab ends the session so the
 * dashboard doesn't accumulate open ones.
 */
export default function QuizShell({ format }: { format: "buzz" | "mcq" }) {
  const params = useSearchParams();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [filters, setFilters] = useState<QuizFilters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const resolved = filtersFromParams(new URLSearchParams(params.toString()), format);
    setFilters(resolved);

    startSession(resolved)
      .then(({ sessionId: id }) => setSessionId(id))
      .catch(() => setError("Could not start a practice session."));
  }, [params, format]);

  useEffect(() => {
    if (sessionId === null) return;
    const close = () => void endSession(sessionId);
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [sessionId]);

  if (error) return <div className="card p-8 text-bad-400">{error}</div>;
  if (sessionId === null || !filters) {
    return <div className="card p-10 text-center text-ink-400">Starting session…</div>;
  }

  return format === "buzz" ? (
    <BuzzRunner sessionId={sessionId} filters={filters} />
  ) : (
    <McqRunner sessionId={sessionId} filters={filters} />
  );
}
