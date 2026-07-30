// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AuthContext } from "./authContext";

describe("AuthContext", () => {
  test("parses a full context", () => {
    expect(AuthContext.parse({ userId: "u1", sessionId: "s1", scopes: ["read"] })).toEqual({
      userId: "u1",
      sessionId: "s1",
      scopes: ["read"],
    });
  });

  test("defaults scopes to an empty array", () => {
    expect(AuthContext.parse({ userId: "u1", sessionId: "s1" }).scopes).toEqual([]);
  });

  test("rejects a context missing userId", () => {
    expect(() => AuthContext.parse({ sessionId: "s1" })).toThrow();
  });
});
