"use client";

/**
 * Browser Web Speech API wrappers: text-to-speech for reading clues aloud and
 * speech-to-text for spoken answers.
 *
 * Both run entirely in the browser — no audio leaves the machine and there is
 * no per-utterance latency or cost. Firefox has no SpeechRecognition, so every
 * caller must also offer the typed fallback.
 */

// Minimal shapes for the SpeechRecognition API, which is still unprefixed only
// in some browsers and is absent from lib.dom.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isRecognitionSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * Why the browser's speech service is likely to fail, checked before we try.
 *
 * Chrome's SpeechRecognition is not local: it streams audio to Google and
 * fails with `network` if that request can't be made. The two causes we can
 * detect from here are an insecure origin and a Chromium build that isn't
 * Google Chrome (Brave, Vivaldi, plain Chromium and friends ship without the
 * Google Speech API key, so the endpoint rejects them every time).
 */
export function speechBlocker(): "insecure-origin" | "no-google-backend" | null {
  if (typeof window === "undefined") return null;

  // Served over plain HTTP from anything other than localhost: the mic and the
  // speech endpoint are both unavailable.
  if (!window.isSecureContext) return "insecure-origin";

  const ua = navigator.userAgent;
  const brand = (navigator as Navigator & {
    userAgentData?: { brands?: { brand: string }[] };
  }).userAgentData?.brands?.map((b) => b.brand).join(" ") ?? "";
  const hay = `${ua} ${brand}`;

  const chromium = /Chrome|Chromium|CriOS/.test(hay);
  const notGoogle = /\b(Brave|Vivaldi|OPR|Opera|Yandex|Whale|SamsungBrowser)\b/.test(hay);
  // Safari and Edge have their own working backends; only flag Chromium forks.
  if (chromium && notGoogle) return "no-google-backend";

  return null;
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export interface RecognizerHandlers {
  /** Fires repeatedly with the best-guess transcript so far. */
  onInterim?: (text: string) => void;
  /** Fires once, when listening genuinely ends, with the full transcript. */
  onFinal: (text: string) => void;
  /**
   * Fires when the student has said something and then gone quiet for
   * `silenceMs`. The caller decides whether that means "lock in the answer".
   */
  onSilence?: (text: string) => void;
  /** Only real problems reach here: a denied mic, no device, network failure. */
  onError?: (error: string) => void;
  onEnd?: () => void;
}

export interface RecognizerOptions {
  /** Quiet time after speech before `onSilence` fires. */
  silenceMs?: number;
}

export interface Recognizer {
  start(): void;
  /** Finish listening and deliver the transcript. */
  stop(): void;
  /** Drop everything; no callbacks fire. */
  abort(): void;
  text(): string;
}

/** Errors that mean "keep waiting", not "give up". */
const TRANSIENT = new Set(["no-speech", "aborted", "audio-capture-timeout"]);

/** Errors there is no point retrying — the student has to act. */
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

/**
 * A recognizer that listens until told to stop.
 *
 * The browser API fights this by default: `continuous = false` ends at the
 * first pause, and Chrome ends the session on its own after a few seconds of
 * quiet (raising `no-speech`). A student who buzzes, thinks for a beat, and
 * then answers would lose their answer. So this keeps `continuous` on,
 * restarts whenever the browser bails out, and preserves the transcript
 * across those restarts.
 */
export function createRecognizer(
  handlers: RecognizerHandlers,
  options: RecognizerOptions = {},
): Recognizer | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  const silenceMs = options.silenceMs ?? 2600;

  const recognition = new Ctor();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  // `settled` text survives browser-initiated restarts; `live` is the current
  // session's in-progress guess.
  let settledText = "";
  let live = "";
  let active = false;
  let finished = false;
  let restarts = 0;
  let recoveries = 0;
  let lastError: string | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  const current = () => `${settledText} ${live}`.replace(/\s+/g, " ").trim();

  function clearSilence() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function armSilence() {
    clearSilence();
    if (!handlers.onSilence) return;
    silenceTimer = setTimeout(() => {
      const text = current();
      if (active && text) handlers.onSilence?.(text);
    }, silenceMs);
  }

  function finish() {
    if (finished) return;
    finished = true;
    active = false;
    clearSilence();
    handlers.onFinal(current());
    handlers.onEnd?.();
  }

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) settledText = `${settledText} ${text}`.trim();
      else interim += text;
    }
    live = interim;
    handlers.onInterim?.(current());
    armSilence();
  };

  recognition.onerror = (event) => {
    const error = event.error ?? "speech-error";
    // A silent pause is not a failure — let onend restart us.
    if (TRANSIENT.has(error)) return;

    // Chrome streams audio to a remote service, so `network` and unlabelled
    // failures are often momentary. Give the engine one more go before telling
    // the student to type — losing the mic mid-buzz is expensive.
    if (!FATAL.has(error) && recoveries < 1) {
      recoveries++;
      lastError = error;
      return; // onend will restart us
    }

    active = false;
    handlers.onError?.(error);
  };

  recognition.onend = () => {
    // Roll the in-progress guess into the settled text; a restart resets the
    // browser's own result list.
    if (live) {
      settledText = `${settledText} ${live}`.trim();
      live = "";
    }

    // Chrome ends the session on silence even with continuous = true. Restart
    // so the student can still be thinking.
    if (active && restarts < 12) {
      restarts++;
      try {
        recognition.start();
        return;
      } catch {
        // The engine refused to restart. If we got here recovering from an
        // error, report that error rather than ending as if all was well.
        if (lastError) {
          active = false;
          handlers.onError?.(lastError);
          return;
        }
      }
    }
    finish();
  };

  return {
    start() {
      settledText = "";
      live = "";
      restarts = 0;
      recoveries = 0;
      lastError = null;
      finished = false;
      active = true;
      try {
        recognition.start();
      } catch {
        // start() throws if it is already running; harmless.
      }
      armSilence();
    },
    stop() {
      active = false; // stops onend from restarting
      clearSilence();
      try {
        recognition.stop();
      } catch {
        finish();
      }
    },
    abort() {
      active = false;
      finished = true;
      clearSilence();
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
    text: current,
  };
}

