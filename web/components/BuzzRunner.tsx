"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelSpeech,
  createRecognizer,
  DEFAULT_READ_RATE,
  isRecognitionSupported,
  isSpeechSynthesisSupported,
  rateValue,
  READ_RATES,
  speechBlocker,
  speak,
  type ReadRateId,
  type Recognizer,
} from "@/lib/speech";
import {
  fetchNextQuestion,
  submitAttempt,
  type AttemptPayload,
} from "@/lib/client-api";
import type { JudgeResult, QuizFilters, QuizQuestion, Reveal } from "@/lib/types";
import ScoreBar from "./ScoreBar";

/**
 * Buzzer tossup runner (bee.md requirement 1).
 *
 *   reading  — clues reveal one at a time, read aloud
 *   buzzed   — reveal pauses, the mic opens, the student answers
 *   grace    — the whole question has been read; a 30-second window is open
 *   revealed — answer + explanation, with any unread clues shown
 */

type Phase = "loading" | "reading" | "buzzed" | "grace" | "revealed" | "done";

const GRACE_SECONDS = 30;
/**
 * Fallback pacing when reading aloud is off or unsupported: ~150 words per
 * minute at normal speed, scaled by the same rate control so the reveal keeps
 * pace with whatever the student picked.
 */
const MS_PER_WORD_AT_NORMAL = 400;
const RATE_STORAGE_KEY = "bee.readRate";

interface Props {
  sessionId: number;
  filters: QuizFilters;
}

