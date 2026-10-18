// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  type AllowanceDeclarations,
  PaymentsAllowanceDefaults,
  PaymentsEntitlementDeclaration,
} from "../config/allowances";
import { overrideCeiling } from "./override";

/**
 * Three tiers and a comp key. `emails` is bounded on `start` and `growth` and unbounded on `scale`;
 * `projects` is bounded on both keys that declare it; `comp` declares neither; `seats` lives only on the floor.
 */
const declarations: AllowanceDeclarations = {
  entitlements: {
    start: PaymentsEntitlementDeclaration.parse({
      name: "Start",
      quotas: { emails: 500, projects: 3 },
      overrideMax: { emails: 10_000, projects: 20 },
    }),
    growth: PaymentsEntitlementDeclaration.parse({
      name: "Growth",
      quotas: { emails: 5000, projects: 10 },
      overrideMax: { emails: 100_000, projects: 50 },
    }),
    scale: PaymentsEntitlementDeclaration.parse({
      name: "Scale",
      quotas: { emails: null },
    }),
    comp: PaymentsEntitlementDeclaration.parse({
      name: "Comp",
      features: { sso: true },
    }),
  },
  defaults: PaymentsAllowanceDefaults.parse({ quotas: { seats: 2 } }),
};

const ceiling = (held: string[], name: string) => overrideCeiling(declarations, new Set(held), name);

describe("overrideCeiling", () => {
  test("a single held key's ceiling is the ceiling", () => {
    expect(ceiling(["start"], "emails")).toBe(10_000);
  });

  test("across several held keys that declare the name, the most permissive ceiling applies", () => {
    expect(ceiling(["start", "growth"], "emails")).toBe(100_000);
    expect(ceiling(["growth", "start"], "emails")).toBe(100_000);
  });

  test("a held key declaring the name with no ceiling leaves it unbounded, whatever the others state", () => {
    // `scale` comes after `growth` in declaration order, so a loop that skipped it would answer 100,000.
    expect(ceiling(["growth", "scale"], "emails")).toBeUndefined();
    expect(ceiling(["scale"], "emails")).toBeUndefined();
  });

  test("a held key that does not declare the name has no say", () => {
    expect(ceiling(["start", "comp"], "emails")).toBe(10_000);
    expect(ceiling(["start", "comp"], "projects")).toBe(20);
  });

  test("holding no key that declares the name falls back to every declaration of it", () => {
    expect(ceiling([], "projects")).toBe(50);
    expect(ceiling(["comp"], "projects")).toBe(50);
    // Every declaration of `emails` includes `scale`, which states no ceiling, so nothing bounds it.
    expect(ceiling([], "emails")).toBeUndefined();
    expect(ceiling(["comp"], "emails")).toBeUndefined();
  });

  test("a name only the floor declares has no ceiling", () => {
    expect(ceiling([], "seats")).toBeUndefined();
    expect(ceiling(["growth"], "seats")).toBeUndefined();
  });
});
