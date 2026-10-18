// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { statedQuantity } from "./quantity";

describe("statedQuantity", () => {
  test("a positive whole number crosses; anything else is null, never an invented 1", () => {
    expect(statedQuantity(25)).toBe(25);
    for (const value of [undefined, null, 0, -1, 2.5, "3"]) expect(statedQuantity(value)).toBeNull();
  });
});