export default function BuzzRunner({ sessionId, filters }: Props) {
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [visibleClues, setVisibleClues] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [lockingIn, setLockingIn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(GRACE_SECONDS);
  const [result, setResult] = useState<(JudgeResult & { reveal: Reveal | null }) | null>(null);
  const [seen, setSeen] = useState<number[]>([]);
  const [score, setScore] = useState({ asked: 0, correct: 0 });
  const [readAloud, setReadAloud] = useState(true);
  const [readRate, setReadRate] = useState<ReadRateId>(DEFAULT_READ_RATE);
  const [grading, setGrading] = useState(false);

  const recognizerRef = useRef<Recognizer | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buzzOrdinal = useRef<number | null>(null);
  const questionStart = useRef<number>(0);
  const answeredRef = useRef(false);
  // Kept in a ref so the recognizer's callbacks never read a stale transcript.
  const transcriptRef = useRef("");

  const limit = filters.limit ?? 0;
  const canListen = isRecognitionSupported();
  const canSpeak = isSpeechSynthesisSupported();
  const [voiceBlocker, setVoiceBlocker] = useState<string | null>(null);
  // Memoised: the clue-reveal effect depends on this, and a fresh array on
  // every render re-ran the effect continuously — each run cancelling speech
  // and restarting the reveal timer, which made the buzz button miss clicks.
  const clues = useMemo(() => question?.clues ?? [], [question]);

  // ------------------------------------------------------------- cleanup --
  const clearTimers = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (graceTimer.current) clearInterval(graceTimer.current);
    if (lockTimer.current) clearTimeout(lockTimer.current);
    revealTimer.current = null;
    graceTimer.current = null;
    lockTimer.current = null;
  }, []);

  const stopEverything = useCallback(() => {
    clearTimers();
    cancelSpeech();
    recognizerRef.current?.abort();
    recognizerRef.current = null;
    setListening(false);
    setLockingIn(false);
  }, [clearTimers]);

  useEffect(() => stopEverything, [stopEverything]);

  // Tell the student up front if dictation cannot work here, rather than
  // letting them buzz and lose the clue to an error.
  useEffect(() => setVoiceBlocker(speechBlocker()), []);

  // Remember the reading speed between sessions. Read after mount so the
  // server-rendered markup and the first client render agree.
  useEffect(() => {
    const saved = window.localStorage.getItem(RATE_STORAGE_KEY) as ReadRateId | null;
    if (saved && READ_RATES.some((r) => r.id === saved)) setReadRate(saved);
  }, []);

  function chooseRate(id: ReadRateId) {
    setReadRate(id);
    window.localStorage.setItem(RATE_STORAGE_KEY, id);
    // Apply immediately: re-read the clue on screen at the new speed.
    if (phase === "reading" && readAloud && canSpeak) {
      const clue = clues[visibleClues - 1];
      cancelSpeech();
      if (clue) {
        speak(clue.text, {
          rate: rateValue(id),
          onEnd: () => {
            if (answeredRef.current) return;
            setVisibleClues((n) => (n < clues.length ? n + 1 : n));
            if (visibleClues >= clues.length) setPhase("grace");
          },
        });
      }
    }
  }

  // -------------------------------------------------------- load question --
  const loadNext = useCallback(async () => {
    stopEverything();

    // Stop at the requested length before asking the server for another
    // question, so the last answer's reveal is the end of the practice rather
    // than a question flashing up and vanishing.
    if (limit > 0 && seen.length >= limit) {
      setPhase("done");
      return;
    }

    setPhase("loading");
    setQuestion(null);
    setResult(null);
    setTranscript("");
    transcriptRef.current = "";
    setMicError(null);
    setVisibleClues(0);
    setSecondsLeft(GRACE_SECONDS);
    buzzOrdinal.current = null;
    answeredRef.current = false;

    const { question: next } = await fetchNextQuestion(filters, seen);
    if (!next) {
      setPhase("done");
      return;
    }
    setQuestion(next);
    setSeen((prev) => [...prev, next.id]);
    questionStart.current = Date.now();
    setVisibleClues(1);
    setPhase("reading");
  }, [filters, seen, stopEverything, limit]);

  useEffect(() => {
    void loadNext();
    // Intentionally runs once: `loadNext` closes over `seen`, which it updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------ clue revealing --
  // Advance when the current clue finishes being read (or after a paced delay
  // when speech synthesis is off or unavailable).
  useEffect(() => {
    if (phase !== "reading" || !question || visibleClues === 0) return;

    const clue = clues[visibleClues - 1];
    if (!clue) return;

    // `setPhase` must not live inside a `setVisibleClues` updater: updaters
    // have to be pure, and React may run them more than once.
    const advance = () => {
      if (answeredRef.current) return;
      if (visibleClues < clues.length) setVisibleClues(visibleClues + 1);
      else setPhase("grace");
    };

    if (readAloud && canSpeak) {
      speak(clue.text, { rate: rateValue(readRate), onEnd: advance });
      return () => cancelSpeech();
    }

    const words = clue.text.split(/\s+/).length;
    const perWord = MS_PER_WORD_AT_NORMAL / (rateValue(readRate) / rateValue("normal"));
    revealTimer.current = setTimeout(advance, Math.max(2500, words * perWord));
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
    // `readRate` changes are applied by chooseRate, not by restarting the clue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, visibleClues, question, clues, readAloud, canSpeak]);

  // ------------------------------------------------ 30-second grace window --
  // bee.md: reveal the answer if the student hasn't got it 30 seconds after
  // the question has been read out completely.
  useEffect(() => {
    if (phase !== "grace") return;
    setSecondsLeft(GRACE_SECONDS);

    graceTimer.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          if (graceTimer.current) clearInterval(graceTimer.current);
          void finish({ timedOut: true });
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => {
      if (graceTimer.current) clearInterval(graceTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // -------------------------------------------------------------- buzzing --
  const buzz = useCallback(() => {
    if (phase !== "reading" && phase !== "grace") return;
    clearTimers();
    cancelSpeech();
    buzzOrdinal.current = Math.max(0, visibleClues - 1);
    setPhase("buzzed");

    if (!canListen) return;
    startListening();
  }, [phase, visibleClues, canListen, clearTimers]);

  const startListening = useCallback(() => {
    if (!canListen) return;
    recognizerRef.current?.abort();
    setMicError(null);
    const recognizer = createRecognizer(
      {
        onInterim: (text) => {
          setTranscript(text);
          transcriptRef.current = text;
          // Still talking — call off any pending auto-submit.
          if (lockTimer.current) {
            clearTimeout(lockTimer.current);
            lockTimer.current = null;
            setLockingIn(false);
          }
        },
        onSilence: (text) => {
          // Answer given, then a real pause. Lock it in, but leave a moment
          // to carry on speaking — a student correcting themselves mid-answer
          // shouldn't be graded on the first half.
          transcriptRef.current = text;
          setLockingIn(true);
          lockTimer.current = setTimeout(() => {
            recognizerRef.current?.stop();
            void finish({ response: transcriptRef.current });
          }, 1200);
        },
        onFinal: (text) => {
          setListening(false);
          if (text) {
            setTranscript(text);
            transcriptRef.current = text;
          }
        },
        onError: (error) => {
          setListening(false);
          // Keep the raw code visible: "speech recognition stopped" alone gives
          // neither the student nor anyone debugging a way to act on it.
          console.warn("[bee] speech recognition error:", error);
          setMicError(
            error === "not-allowed" || error === "service-not-allowed"
              ? "Microphone blocked. Allow mic access for this site, then press Retry."
              : error === "audio-capture"
                ? "No microphone found. Plug one in and press Retry."
                : error === "network"
                  ? networkErrorHelp()
                  : error === "language-not-supported"
                    ? "This browser has no en-US speech model. Type your answer."
                    : `Speech recognition stopped (${error}). Press Retry, or type your answer.`,
          );
        },
        onEnd: () => setListening(false),
      },
      { silenceMs: 2600 },
    );
    recognizerRef.current = recognizer;
    if (recognizer) {
      recognizer.start();
      setListening(true);
    }
    // `finish` is defined below and is stable for the life of a question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canListen]);

  // --------------------------------------------------------- grade & show --
  const finish = useCallback(
    async (options: { timedOut?: boolean; response?: string } = {}) => {
      if (answeredRef.current || !question) return;
      answeredRef.current = true;
      stopEverything();
      setGrading(true);

      const spoken = options.response ?? transcriptRef.current ?? transcript;
      const payload: AttemptPayload = {
        sessionId,
        questionId: question.id,
        buzzClueOrdinal: options.timedOut ? null : buzzOrdinal.current,
        clueCount: clues.length,
        timedOut: options.timedOut,
        response: options.timedOut ? undefined : spoken,
        latencyMs: Date.now() - questionStart.current,
      };
      if (!options.timedOut) setTranscript(spoken);

      try {
        const outcome = await submitAttempt(payload);
        setResult(outcome);
        setScore((s) => ({
          asked: s.asked + 1,
          correct: s.correct + (outcome.verdict === "correct" ? 1 : 0),
        }));
      } catch {
        setResult({
          verdict: "incorrect",
          judgedBy: "fuzzy",
          reason: "Could not reach the server to grade this answer.",
          reveal: null,
        });
      }

      // "Still finish the question": show every clue the student never heard.
      setVisibleClues(clues.length);
      setGrading(false);
      setPhase("revealed");
    },
    [question, sessionId, transcript, clues.length, stopEverything],
  );

  // ------------------------------------------------------------- keyboard --
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA"].includes(event.target.tagName);

      if (event.code === "Space" && !typing && (phase === "reading" || phase === "grace")) {
        event.preventDefault();
        buzz();
      }
      if (event.key === "Enter" && phase === "revealed") {
        event.preventDefault();
        void loadNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, buzz, loadNext]);

  // ----------------------------------------------------------------- view --
  if (phase === "done") {
    return (
      <EmptyState
        score={score}
        message={
          limit > 0 && seen.length >= limit
            ? `That's all ${limit} question${limit === 1 ? "" : "s"} for this practice.`
            : "You've worked through every question that matches these filters."
        }
      />
    );
  }

  if (phase === "loading" || !question) {
    return <div className="card p-10 text-center text-ink-400">Loading question…</div>;
  }

  const verdict = result?.verdict;

  return (
    <div className="space-y-4">
      <ScoreBar
        asked={score.asked}
        correct={score.correct}
        position={seen.length}
        total={limit}
        right={
          <div className="flex flex-wrap items-center gap-3">
            {canSpeak && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
                <input
                  type="checkbox"
                  checked={readAloud}
                  onChange={(e) => {
                    setReadAloud(e.target.checked);
                    if (!e.target.checked) cancelSpeech();
                  }}
                  className="accent-honey-400"
                />
                Read aloud
              </label>
            )}

            <label className="flex items-center gap-2 text-xs text-ink-400">
              <span className="sr-only sm:not-sr-only">Speed</span>
              <select
                value={readRate}
                onChange={(event) => chooseRate(event.target.value as ReadRateId)}
                aria-label="Reading speed"
                className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-200 focus:border-honey-500 focus:outline-none"
              >
                {READ_RATES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {voiceBlocker && (
              <span
                className="chip border-warn-400/50 text-warn-400"
                title={
                  voiceBlocker === "insecure-origin"
                    ? "Open the app at http://localhost:3000 for microphone access."
                    : "Only Chrome and Edge can reach Google's speech service. Typing works everywhere."
                }
              >
                Voice unavailable — typing works
              </span>
            )}

            {phase === "grace" && (
              <span
                className={`chip tabular-nums ${
                  secondsLeft <= 10 ? "border-bad-400/60 text-bad-400" : "text-honey-300"
                }`}
                role="timer"
                aria-live="off"
              >
                {secondsLeft}s to answer
              </span>
            )}
          </div>
        }
      />

      <article className="card p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="chip">{question.difficulty}</span>
            <span className="chip">{question.origin}</span>
            {question.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="chip">
                {tag}
              </span>
            ))}
          </div>

          {/* Anchored to the top of the card rather than placed under the
              clues. The card grows every time a clue is revealed, so a button
              below it slid down the page every few seconds — moving out from
              under the cursor at exactly the moment the student reaches for
              it. The slot keeps its height across phases so the clues below
              never shift either. */}
          <div className="ml-auto flex min-h-11 shrink-0 items-start gap-2">
            {/* Left of Buzz on purpose: appearing at the start of the grace
                window must not shove the Buzz button out from under the
                cursor. */}
            {phase === "grace" && (
              <button
                type="button"
                onClick={() => void finish({ timedOut: true })}
                className="btn-ghost py-2.5"
                title="Show the answer and move on. Counts as unanswered, so the question comes back for review."
              >
                Reveal answer
              </button>
            )}
            {(phase === "reading" || phase === "grace") && (
              <button
                type="button"
                onClick={buzz}
                className="btn-primary px-7 py-2.5 text-base shadow-lg shadow-honey-400/10"
              >
                Buzz
                <kbd className="rounded bg-ink-950/20 px-1.5 py-0.5 text-xs">space</kbd>
              </button>
            )}
          </div>
        </div>

        <ol className="space-y-3">
          {clues.slice(0, visibleClues).map((clue, index) => {
            const unheard = phase === "revealed" && buzzOrdinal.current !== null && index > buzzOrdinal.current;
            return (
              <li
                key={clue.ordinal}
                className={`clue-in text-lg leading-relaxed ${
                  unheard ? "text-ink-400" : "text-ink-100"
                }`}
              >
                <span className="mr-2 select-none text-xs uppercase tracking-wider text-ink-600">
                  {clue.tier}
                </span>
                {clue.text}
              </li>
            );
          })}
        </ol>

        {phase === "reading" && (
          <p className="mt-4 text-xs text-ink-400">
            Clue {visibleClues} of {clues.length} — buzz as soon as you know it.
          </p>
        )}

        {phase === "grace" && (
          <p className="mt-4 text-xs text-ink-400">
            That&apos;s the whole question. Buzz if you have it, or reveal the answer to move on.
          </p>
        )}
      </article>

      {phase === "buzzed" && (
        <AnswerPanel
          listening={listening}
          lockingIn={lockingIn}
          transcript={transcript}
          micError={micError}
          canListen={canListen}
          grading={grading}
          onTranscriptChange={(text) => {
            setTranscript(text);
            transcriptRef.current = text;
            // Typing means they're taking over from the mic.
            if (lockTimer.current) {
              clearTimeout(lockTimer.current);
              lockTimer.current = null;
              setLockingIn(false);
            }
          }}
          onRetryMic={startListening}
          onKeepTalking={() => {
            if (lockTimer.current) {
              clearTimeout(lockTimer.current);
              lockTimer.current = null;
            }
            setLockingIn(false);
          }}
          onSubmit={(text) => {
            recognizerRef.current?.stop();
            void finish({ response: text });
          }}
        />
      )}

      {phase === "revealed" && result && (
        <RevealPanel
          verdict={verdict!}
          reason={result.reason}
          reveal={result.reveal}
          said={transcript}
          onNext={() => void loadNext()}
        />
      )}
    </div>
  );
}

/**
 * A `network` error from SpeechRecognition rarely means the internet is down.
 * Chrome relays audio to Google's speech service; the request is refused when
 * the origin is insecure, when the browser is a Chromium fork without Google's
 * API key, or when something on the network blocks the endpoint.
 */
function networkErrorHelp(): string {
  switch (speechBlocker()) {
    case "insecure-origin":
      return (
        "Speech needs a secure page. You're on a plain http:// address that isn't " +
        "localhost, so Chrome blocks the microphone. Open the app at " +
        "http://localhost:3000 instead — or type your answer."
      );
    case "no-google-backend":
      return (
        "This browser is Chromium-based but isn't Google Chrome, and only Chrome " +
        "and Edge ship the key for Google's speech service — so dictation fails " +
        "every time here. Use Chrome or Edge for voice, or type your answer."
      );
    default:
      return (
        "Google's speech service could not be reached. A VPN, ad blocker, or " +
        "network filter is the usual cause — Chrome sends audio there to " +
        "transcribe it. Press Retry, or type your answer."
      );
  }
}


// ------------------------------------------------------------- sub-views --

function AnswerPanel({
  listening,
  lockingIn,
  transcript,
  micError,
  canListen,
  grading,
  onTranscriptChange,
  onRetryMic,
  onKeepTalking,
  onSubmit,
}: {
  listening: boolean;
  lockingIn: boolean;
  transcript: string;
  micError: string | null;
  canListen: boolean;
  grading: boolean;
  onTranscriptChange: (value: string) => void;
  onRetryMic: () => void;
  onKeepTalking: () => void;
  onSubmit: (text: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the box straight away so a student who prefers typing (or whose
    // mic is blocked) loses no time.
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="card space-y-3 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(transcript.trim());
      }}
    >
      <div className="flex min-h-6 items-center justify-between gap-3">
        {lockingIn ? (
          <span className="text-sm text-honey-300">Locking in your answer…</span>
        ) : listening ? (
          <span className="flex items-center gap-2 text-sm text-honey-300">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-honey-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-honey-400" />
            </span>
            Listening — take your time
          </span>
        ) : (
          <span className="text-sm text-ink-400">
            {canListen ? "Say or type your answer" : "Type your answer"}
          </span>
        )}

        {lockingIn && (
          <button type="button" className="btn-quiet text-xs" onClick={onKeepTalking}>
            Wait, I&rsquo;m still talking
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        value={transcript}
        onChange={(event) => onTranscriptChange(event.target.value)}
        placeholder="Your answer"
        aria-label="Your answer"
        className="field text-lg"
        autoComplete="off"
      />

      {micError && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-warn-400">{micError}</p>
          <button type="button" className="btn-ghost text-xs" onClick={onRetryMic}>
            Retry microphone
          </button>
        </div>
      )}
      {!canListen && !micError && (
        <p className="text-xs text-ink-400">
          This browser has no speech recognition. Chrome, Edge, and Safari support it.
        </p>
      )}
      {canListen && !micError && (
        <p className="text-xs text-ink-400">
          Pausing for a couple of seconds submits automatically — or press Submit whenever
          you&rsquo;re ready.
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={grading}>
        {grading ? "Grading…" : "Submit answer"}
      </button>
    </form>
  );
}

function RevealPanel({
  verdict,
  reason,
  reveal,
  said,
  onNext,
}: {
  verdict: string;
  reason?: string;
  reveal: Reveal | null;
  said: string;
  onNext: () => void;
}) {
  const tone =
    verdict === "correct"
      ? { label: "Correct", cls: "text-good-400", border: "border-good-600/50" }
      : verdict === "timeout"
        ? { label: "Time — 30 seconds elapsed", cls: "text-warn-400", border: "border-warn-400/40" }
        : { label: "Not quite", cls: "text-bad-400", border: "border-bad-600/50" };

  return (
    <section className={`card border ${tone.border} p-6`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className={`font-display text-xl ${tone.cls}`}>{tone.label}</h2>
        {reason && <span className="text-xs text-ink-400">{reason}</span>}
      </div>

      {said && verdict !== "timeout" && (
        <p className="mt-2 text-sm text-ink-400">
          You said: <span className="text-ink-300">&ldquo;{said}&rdquo;</span>
        </p>
      )}

      <p className="mt-4 font-display text-2xl text-honey-300">{reveal?.answer ?? "—"}</p>
      {reveal?.alternates.length ? (
        <p className="mt-1 text-sm text-ink-400">Also accepted: {reveal.alternates.join(", ")}</p>
      ) : null}

      {reveal?.explanation ? (
        <p className="mt-4 leading-relaxed text-ink-300">{reveal.explanation}</p>
      ) : (
        <p className="mt-4 text-sm text-ink-400">
          No explanation stored for this question yet — run{" "}
          <code className="rounded bg-ink-850 px-1.5 py-0.5 text-honey-300">crawler enrich</code>{" "}
          to add one.
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={onNext}>
          Next question
          <kbd className="rounded bg-ink-950/20 px-1.5 py-0.5 text-xs">enter</kbd>
        </button>
        <Link href="/dashboard" className="btn-ghost">
          End session
        </Link>
      </div>
    </section>
  );
}

function EmptyState({
  score,
  message,
}: {
  score: { asked: number; correct: number };
  message: string;
}) {
  return (
    <div className="card p-10 text-center">
      <h2 className="font-display text-2xl">Session complete</h2>
      <p className="mt-2 text-ink-300">{message}</p>
      {score.asked > 0 && (
        <p className="mt-4 font-display text-3xl text-honey-300">
          {score.correct} / {score.asked}
        </p>
      )}
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/dashboard" className="btn-primary">
          See dashboard
        </Link>
        <Link href="/" className="btn-ghost">
          New session
        </Link>
      </div>
    </div>
  );
}