// ---------------------------------------------------------------------- TTS --

let currentUtterance: SpeechSynthesisUtterance | null = null;

/**
 * Reading speed, as a multiplier on the browser's default rate.
 *
 * A real moderator reads a tossup deliberately — clues carry proper nouns the
 * student has to catch, so the browser's default pace is too brisk. `normal`
 * here is deliberately below 1.0.
 */
export const READ_RATES = [
  { id: "slowest", label: "Slowest", rate: 0.6 },
  { id: "slow", label: "Slow", rate: 0.75 },
  { id: "normal", label: "Normal", rate: 0.9 },
  { id: "fast", label: "Fast", rate: 1.1 },
] as const;

export type ReadRateId = (typeof READ_RATES)[number]["id"];
export const DEFAULT_READ_RATE: ReadRateId = "normal";

export function rateValue(id: ReadRateId): number {
  return READ_RATES.find((r) => r.id === id)?.rate ?? 0.9;
}

/** Read `text` aloud. `onEnd` fires when finished, cancelled, or unsupported. */
export function speak(
  text: string,
  options: { rate?: number; onEnd?: () => void; onError?: () => void } = {},
): void {
  if (!isSpeechSynthesisSupported()) {
    options.onEnd?.();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = options.rate ?? rateValue(DEFAULT_READ_RATE);
  utterance.pitch = 1;
  utterance.onend = () => {
    if (currentUtterance === utterance) currentUtterance = null;
    options.onEnd?.();
  };
  utterance.onerror = () => {
    if (currentUtterance === utterance) currentUtterance = null;
    // A genuine synthesis failure should still move the question along, or a
    // browser that cannot voice one clue would stall the whole read. A
    // deliberate `cancelSpeech()` is different: it detaches these handlers
    // first, so it never arrives here.
    (options.onError ?? options.onEnd)?.();
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function cancelSpeech(): void {
  if (!isSpeechSynthesisSupported()) return;
  // Detach before cancelling. `speechSynthesis.cancel()` raises `onerror` (and
  // in some browsers `onend`) on the utterance it kills, and the caller's
  // `onEnd` means "this clue finished, reveal the next one". Letting a cancel
  // reach it made every teardown advance the question a clue.
  if (currentUtterance) {
    currentUtterance.onend = null;
    currentUtterance.onerror = null;
    currentUtterance = null;
  }
  window.speechSynthesis.cancel();
}
