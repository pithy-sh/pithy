// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { resolveTimezoneSendAt } from "./sendAt";

/** Read back the wall-clock `HH:MM` an instant shows in a given timezone. */
function wallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    instant,
  );
}

describe("resolveTimezoneSendAt", () => {
  test("resolves to the requested wall-clock time in the recipient's zone", () => {
    const now = new Date("2026-06-18T08:00:00.000Z");
    const sendAt = resolveTimezoneSendAt("10:00", "America/New_York", now);
    expect(wallClock(sendAt, "America/New_York")).toBe("10:00");
    expect(sendAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  test("rolls to the next day when the local time has already passed", () => {
    // 23:00 UTC is well past 10:00 in New York that day, so the next 10:00 is tomorrow.
    const now = new Date("2026-06-18T23:00:00.000Z");
    const sendAt = resolveTimezoneSendAt("10:00", "America/New_York", now);
    expect(wallClock(sendAt, "America/New_York")).toBe("10:00");
    expect(sendAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test("handles a zone east of UTC", () => {
    const now = new Date("2026-06-18T00:00:00.000Z");
    const sendAt = resolveTimezoneSendAt("09:30", "Asia/Tokyo", now);
    expect(wallClock(sendAt, "Asia/Tokyo")).toBe("09:30");
  });

  test("rejects a malformed local time", () => {
    expect(() => resolveTimezoneSendAt("25:00", "Asia/Tokyo", new Date())).toThrow();
  });

  test("rejects an unknown timezone", () => {
    expect(() => resolveTimezoneSendAt("10:00", "Mars/Phobos", new Date())).toThrow();
  });
});
