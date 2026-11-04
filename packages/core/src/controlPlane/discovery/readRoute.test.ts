// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import type { AdminRouteDeclaration } from "./adminRoute";
import { readsOnly } from "./readRoute";

describe("readsOnly", () => {
  test("a GET reads, and a POST reads only when it declares both the kind and the marker", () => {
    expect(readsOnly({ method: "GET" })).toBe(true);
    expect(readsOnly({ method: "POST", kind: "reads", readInBody: true })).toBe(true);
    expect(readsOnly({ method: "POST", kind: "reads" })).toBe(false);
    expect(readsOnly({ method: "POST", kind: "writes", readInBody: true })).toBe(false);
    expect(readsOnly({ method: "DELETE", kind: "reads", readInBody: true })).toBe(false);
  });
});

describe("a capability's read-in-a-body markers", () => {
  /** A capability declaring `route` beside nothing else. */
  const declaring = (route: AdminRouteDeclaration) =>
    defineCapability({ name: "desk", requiredBindings: [], adminRoutes: [route] });

  test("are accepted on a POST read", () => {
    expect(() =>
      declaring({
        method: "POST",
        path: "/desk/search",
        scope: "desk:tickets:read",
        kind: "reads",
        readInBody: true,
        summary: "Search.",
      }),
    ).not.toThrow();
  });

  test.each([
    ["a POST of another kind", { method: "POST", kind: "writes", readInBody: true }],
    ["a DELETE", { method: "DELETE", kind: "reads", readInBody: true }],
    ["a marker that is not true", { method: "POST", kind: "reads", readInBody: "true" }],
  ])("are refused on %s, naming the capability", (_, shape) => {
    const route = { path: "/desk/x", scope: "desk:tickets:read", summary: "X.", ...shape };
    expect(() => declaring(route as unknown as AdminRouteDeclaration)).toThrow(/desk declares an admin route/);
  });
});
