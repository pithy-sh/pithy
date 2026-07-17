import { describe, expect, it } from "vitest";
import { ALL_TIME_WINDOW, assertValidSchedule, previousWindowKeys, windowKeyAt } from "./schedule";

const at = (iso: string) => new Date(iso);

describe("windowKeyAt", () => {
  it("returns the all-time sentinel when a board has no schedule", () => {
    expect(windowKeyAt(undefined, at("2026-07-16T12:00:00.000Z"))).toBe(ALL_TIME_WINDOW);
  });

  it("keys a daily board to the UTC midnight that opened the window", () => {
    expect(windowKeyAt("0 0 * * *", at("2026-07-16T12:34:56.000Z"))).toBe("2026-07-16T00:00:00.000Z");
  });

  it("treats an instant exactly on the boundary as opening the new window, not closing the old", () => {
    // The fire time is the first instant of its own window. Off-by-one here would file a
    // submission into the window that just closed.
    expect(windowKeyAt("0 0 * * *", at("2026-07-16T00:00:00.000Z"))).toBe("2026-07-16T00:00:00.000Z");
  });

  it("keys a weekly Monday board back to Monday, not to the current day", () => {
    // 2026-07-16 is a Thursday; the Monday that opened the window is 2026-07-13.
    expect(windowKeyAt("0 0 * * 1", at("2026-07-16T12:00:00.000Z"))).toBe("2026-07-13T00:00:00.000Z");
  });

  it("keys a calendar-month board to the first of the month — the gap Apple and Google leave open", () => {
    expect(windowKeyAt("0 0 1 * *", at("2026-07-16T12:00:00.000Z"))).toBe("2026-07-01T00:00:00.000Z");
  });

  it("tracks month length variance across a 28-day February, which a fixed 30-day recurrence cannot", () => {
    expect(windowKeyAt("0 0 1 * *", at("2026-02-28T23:59:59.999Z"))).toBe("2026-02-01T00:00:00.000Z");
    expect(windowKeyAt("0 0 1 * *", at("2026-03-01T00:00:00.000Z"))).toBe("2026-03-01T00:00:00.000Z");
  });

  it("keys a calendar-year board to January 1 — unambiguously impossible on Game Center", () => {
    expect(windowKeyAt("0 0 1 1 *", at("2026-07-16T12:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is UTC-anchored regardless of the host timezone", () => {
    // A local-time parse would key this instant to the previous day in any negative-offset zone.
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(windowKeyAt("0 0 * * *", at("2026-07-16T03:00:00.000Z"))).toBe("2026-07-16T00:00:00.000Z");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("assertValidSchedule", () => {
  it("accepts a well-formed expression", () => {
    expect(() => assertValidSchedule("0 0 * * 1")).not.toThrow();
  });

  it("rejects a malformed expression with a leaderboard-namespaced error", () => {
    expect(() => assertValidSchedule("not a cron")).toThrowError(/schedule/i);
  });

  it("rejects an expression that never fires, which would strand every submission", () => {
    // Feb 30 never occurs. This parses cleanly, so only a fire probe catches it.
    expect(() => assertValidSchedule("0 0 30 2 *")).toThrowError(/never fires/i);
  });

  it("accepts a leap-day board, which fires only every four years", () => {
    expect(() => assertValidSchedule("0 0 29 2 *")).not.toThrow();
  });
});

describe("previousWindowKeys", () => {
  it("returns the closed windows behind the current one, newest first", () => {
    expect(previousWindowKeys("0 0 * * *", at("2026-07-16T12:00:00.000Z"), 3)).toEqual([
      "2026-07-15T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z",
    ]);
  });

  it("returns nothing for an all-time board, which never closes a window", () => {
    expect(previousWindowKeys(undefined, at("2026-07-16T12:00:00.000Z"), 3)).toEqual([]);
  });

  it("returns nothing when retention keeps zero closed windows", () => {
    expect(previousWindowKeys("0 0 * * *", at("2026-07-16T12:00:00.000Z"), 0)).toEqual([]);
  });
});
