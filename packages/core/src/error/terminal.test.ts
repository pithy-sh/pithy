// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ForbiddenError, InternalError } from "./pithyError";
import { renderTerminal } from "./terminal";

describe("renderTerminal", () => {
  test("renders message as the problem line and action as the action line", () => {
    const err = new ForbiddenError({ message: "Forbidden.", action: "Ask an admin for access." });
    expect(renderTerminal(err.payload)).toBe("Forbidden.\nAsk an admin for access.");
  });

  test("renders just the problem line when there is no action", () => {
    const err = new InternalError();
    expect(renderTerminal(err.payload)).toBe("Something unexpected happened.");
  });

  test("never includes internal detail", () => {
    const err = new ForbiddenError({ message: "No.", detail: "user 5 lacks role:admin" });
    expect(renderTerminal(err.payload)).not.toContain("user 5");
  });
});
