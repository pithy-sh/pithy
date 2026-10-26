// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { describe, expect, test } from "vitest";
import { AccessHistoryQuery } from "./schemas";

const SINCE = "2026-06-10T12:00:00.000Z";

/** The paths of the issues a refused query carries, so a test names which bound refused it. */
function refusedAt(query: Record<string, unknown>): (string | number)[][] {
  const parsed = AccessHistoryQuery.safeParse(query);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map((key) => key as string | number));
}

describe("AccessHistoryQuery (#831)", () => {
  test("a window of one instant is a window, not a backwards one", () => {
    const parsed = AccessHistoryQuery.parse({ since: SINCE, until: SINCE });
    expect(parsed.until?.getTime()).toBe(parsed.since.getTime());
  });

  test("a window that ends before it starts is refused, on `until`", () => {
    expect(refusedAt({ since: SINCE, until: "2026-06-10T11:59:59.999Z" })).toEqual([["until"]]);
  });

  test("`since` is required, so the whole trail is never replayed by default", () => {
    expect(refusedAt({ until: SINCE })).toEqual([["since"]]);
  });

  test("`until` left out stays undefined, for the handler to read as now", () => {
    const parsed = AccessHistoryQuery.parse({ since: SINCE });
    expect(parsed.until).toBeUndefined();
    expect(parsed.since).toEqual(new Date(SINCE));
  });

  test("the page size is bounded at both ends, and a query string's number is read as one", () => {
    expect(refusedAt({ since: SINCE, limit: "0" })).toEqual([["limit"]]);
    expect(refusedAt({ since: SINCE, limit: String(MAX_PAGE_SIZE + 1) })).toEqual([["limit"]]);
    expect(AccessHistoryQuery.parse({ since: SINCE, limit: "1" }).limit).toBe(1);
    expect(AccessHistoryQuery.parse({ since: SINCE, limit: String(MAX_PAGE_SIZE) }).limit).toBe(MAX_PAGE_SIZE);
  });

  test("a cursor is bounded, because it is opaque but still a caller's string", () => {
    expect(AccessHistoryQuery.parse({ since: SINCE, cursor: "c".repeat(512) }).cursor).toHaveLength(512);
    expect(refusedAt({ since: SINCE, cursor: "c".repeat(513) })).toEqual([["cursor"]]);
  });
});
