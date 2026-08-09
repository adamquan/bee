import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives `createRecognizer` against a fake SpeechRecognition so the restart
 * and silence behaviour can be checked without a browser. These are the exact
 * events Chrome emits when a student buzzes, pauses to think, then answers.
 */

class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  started = 0;
  running = false;
  static last: FakeRecognition | null = null;

  constructor() {
    FakeRecognition.last = this;
  }

  start() {
    if (this.running) throw new Error("already started");
    this.running = true;
    this.started++;
  }
  stop() {
    this.running = false;
    this.onend?.();
  }
  abort() {
    this.running = false;
  }

  // --- helpers the tests drive ---
  say(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal, 0: { transcript: text, confidence: 0.9 } } },
    });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  /** Chrome giving up on its own after quiet. */
  endOfSession() {
    this.running = false;
    this.onend?.();
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
}

let createRecognizer: typeof import("./speech").createRecognizer;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeRecognition.last = null;
  (globalThis as any).window = { SpeechRecognition: FakeRecognition };
  vi.resetModules();
  ({ createRecognizer } = await import("./speech"));
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe("createRecognizer", () => {
  it("requests continuous listening with interim results", () => {
    createRecognizer({ onFinal: () => {} })!.start();
    expect(FakeRecognition.last!.continuous).toBe(true);
    expect(FakeRecognition.last!.interimResults).toBe(true);
  });

  it("keeps listening when the browser ends the session on silence", () => {
    const onFinal = vi.fn();
    const recognizer = createRecognizer({ onFinal })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    expect(engine.started).toBe(1);

    engine.endOfSession(); // Chrome bails after a quiet moment
    expect(engine.started).toBe(2); // ...and we start it again
    expect(onFinal).not.toHaveBeenCalled(); // the answer is not submitted yet
  });

  it("does not surface a silent pause as an error", () => {
    const onError = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onError })!;
    recognizer.start();

    FakeRecognition.last!.fail("no-speech");
    expect(onError).not.toHaveBeenCalled();
  });

  it("preserves earlier words across a restart", () => {
    const onFinal = vi.fn();
    const recognizer = createRecognizer({ onFinal })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.say("the Mali", true);
    engine.endOfSession(); // restart happens here
    engine.say("Empire", true);
    recognizer.stop();

    expect(onFinal).toHaveBeenCalledWith("the Mali Empire");
  });

  it("carries an unfinished interim guess through a restart", () => {
    const onFinal = vi.fn();
    const recognizer = createRecognizer({ onFinal })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.say("Catherine the", false); // still interim when the session drops
    engine.endOfSession();
    engine.say("Great", true);
    recognizer.stop();

    expect(onFinal).toHaveBeenCalledWith("Catherine the Great");
  });

  it("reports a real failure like a denied microphone", () => {
    const onError = vi.fn();
    createRecognizer({ onFinal: () => {}, onError })!.start();

    FakeRecognition.last!.fail("not-allowed");
    expect(onError).toHaveBeenCalledWith("not-allowed");
  });

  it("fires onSilence only after the student has actually said something", () => {
    const onSilence = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onSilence }, { silenceMs: 2000 })!;
    recognizer.start();

    // Buzzed but silent: nothing should be submitted.
    vi.advanceTimersByTime(5000);
    expect(onSilence).not.toHaveBeenCalled();

    FakeRecognition.last!.say("Cuneiform", true);
    vi.advanceTimersByTime(2000);
    expect(onSilence).toHaveBeenCalledWith("Cuneiform");
  });

  it("restarts the silence window when the student keeps talking", () => {
    const onSilence = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onSilence }, { silenceMs: 2000 })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.say("Louis", true);
    vi.advanceTimersByTime(1500); // pause, but not long enough
    engine.say("the fourteenth", true);
    vi.advanceTimersByTime(1500);
    expect(onSilence).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);
    expect(onSilence).toHaveBeenCalledWith("Louis the fourteenth");
  });

  it("stop() ends listening instead of restarting", () => {
    const onFinal = vi.fn();
    const recognizer = createRecognizer({ onFinal })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.say("Israel", true);
    recognizer.stop();

    expect(onFinal).toHaveBeenCalledWith("Israel");
    expect(engine.started).toBe(1); // no restart after an explicit stop
  });

  it("abort() delivers nothing", () => {
    const onFinal = vi.fn();
    const onEnd = vi.fn();
    const recognizer = createRecognizer({ onFinal, onEnd })!;
    recognizer.start();
    FakeRecognition.last!.say("something", true);
    recognizer.abort();

    expect(onFinal).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("gives up rather than restarting forever", () => {
    const onFinal = vi.fn();
    const recognizer = createRecognizer({ onFinal })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    for (let i = 0; i < 30; i++) engine.endOfSession();

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(engine.started).toBeLessThanOrEqual(13);
  });

  it("returns null where the browser has no speech recognition", async () => {
    (globalThis as any).window = {};
    vi.resetModules();
    const mod = await import("./speech");
    expect(mod.createRecognizer({ onFinal: () => {} })).toBeNull();
    expect(mod.isRecognitionSupported()).toBe(false);
  });

  it("retries once before reporting a recoverable failure", () => {
    const onError = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onError })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.fail("network");
    expect(onError).not.toHaveBeenCalled(); // first network blip: try again

    engine.endOfSession();
    expect(engine.started).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a recoverable failure the second time it happens", () => {
    const onError = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onError })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.fail("network");
    engine.endOfSession(); // restarted
    engine.fail("network"); // still broken
    expect(onError).toHaveBeenCalledWith("network");
  });

  it("reports a denied microphone immediately, without retrying", () => {
    const onError = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onError })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.fail("not-allowed");
    expect(onError).toHaveBeenCalledWith("not-allowed");
    expect(engine.started).toBe(1);
  });

  it("passes an unlabelled error through as speech-error", () => {
    const onError = vi.fn();
    const recognizer = createRecognizer({ onFinal: () => {}, onError })!;
    recognizer.start();

    const engine = FakeRecognition.last!;
    engine.onerror?.({} as any); // Safari sometimes omits event.error
    engine.endOfSession();
    engine.onerror?.({} as any);
    expect(onError).toHaveBeenCalledWith("speech-error");
  });
});

