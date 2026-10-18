// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { checkAnalyticsWindow, DEFAULT_WINDOW_DAYS, resolveAnalyticsWindow, type WindowRefusal } from "./window";

const DAY = 86_400_000;
const now = new Date("2026-10-17T12:00:00.000Z");

/** A refusal factory that hands the refusal back, so a test reads what a caller's error class would carry. */
class Refused extends Error {
  constructor(readonly refusal: WindowRefusal) {
    super(refusal.message);
  }
}
const refuse = (refusal: WindowRefusal) => new Refused(refusal);

/** What a call threw, as the refusal it carried. */
function refusalOf(run: () => unknown): WindowRefusal | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
  return undefined;
}

const LIMITS = { enabled: true, maxDuration: 2_764_800, notOlderThan: 7_948_800, maxPageSize: 10_000 };
const MEASURED = { dataset: "turnstileAdaptiveGroups", label: "Turnstile events" };

describe("resolveAnalyticsWindow", () => {
  test("defaults to the last 30 days, ending now", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
    expect(resolveAnalyticsWindow({}, now, refuse)).toEqual({ since: new Date(now.getTime() - 30 * DAY), until: now });
  });

  test("a since alone runs to now, and an until alone reaches back 30 days", () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    expect(resolveAnalyticsWindow({ since }, now, refuse)).toEqual({ since, until: now });
    const until = new Date("2026-10-10T00:00:00.000Z");
    expect(resolveAnalyticsWindow({ until }, now, refuse)).toEqual({
      since: new Date(until.getTime() - 30 * DAY),
      until,
    });
  });

  test("a window that ends before it starts is refused through the caller's own error", () => {
    const refusal = refusalOf(() =>
      resolveAnalyticsWindow({ since: now, until: new Date(now.getTime() - DAY) }, now, refuse),
    );
    expect(refusal?.message).toBe("That window ends before it starts. Put since before until.");
  });
});

describe("checkAnalyticsWindow", () => {
  test("a window inside the dataset's retention and span passes", () => {
    const window = resolveAnalyticsWindow({}, now, refuse);
    expect(refusalOf(() => checkAnalyticsWindow(window, LIMITS, MEASURED, now, refuse))).toBeUndefined();
  });

  test("a window starting past retention is refused, naming the cap in days and the dataset", () => {
    const window = { since: new Date(now.getTime() - 100 * DAY), until: new Date(now.getTime() - 90 * DAY) };
    const refusal = refusalOf(() => checkAnalyticsWindow(window, LIMITS, MEASURED, now, refuse));
    expect(refusal?.message).toBe("That window starts 100 days ago. Cloudflare keeps Turnstile events for 92 days.");
    expect(refusal?.params).toEqual({ maxDays: 92, dataset: "turnstileAdaptiveGroups" });
  });

  test("a window wider than one read may ask for is refused, naming the span cap", () => {
    const window = { since: new Date(now.getTime() - 40 * DAY), until: now };
    const refusal = refusalOf(() => checkAnalyticsWindow(window, LIMITS, MEASURED, now, refuse));
    expect(refusal?.message).toBe(
      "That window spans 40 days. Cloudflare answers at most 32 days of Turnstile events at once.",
    );
    expect(refusal?.params).toEqual({ maxDays: 32, dataset: "turnstileAdaptiveGroups" });
  });
});
