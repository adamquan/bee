import { describe, expect, it } from "vitest";
import { judgeOffline, normalize, similarity, tokenize } from "./judge";

/** Convenience: the offline tiers only, which is what runs without a key. */
function verdictOf(said: string, answer: string, alternates: string[] = []) {
  const out = judgeOffline(said, answer, alternates);
  return out.decided ? out.verdict : "escalate";
}

describe("normalize", () => {
  it("folds case, punctuation, accents, and a leading article", () => {
    expect(normalize("  The Mali Empire! ")).toBe("mali empire");
    expect(normalize("Café de Flore")).toBe("cafe de flore");
    expect(normalize("U.S.S.R.")).toBe("u s s r");
  });

  it("keeps a lone article as-is rather than emptying the answer", () => {
    expect(normalize("The")).toBe("the");
  });
});

describe("tokenize", () => {
  it("folds roman numerals, ordinals, and number words to the same token", () => {
    expect(tokenize("Louis XIV")).toEqual(["louis", "14"]);
    expect(tokenize("Louis the 14th")).toEqual(["louis", "14"]);
    expect(tokenize("Louis the Fourteenth")).toEqual(["louis", "14"]);
    expect(tokenize("Louis XVI")).toEqual(["louis", "16"]);
  });

  it("treats a trailing single letter as a regnal numeral", () => {
    expect(tokenize("Henry V")).toEqual(["henry", "5"]);
    expect(tokenize("Pope Pius X")).toEqual(["pope", "pius", "10"]);
  });

  it("does not turn ordinary words into numerals", () => {
    expect(tokenize("Mali")).toEqual(["mali"]);
    // "civil" starts with c/i/v/i/l but is not a roman numeral token.
    expect(tokenize("Civil War")).toEqual(["civil", "war"]);
  });
});

describe("judgeOffline — accepting", () => {
  it("accepts an exact answer", () => {
    expect(verdictOf("Mali Empire", "Mali Empire")).toBe("correct");
  });

  it("accepts the distinguishing word without the generic noun", () => {
    expect(verdictOf("Mali", "Mali Empire")).toBe("correct");
    expect(verdictOf("the mali", "Mali Empire")).toBe("correct");
  });

  it("accepts an answer that says more than required", () => {
    expect(verdictOf("the Mali Empire of West Africa", "Mali Empire")).toBe("correct");
  });

  it("accepts equivalent numeral spellings", () => {
    expect(verdictOf("Louis the 14th", "Louis XIV")).toBe("correct");
    expect(verdictOf("Louis fourteenth", "Louis XIV")).toBe("correct");
  });

  it("accepts a listed alternate", () => {
    expect(verdictOf("Manden Kurufaba", "Mali Empire", ["Manden Kurufaba"])).toBe("correct");
  });

  it("tolerates a speech-to-text spelling slip", () => {
    expect(verdictOf("cuneform", "Cuneiform")).toBe("correct");
    expect(verdictOf("Thanksgivng", "Thanksgiving")).toBe("correct");
  });
});

describe("judgeOffline — rejecting", () => {
  it("rejects a different regnal number", () => {
    expect(verdictOf("Louis XVI", "Louis XIV")).toBe("incorrect");
    expect(verdictOf("Louis the 16th", "Louis XIV")).toBe("incorrect");
  });

  it("rejects a different entity that shares the generic noun", () => {
    expect(verdictOf("Songhai Empire", "Mali Empire")).toBe("incorrect");
  });

  it("rejects the generic noun on its own", () => {
    expect(verdictOf("Empire", "Mali Empire")).toBe("incorrect");
  });

  it("rejects an unrelated answer", () => {
    expect(verdictOf("Charlemagne", "Louis XIV")).toBe("incorrect");
    expect(verdictOf("Hieroglyphics", "Cuneiform")).toBe("incorrect");
  });

  it("rejects an empty response", () => {
    expect(verdictOf("", "Cuneiform")).toBe("incorrect");
    expect(verdictOf("   ", "Cuneiform")).toBe("incorrect");
  });
});

describe("judgeOffline — escalation", () => {
  it("escalates a partial name that a moderator would have to rule on", () => {
    // Shares "roosevelt" but not the distinguishing given name.
    expect(verdictOf("Roosevelt", "Franklin Delano Roosevelt")).toBe("escalate");
  });

  it("decides confidently rather than escalating on clear cases", () => {
    expect(verdictOf("Franklin Roosevelt", "Franklin Delano Roosevelt")).toBe("correct");
    expect(verdictOf("Napoleon", "Napoleon Bonaparte")).toBe("correct");
  });
});

describe("similarity", () => {
  it("scores identical strings at 1 and disjoint strings low", () => {
    expect(similarity("mali", "mali")).toBe(1);
    expect(similarity("mali", "songhai")).toBeLessThan(0.4);
  });
});