describe("speechBlocker", () => {
  async function check(win: Record<string, unknown>) {
    (globalThis as any).window = { SpeechRecognition: FakeRecognition, ...win };
    // globalThis.navigator is getter-only in Node; redefine it.
    Object.defineProperty(globalThis, "navigator", {
      value: win.navigator ?? { userAgent: "" },
      configurable: true,
    });
    vi.resetModules();
    const mod = await import("./speech");
    return mod.speechBlocker();
  }

  it("flags a plain-http origin that is not localhost", async () => {
    expect(
      await check({ isSecureContext: false, navigator: { userAgent: "Chrome/140" } }),
    ).toBe("insecure-origin");
  });

  it("flags a Chromium fork with no Google speech key", async () => {
    for (const ua of ["Chrome/140 Brave/140", "Chrome/140 Vivaldi/6", "Chrome/140 OPR/110"]) {
      expect(await check({ isSecureContext: true, navigator: { userAgent: ua } })).toBe(
        "no-google-backend",
      );
    }
  });

  it("clears real Chrome, Edge, and Safari", async () => {
    for (const ua of [
      "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      "Mozilla/5.0 Version/17.0 Safari/605.1.15",
    ]) {
      expect(await check({ isSecureContext: true, navigator: { userAgent: ua } })).toBeNull();
    }
  });
});


/**
 * Reading a clue aloud drives the reveal: the caller's `onEnd` means "this
 * clue finished, show the next one". A deliberate cancel must therefore never
 * reach it — that made every teardown advance the question by a clue.
 */
class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  rate = 1;
  pitch = 1;
  static last: FakeUtterance | null = null;
  constructor(public text: string) {
    FakeUtterance.last = this;
  }
}

describe("speak / cancelSpeech", () => {
  let spoken: FakeUtterance[];

  beforeEach(() => {
    spoken = [];
    FakeUtterance.last = null;
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (u: FakeUtterance) => spoken.push(u),
      cancel: () => {
        // What a real browser does: the killed utterance reports an error.
        for (const u of spoken) u.onerror?.();
      },
      getVoices: () => [],
    });
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports completion when the utterance genuinely ends", async () => {
    const { speak } = await import("./speech");
    const onEnd = vi.fn();
    speak("a clue", { onEnd });

    FakeUtterance.last!.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("still advances when synthesis genuinely fails", async () => {
    const { speak } = await import("./speech");
    const onEnd = vi.fn();
    speak("a clue", { onEnd });

    // Not a cancel — the voice itself failed. Stalling the whole read would be
    // worse than moving on.
    FakeUtterance.last!.onerror?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does NOT report completion when speech is cancelled", async () => {
    const { speak, cancelSpeech } = await import("./speech");
    const onEnd = vi.fn();
    speak("a clue", { onEnd });

    cancelSpeech();

    // The regression: cancel raised onerror, which was treated as "clue
    // finished", so the reveal advanced on every teardown and the resulting
    // re-render storm swallowed clicks on the buzz button.
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("a cancelled utterance stays silent even if the browser fires onend too", async () => {
    const { speak, cancelSpeech } = await import("./speech");
    const onEnd = vi.fn();
    speak("a clue", { onEnd });
    const utterance = FakeUtterance.last!;

    cancelSpeech();
    utterance.onend?.();
    utterance.onerror?.();

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("cancelling twice is harmless", async () => {
    const { speak, cancelSpeech } = await import("./speech");
    const onEnd = vi.fn();
    speak("a clue", { onEnd });

    expect(() => {
      cancelSpeech();
      cancelSpeech();
    }).not.toThrow();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("a fresh utterance after a cancel still reports completion", async () => {
    const { speak, cancelSpeech } = await import("./speech");
    speak("first", { onEnd: () => {} });
    cancelSpeech();

    const onEnd = vi.fn();
    speak("second", { onEnd });
    FakeUtterance.last!.onend?.();

    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
