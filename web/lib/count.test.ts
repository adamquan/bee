import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUESTION_COUNT,
  filtersFromParams,
  parseCount,
} from "./client-api";

describe("parseCount", () => {
  it("defaults to 30 when the parameter is absent", () => {
    expect(parseCount(null)).toBe(DEFAULT_QUESTION_COUNT);
    expect(DEFAULT_QUESTION_COUNT).toBe(30);
  });

  it("takes a number the setup screen offered", () => {
    for (const n of [10, 20, 30, 50, 100]) {
      expect(parseCount(String(n))).toBe(n);
    }
  });

  it("treats zero and negatives as 'no limit'", () => {
    expect(parseCount("0")).toBe(0);
    expect(parseCount("-5")).toBe(0);
  });

  it("falls back to the default for junk rather than running unbounded", () => {
    // A malformed value must not silently become "practise forever".
    for (const raw of ["", "abc", "NaN", "Infinity"]) {
      expect(parseCount(raw)).toBe(DEFAULT_QUESTION_COUNT);
    }
  });

  it("caps absurd values", () => {
    expect(parseCount("100000")).toBe(500);
  });

  it("floors a fractional count", () => {
    expect(parseCount("12.9")).toBe(12);
  });
});

describe("filtersFromParams", () => {
  const parse = (qs: string) => filtersFromParams(new URLSearchParams(qs), "buzz");

  it("carries the count through as the limit", () => {
    expect(parse("count=10").limit).toBe(10);
    expect(parse("count=0").limit).toBe(0);
  });

  it("applies the 30-question default when the URL says nothing", () => {
    expect(parse("origin=both").limit).toBe(30);
  });

  it("leaves the other filters alone", () => {
    const f = parse("count=20&origin=official&difficulty=middle&mode=review&tags=Empires,Leaders");
    expect(f).toMatchObject({
      format: "buzz",
      limit: 20,
      origin: "official",
      difficulty: "middle",
      mode: "review",
      tags: ["Empires", "Leaders"],
    });
  });
});
