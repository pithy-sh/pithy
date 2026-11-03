// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ReplyInput } from "./schemas";

describe("ReplyInput.agentName", () => {
  test("a person's name is accepted", () => {
    expect(ReplyInput.safeParse({ body: "Done.", agentName: "Jim O'Brien-Scott" }).success).toBe(true);
  });

  for (const name of ["jim@acme.test", "Jim <jim@acme.test>", 'Jim "the boss"', "Jim >"]) {
    test(`${JSON.stringify(name)} is refused, since a display name must not look like an address`, () => {
      expect(ReplyInput.safeParse({ body: "Done.", agentName: name }).success).toBe(false);
    });
  }
});
