// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { McpFloor } from "@pithy-sh/auth/src/mcp/floor";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { ACCESS_FLOOR, optionForm } from "./optionForms";

describe("ACCESS_FLOOR", () => {
  test.each([
    ["signed-in", "signed-in"],
    ["power:agents", { power: "agents" }],
    ["power:agents:use", { power: "agents:use" }],
    ["entitlement:pro", { entitlement: "pro" }],
  ])("reads %s as the floor mcp() takes", (spelling, value) => {
    expect(ACCESS_FLOOR.parse(spelling, "mcp")).toEqual(value);
    expect(McpFloor.parse(ACCESS_FLOOR.parse(spelling, "mcp"))).toEqual(value);
  });

  test.each([["signed-in"], ["power:agents:use"], ["entitlement:pro"]])(
    "spells %s back the way it was read",
    (spelling) => {
      expect(ACCESS_FLOOR.spell(ACCESS_FLOOR.parse(spelling, "mcp"))).toBe(spelling);
    },
  );

  test.each([["everyone"], ["power:"], ["entitlement:"], ["power"], [""]])(
    "refuses %j, naming every spelling it takes",
    (spelling) => {
      let caught: unknown;
      try {
        ACCESS_FLOOR.parse(spelling, "mcp");
      } catch (thrown) {
        caught = thrown;
      }
      expect(caught).toBeInstanceOf(PithyError);
      const action = (caught as PithyError).payload.action ?? "";
      expect(action).toContain("--floor signed-in");
      expect(action).toContain("--floor power:<name>");
      expect(action).toContain("--floor entitlement:<name>");
    },
  );

  test("says what each spelling admits", () => {
    expect(ACCESS_FLOOR.spellings.map((one) => one.spelling)).toEqual([
      "signed-in",
      "power:<name>",
      "entitlement:<name>",
    ]);
    for (const one of ACCESS_FLOOR.spellings) expect(one.admits).toMatch(/\.$/);
  });
});

describe("optionForm", () => {
  test("is mcp's floor, and nothing else", () => {
    expect(optionForm("mcp", "floor")).toBe(ACCESS_FLOOR);
    expect(optionForm("mcp", "path")).toBeUndefined();
    expect(optionForm("auth", "floor")).toBeUndefined();
  });
});
