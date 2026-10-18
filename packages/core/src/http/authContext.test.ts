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

  test("describes scopes as attestations about the caller, not permissions granted to the user", () => {
    // The name invites the wrong reading, and an earlier draft of #560 put tenancy roles in here. The
    // description is where the distinction is carried, because renaming the field breaks four packages.
    const description = AuthContext.shape.scopes.description ?? "";
    expect(description).toMatch(/attestations about the caller/i);
    expect(description).toMatch(/not permissions granted to the user/i);
  });

  test("rejects a context missing userId", () => {
    expect(() => AuthContext.parse({ sessionId: "s1" })).toThrow();
  });
});
