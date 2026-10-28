// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { floorAdmits, floorLine, isOpenToEverySignedInUser, McpFloor } from "./floor";

const holding = (powers: string[], entitlements: string[] = []) => ({
  roleAllows: (power: string) => powers.includes(power),
  entitlements: async () => new Set(entitlements),
});

describe("McpFloor", () => {
  test("has no default: composing the endpoint means choosing a floor", () => {
    expect(McpFloor.safeParse(undefined).success).toBe(false);
    expect(McpFloor.safeParse({}).success).toBe(false);
    expect(McpFloor.safeParse({ power: "agents:use", entitlement: "pro" }).success).toBe(false);
  });

  test("takes a power, an entitlement, or signed-in", () => {
    expect(McpFloor.parse({ power: "agents:use" })).toEqual({ power: "agents:use" });
    expect(McpFloor.parse({ entitlement: "pro" })).toEqual({ entitlement: "pro" });
    expect(McpFloor.parse("signed-in")).toBe("signed-in");
  });
});

describe("floorAdmits", () => {
  test("a power floor admits only a role holding it, and nobody with no organization in force", async () => {
    expect(await floorAdmits({ power: "agents:use" }, holding(["agents:use"]))).toBe(true);
    expect(await floorAdmits({ power: "agents:use" }, holding([]))).toBe(false);
    expect(await floorAdmits({ power: "agents:use" }, { roleAllows: null, entitlements: async () => new Set() })).toBe(
      false,
    );
  });

  test("an entitlement floor admits only a holder", async () => {
    expect(await floorAdmits({ entitlement: "pro" }, holding([], ["pro"]))).toBe(true);
    expect(await floorAdmits({ entitlement: "pro" }, holding([], ["basic"]))).toBe(false);
  });

  test("signed-in admits every signed-in caller", async () => {
    expect(await floorAdmits("signed-in", { roleAllows: null, entitlements: async () => new Set() })).toBe(true);
  });
});

describe("floorLine", () => {
  test("says which floor is in force, and whether it is open", () => {
    expect(floorLine("signed-in")).toBe("open to every signed-in user");
    expect(isOpenToEverySignedInUser("signed-in")).toBe(true);
    expect(floorLine({ power: "agents:use" })).toBe("open only to callers whose role holds agents:use");
    expect(isOpenToEverySignedInUser({ power: "agents:use" })).toBe(false);
    expect(floorLine({ entitlement: "pro" })).toBe("open only to callers holding the pro entitlement");
  });
});
