"use client";

import type { JudgeResult, QuizFilters, QuizQuestion, Reveal } from "./types";

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Request to ${url} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function startSession(filters: QuizFilters) {
  return post<{ sessionId: number }>("/api/session", filters);
}

export function endSession(sessionId: number) {
  return fetch("/api/session", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  });
}

export function fetchNextQuestion(filters: QuizFilters, exclude: number[]) {
  return post<{ question: QuizQuestion | null; remaining: number }>("/api/questions/next", {
    filters,
    exclude,
  });
}

export interface AttemptPayload {
  sessionId: number;
  questionId: number;
  response?: string;
  selectedLabel?: string;
  buzzClueOrdinal?: number | null;
  clueCount?: number | null;
  timedOut?: boolean;
  latencyMs?: number;
}

export function submitAttempt(payload: AttemptPayload) {
  return post<JudgeResult & { reveal: Reveal | null }>("/api/attempts", payload);
}

/** Read the setup screen's query string back into filters. */
/** Practice lengths offered on the setup screen. 0 is "no limit". */
export const QUESTION_COUNTS = [10, 20, 30, 50, 100, 0] as const;
export const DEFAULT_QUESTION_COUNT = 30;

/** Clamp an untrusted `count` param to something sane. */
export function parseCount(raw: string | null): number {
  // `Number("")` is 0, which would read as "no limit" — an empty `count=` in
  // the URL must mean "unspecified", not "practise until the bank runs out".
  if (raw === null || raw.trim() === "") return DEFAULT_QUESTION_COUNT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_QUESTION_COUNT;
  const whole = Math.floor(value);
  if (whole <= 0) return 0; // "all"
  return Math.min(whole, 500);
}

export function filtersFromParams(
  params: URLSearchParams,
  format: "buzz" | "mcq",
): QuizFilters {
  const tags = params.get("tags");
  return {
    limit: parseCount(params.get("count")),
    format,
    origin: (params.get("origin") as QuizFilters["origin"]) || "both",
    difficulty: (params.get("difficulty") as QuizFilters["difficulty"]) || "any",
    mode: (params.get("mode") as QuizFilters["mode"]) || "mixed",
    tags: tags ? tags.split(",").filter(Boolean) : [],
  };
}
