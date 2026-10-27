// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test } from "vitest";
import { reachPatterns, routeParams, routeSubject } from "./routePattern";

/**
 * How a declared admin route becomes something SQL can match a called path against (#828), and how a called path is
 * read back into the subject ids its route's parameters name. That SQLite matches the glob the way these say is
 * proven against real D1 in `reach.workers.test.ts`.
 */

describe("reachPatterns", () => {
  test("a parameter becomes a glob star, and the slash count pins it to one segment", () => {
    const [pattern] = reachPatterns([{ method: "GET", path: "/admin/users/:userId" }]);
    expect(pattern).toEqual({
      method: "GET",
      pattern: "/admin/users/:userId",
      glob: "/admin/users/*",
      slashes: 3,
      params: 1,
      rank: 0,
    });
  });

  test("a parameter's regex and optional mark are dropped from the glob", () => {
    const [pattern] = reachPatterns([{ method: "GET", path: "/things/:id{[0-9]+}/:part?" }]);
    expect(pattern?.glob).toBe("/things/*/*");
    expect(pattern?.params).toBe(2);
  });

  test("a trailing wildcard matches any depth, so its slash count is free", () => {
    const [pattern] = reachPatterns([{ method: "GET", path: "/files/*" }]);
    expect(pattern?.slashes).toBeNull();
    expect(pattern?.glob).toBe("/files/*");
  });

  test("glob metacharacters in a literal segment are escaped", () => {
    const [pattern] = reachPatterns([{ method: "GET", path: "/odd/[x]?/*a" }]);
    expect(pattern?.glob).toBe("/odd/[[]x][?]/[*]a");
  });

  test("the more literal route ranks first, so a static path beats the parameter beside it", () => {
    const patterns = reachPatterns([
      { method: "GET", path: "/admin/users/:userId" },
      { method: "GET", path: "/files/*" },
      { method: "GET", path: "/admin/users/search" },
    ]);
    expect(patterns.map((pattern) => [pattern.pattern, pattern.rank])).toEqual([
      ["/admin/users/search", 0],
      ["/admin/users/:userId", 1],
      ["/files/*", 2],
    ]);
  });

  test("a route declared twice is matched once", () => {
    const patterns = reachPatterns([
      { method: "GET", path: "/audit/events" },
      { method: "GET", path: "/audit/events" },
    ]);
    expect(patterns).toHaveLength(1);
  });
});

describe("routeParams", () => {
  test("names each parameter's value from the called path", () => {
    expect(routeParams("/orgs/:orgId/members/:userId", "/orgs/o_1/members/u_2")).toEqual({
      orgId: "o_1",
      userId: "u_2",
    });
  });

  test("decodes a percent-encoded segment, and leaves a malformed one as called", () => {
    expect(routeParams("/admin/users/:userId", "/admin/users/ada%40example.com")).toEqual({
      userId: "ada@example.com",
    });
    expect(routeParams("/admin/users/:userId", "/admin/users/%E0%A4%A")).toEqual({ userId: "%E0%A4%A" });
  });

  test("a route without parameters names none, and a path that does not fit names none", () => {
    expect(routeParams("/audit/events", "/audit/events")).toEqual({});
    expect(routeParams("/admin/users/:userId", "/elsewhere")).toEqual({});
  });
});

describe("routeSubject", () => {
  test("the subject is the last parameter that names an id, not the last parameter", () => {
    // Ledger's shape: the user is the subject, and the currency after it only narrows what was read of them.
    expect(
      routeSubject(
        "/ledger/admin/accounts/:userId/:currency/transactions",
        "/ledger/admin/accounts/u_1/USD/transactions",
      ),
    ).toEqual({ subjectId: "u_1", key: JSON.stringify(["u_1"]) });
    expect(routeSubject("/admin/things/:id/:format", "/admin/things/t_1/csv")).toEqual({
      subjectId: "t_1",
      key: JSON.stringify(["t_1"]),
    });
  });

  test("the parameters before the subject qualify it, so one id of two subject types is two subjects", () => {
    const user = routeSubject("/admin/entitlements/:subjectType/:subjectId", "/admin/entitlements/user/s_1");
    const organization = routeSubject(
      "/admin/entitlements/:subjectType/:subjectId",
      "/admin/entitlements/organization/s_1",
    );
    expect(user.subjectId).toBe("s_1");
    expect(organization.subjectId).toBe("s_1");
    expect(user.key).not.toBe(organization.key);
  });

  test("a route whose parameters name no id falls back to its last parameter", () => {
    expect(routeSubject("/admin/currencies/:code/:region", "/admin/currencies/USD/eu")).toEqual({
      subjectId: "eu",
      key: JSON.stringify(["USD", "eu"]),
    });
  });

  test("a route with no parameters, or a path that does not fit, names no subject", () => {
    expect(routeSubject("/admin/users", "/admin/users")).toEqual({ subjectId: null, key: null });
    expect(routeSubject("/admin/users/:userId", "/elsewhere")).toEqual({ subjectId: null, key: null });
  });
});
