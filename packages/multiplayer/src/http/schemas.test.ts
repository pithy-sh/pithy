// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { inputOf } from "@pithy-sh/core/src/controlPlane/discovery/routeInput";
import { validate } from "@pithy-sh/core/src/http/validation";
import { describe, expect, test } from "vitest";
import { AdminSessionsQuery } from "./schemas";

describe("AdminSessionsQuery.phase", () => {
  test("is open or active, and nothing else", () => {
    expect(AdminSessionsQuery.parse({ phase: "active" }).phase).toBe("active");
    expect(AdminSessionsQuery.safeParse({ phase: "ended" }).success).toBe(false);
  });

  test("reaches the manifest's route input, so a client can discover it", () => {
    const input = inputOf([validate("query", AdminSessionsQuery)]).properties as { query: { properties: object } };
    expect(Object.keys(input.query.properties)).toContain("phase");
  });
});
