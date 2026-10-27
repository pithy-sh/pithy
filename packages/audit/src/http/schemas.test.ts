// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { describe, expect, test } from "vitest";
import {
  AccessHistoryQuery,
  ChainExportQuery,
  ChainVerifyQuery,
  ControlPlaneReachQuery,
  MAX_EXPORT_PAGE,
} from "./schemas";

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

/**
 * The reach query's own rules (#828), read straight off the schema. The route test proves a refusal is a 400; this
 * proves which queries are refused and which are not, the boundaries included.
 */

const REACH_SINCE = "2026-10-01T00:00:00Z";
const BASE = { connectionId: "conn_1", since: REACH_SINCE };

function accepts(query: Record<string, string>): boolean {
  return ControlPlaneReachQuery.safeParse(query).success;
}

describe("ControlPlaneReachQuery", () => {
  test("needs a connection and a start", () => {
    expect(accepts(BASE)).toBe(true);
    expect(accepts({ since: REACH_SINCE })).toBe(false);
    expect(accepts({ connectionId: "conn_1" })).toBe(false);
  });

  test("decodes the window to dates", () => {
    const parsed = ControlPlaneReachQuery.parse({ ...BASE, until: "2026-10-02T00:00:00Z" });
    expect(parsed.since).toEqual(new Date(REACH_SINCE));
    expect(parsed.until).toEqual(new Date("2026-10-02T00:00:00Z"));
  });

  test("refuses a window that ends before it starts, and accepts one that ends as it starts", () => {
    expect(accepts({ ...BASE, until: "2026-09-30T23:59:59Z" })).toBe(false);
    expect(accepts({ ...BASE, until: REACH_SINCE })).toBe(true);
  });

  test("subjects=true needs a route, and subjects=false does not", () => {
    expect(accepts({ ...BASE, subjects: "true" })).toBe(false);
    expect(accepts({ ...BASE, subjects: "true", route: "/admin/users/:userId" })).toBe(true);
    expect(accepts({ ...BASE, subjects: "false" })).toBe(true);
    expect(accepts({ ...BASE, subjects: "yes", route: "/admin/users/:userId" })).toBe(false);
  });

  test("a route starts with a slash and is bounded", () => {
    expect(accepts({ ...BASE, route: "admin/users" })).toBe(false);
    expect(accepts({ ...BASE, route: "" })).toBe(false);
    expect(accepts({ ...BASE, route: `/${"a".repeat(511)}` })).toBe(true);
    expect(accepts({ ...BASE, route: `/${"a".repeat(512)}` })).toBe(false);
  });
});

/**
 * The chain queries' own rules (#822). A reversed window reaching the walk would resolve to no positions and answer
 * an empty "intact", so the refusal is the schema's, and is held here for both reads.
 */
describe.each([
  ["ChainVerifyQuery", ChainVerifyQuery],
  ["ChainExportQuery", ChainExportQuery],
] as const)("%s (#822)", (_name, schema) => {
  function chainRefusedAt(query: Record<string, string>): (string | number)[][] {
    const parsed = schema.safeParse(query);
    expect(parsed.success).toBe(false);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map((key) => key as string | number));
  }

  test("a window that ends before it starts is refused, on `until`", () => {
    expect(chainRefusedAt({ tenant: "acme", since: SINCE, until: "2026-06-10T11:59:59.999Z" })).toEqual([["until"]]);
  });

  test("a window of one instant is a window", () => {
    const parsed = schema.parse({ tenant: "acme", since: SINCE, until: SINCE });
    expect(parsed.until?.getTime()).toBe(parsed.since?.getTime());
  });

  test("the tenant is required, and empty names the untenanted chain", () => {
    expect(chainRefusedAt({ since: SINCE })).toEqual([["tenant"]]);
    expect(schema.parse({ tenant: "" }).tenant).toBeNull();
    expect(schema.parse({ tenant: "acme" }).tenant).toBe("acme");
  });
});

describe("ChainExportQuery's page size (#822)", () => {
  test("is bounded at both ends, and a query string's number is read as one", () => {
    for (const limit of ["0", String(MAX_EXPORT_PAGE + 1)]) {
      const parsed = ChainExportQuery.safeParse({ tenant: "acme", limit });
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path)).toEqual([["limit"]]);
    }
    expect(ChainExportQuery.parse({ tenant: "acme", limit: "1" }).limit).toBe(1);
    expect(ChainExportQuery.parse({ tenant: "acme", limit: String(MAX_EXPORT_PAGE) }).limit).toBe(MAX_EXPORT_PAGE);
  });
});
