// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type ConsoleGateReading, combineGates, gateOf } from "./gateReading";

const context = { file: ".oxlintrc.json", rule: "no-console", extended: null };

describe("gateOf", () => {
  test("is enforced only when every file is", () => {
    expect(gateOf([{ state: "enforced" }, { state: "enforced" }], context)).toEqual({
      state: "enforced",
      file: ".oxlintrc.json",
    });
  });

  test("reads a disabled file before a lowered one, and a lowered one before an unstated one", () => {
    const unstated = { state: "unstated", path: "apps/a/src/x.ts" } as const;
    const lowered = { state: "lowered", why: "lowered." } as const;
    const disabled = { state: "disabled", why: "disabled." } as const;
    expect(gateOf([unstated, lowered, disabled], context)).toMatchObject({ state: "off", cause: "disabled" });
    expect(gateOf([unstated, lowered], context)).toMatchObject({ state: "off", cause: "lowered", reason: "lowered." });
    expect(gateOf([unstated], context)).toEqual({
      state: "off",
      file: ".oxlintrc.json",
      rule: "no-console",
      cause: "unstated",
      reason: "no-console is not on for apps/a/src/x.ts in .oxlintrc.json.",
    });
  });

  test("is unverifiable for an extended config unless a file is already off", () => {
    const extended = { ...context, extended: "extends." };
    expect(gateOf([{ state: "enforced" }], extended)).toEqual({
      state: "unverifiable",
      file: ".oxlintrc.json",
      reason: "extends.",
    });
    expect(gateOf([{ state: "unstated", path: "x.ts" }], extended).state).toBe("unverifiable");
    expect(gateOf([{ state: "lowered", why: "w." }], extended).state).toBe("off");
  });
});

describe("combineGates", () => {
  const enforced = (file: string): ConsoleGateReading => ({ state: "enforced", file });
  const off: ConsoleGateReading = { state: "off", file: "biome.jsonc", rule: "r", cause: "unstated", reason: "o." };
  const unverifiable: ConsoleGateReading = { state: "unverifiable", file: ".oxlintrc.json", reason: "u." };

  test("passes one reading through unchanged", () => {
    expect(combineGates([enforced("biome.jsonc")])).toEqual(enforced("biome.jsonc"));
  });

  test("is enforced only when both are, naming both files", () => {
    expect(combineGates([enforced("biome.jsonc"), enforced(".oxlintrc.json")])).toEqual({
      state: "enforced",
      file: "biome.jsonc and .oxlintrc.json",
    });
  });

  test("lets one open linter decide, ahead of one it could not read", () => {
    expect(combineGates([enforced(".oxlintrc.json"), off])).toBe(off);
    expect(combineGates([unverifiable, off])).toBe(off);
    expect(combineGates([enforced("biome.jsonc"), unverifiable])).toBe(unverifiable);
  });
});
