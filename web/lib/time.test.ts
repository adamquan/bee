import { describe, expect, it } from "vitest";
import { utcToDate } from "./time";

describe("utcToDate", () => {
  it("reads a SQLite timestamp as UTC, not local", () => {
    // The whole bug: without a zone marker this is read as local time, which
    // shifts every displayed timestamp by the viewer's offset.
    expect(utcToDate("2026-08-01 13:04:40")!.toISOString()).toBe("2026-08-01T13:04:40.000Z");
  });

  it("produces a spec-legal ISO string, not `date SPACE time Z`", () => {
    // `new Date("2026-08-01 13:04:40Z")` is not ISO 8601. V8 accepts it and
    // Safari has returned Invalid Date, so the separator must become `T`.
    const iso = "2026-08-01 13:04:40".replace(" ", "T") + "Z";
    expect(iso).toBe("2026-08-01T13:04:40Z");
    expect(utcToDate("2026-08-01 13:04:40")!.getTime()).toBe(Date.parse(iso));
  });

  it("midnight and end-of-day survive the conversion", () => {
    expect(utcToDate("2026-08-01 00:00:00")!.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(utcToDate("2026-12-31 23:59:59")!.toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });

  it("does not double-stamp a value that already names its zone", () => {
    expect(utcToDate("2026-08-01T13:04:40Z")!.toISOString()).toBe("2026-08-01T13:04:40.000Z");
    expect(utcToDate("2026-08-01T13:04:40+00:00")!.toISOString()).toBe("2026-08-01T13:04:40.000Z");
    // An offset must be honoured, not overwritten with Z.
    expect(utcToDate("2026-08-01 08:04:40-05:00")!.toISOString()).toBe("2026-08-01T13:04:40.000Z");
  });

  it("tolerates surrounding whitespace", () => {
    expect(utcToDate("  2026-08-01 13:04:40  ")!.toISOString()).toBe("2026-08-01T13:04:40.000Z");
  });

  it("returns null for anything unusable rather than an Invalid Date", () => {
    // A component rendering `Invalid Date` is worse than one rendering a dash.
    for (const value of [null, undefined, "", "   ", "not a date", "2026-13-45 99:99:99"]) {
      expect(utcToDate(value)).toBeNull();
    }
  });

  it("a Central-time viewer sees the offset applied", () => {
    // 13:04 UTC is 08:04 CDT (UTC-5). Formatting is the browser's job; this
    // just pins that the instant handed to it is the right one.
    const date = utcToDate("2026-08-01 13:04:40")!;
    expect(
      date.toLocaleString("en-US", { timeZone: "America/Chicago", timeStyle: "short", dateStyle: "short" }),
    ).toContain("8:04");
  });

  it("a UTC-formatted render is what the bug looked like", () => {
    const date = utcToDate("2026-08-01 13:04:40")!;
    expect(date.toLocaleString("en-US", { timeZone: "UTC", timeStyle: "short" })).toContain("1:04");
  });
});
