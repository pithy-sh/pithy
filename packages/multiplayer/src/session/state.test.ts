// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { everJoined } from "./state";

describe("everJoined", () => {
  test("keeps a player who left, in first-join order", () => {
    expect(everJoined({ joined: ["alice", "bob", "carol"], members: ["alice", "carol"] })).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  test("a session with no record reads its members", () => {
    expect(everJoined({ members: ["alice", "bob"] })).toEqual(["alice", "bob"]);
  });

  test("a member the record missed is still counted, once", () => {
    expect(everJoined({ joined: ["alice"], members: ["alice", "bob"] })).toEqual(["alice", "bob"]);
  });
});
