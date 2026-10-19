// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  type AllowanceDeclarations,
  PaymentsAllowanceDefaults,
  PaymentsEntitlementDeclaration,
} from "../config/allowances";
import {
  type AllowanceInput,
  type AllowanceOverride,
  requireDeclaredFeature,
  requireDeclaredQuota,
  resolveAllowances,
  resolveFeature,
  resolveQuota,
} from "./allowance";

/** The issue's own example: three sold tiers, a comp-only one, and a free floor. */
const declarations: AllowanceDeclarations = {
  entitlements: {
    start: PaymentsEntitlementDeclaration.parse({
      name: "Start",
      quotas: { emails: 500, projects: 3, seats: 2 },
      features: { sso: false, auditExport: false },
    }),
    growth: PaymentsEntitlementDeclaration.parse({
      name: "Growth",
      quotas: { emails: 5000, projects: 10, seats: 10 },
      features: { sso: true, auditExport: false },
      overrideMax: { emails: 100_000 },
    }),
    scale: PaymentsEntitlementDeclaration.parse({
      name: "Scale",
      quotas: { emails: null, projects: null, seats: 50 },
      features: { sso: true, auditExport: true },
    }),
    enterprise: PaymentsEntitlementDeclaration.parse({
      name: "Enterprise",
      quotas: { emails: null, projects: null, seats: null },
      features: { sso: true, auditExport: true },
    }),
  },
  defaults: PaymentsAllowanceDefaults.parse({
    quotas: { emails: 50, projects: 1, seats: 1 },
    features: { sso: false, auditExport: false },
  }),
};

const noOverride = null;

function input(held: string[], override: AllowanceOverride | null = noOverride, d = declarations): AllowanceInput {
  return { declarations: d, held: new Set(held), override };
}

const patch = (quotas: AllowanceOverride["quotas"] = {}, features: AllowanceOverride["features"] = {}) => ({
  unrestricted: false,
  quotas,
  features,
});

describe("resolution across held keys", () => {
  test("one held key answers its own number", () => {
    expect(resolveQuota(input(["growth"]), "emails").effective).toEqual({ value: 5000, source: "plan", key: "growth" });
  });

  test("two held keys resolve to the higher — the upgrade overlap must never read as a downgrade", () => {
    // An upgrade from start to growth, with start's subscription still in its last weeks.
    expect(resolveQuota(input(["start", "growth"]), "seats").effective.value).toBe(10);
    expect(resolveQuota(input(["growth", "start"]), "seats").effective.key).toBe("growth");
  });

  test("null is unlimited and beats every number", () => {
    expect(resolveQuota(input(["growth", "scale"]), "emails").effective).toEqual({
      value: null,
      source: "plan",
      key: "scale",
    });
  });

  test("a feature is on if any held key turns it on", () => {
    expect(resolveFeature(input(["start", "growth"]), "sso").effective.value).toBe(true);
    expect(resolveFeature(input(["start"]), "sso").effective).toEqual({ value: false, source: "plan", key: "start" });
  });
});

describe("the floor", () => {
  test("a name no held key speaks to falls to defaults", () => {
    const only = {
      entitlements: { pro: PaymentsEntitlementDeclaration.parse({ name: "Pro" }) },
      defaults: declarations.defaults,
    };
    expect(resolveQuota(input(["pro"], null, only), "emails").effective).toEqual({
      value: 50,
      source: "default",
      key: null,
    });
    expect(resolveQuota(input([], null), "projects").effective.value).toBe(1);
  });

  test("a name defaults does not declare resolves to 0 and false — never unlimited", () => {
    // Fail closed. A name that resolved to unlimited because nothing declared it is a paywall that silently
    // does not exist, and it is invisible until the invoice. So the floor below the floor is zero.
    const noFloor = { entitlements: declarations.entitlements };
    expect(resolveQuota(input([], null, noFloor), "emails").effective).toEqual({ value: 0, source: "none", key: null });
    expect(resolveFeature(input([], null, noFloor), "sso").effective).toEqual({
      value: false,
      source: "none",
      key: null,
    });
  });

  test("a key held but not declared contributes nothing", () => {
    expect(resolveQuota(input(["legacy"]), "emails").effective.source).toBe("default");
  });
});

describe("the override", () => {
  test("a sparse patch wins for the names it carries; the rest keep tracking the plan", () => {
    const pinned = patch({ emails: 20_000 });
    expect(resolveQuota(input(["growth"], pinned), "emails").effective).toEqual({
      value: 20_000,
      source: "override",
      key: null,
    });
    expect(resolveQuota(input(["growth"], pinned), "projects").effective).toEqual({
      value: 10,
      source: "plan",
      key: "growth",
    });
  });

  test("the inherited value is the plan's number even while an override pins the name", () => {
    expect(resolveQuota(input(["growth"], patch({ emails: 20_000 })), "emails").inherited).toEqual({
      value: 5000,
      source: "plan",
      key: "growth",
    });
  });

  test("upgraded under a standing override: every unmentioned name moved, the pinned one did not", () => {
    const pinned = patch({ emails: 20_000 });
    const before = resolveAllowances(input(["growth"], pinned));
    const after = resolveAllowances(input(["scale"], pinned));
    const value = (all: typeof before, name: string) => all.quotas.find((q) => q.name === name)?.effective.value;
    expect(value(before, "emails")).toBe(20_000);
    expect(value(after, "emails")).toBe(20_000);
    expect(value(before, "projects")).toBe(10);
    expect(value(after, "projects")).toBeNull();
    expect(value(after, "seats")).toBe(50);
    // And the inherited values are the new tier's, for every name.
    expect(after.quotas.map((q) => [q.name, q.inherited.value])).toEqual([
      ["emails", null],
      ["projects", null],
      ["seats", 50],
    ]);
  });

  test("unrestricted resolves every quota to unlimited and every feature on", () => {
    const all = resolveAllowances(input([], { unrestricted: true, quotas: {}, features: {} }));
    expect(all.quotas.every((q) => q.effective.value === null && q.effective.source === "unrestricted")).toBe(true);
    expect(all.features.every((f) => f.effective.value === true && f.effective.source === "unrestricted")).toBe(true);
  });

  test("unrestricted covers a name declared after the override was written", () => {
    // The override row is the same object before and after; only the declarations grew.
    const override: AllowanceOverride = { unrestricted: true, quotas: {}, features: {} };
    const grown: AllowanceDeclarations = {
      entitlements: {
        ...declarations.entitlements,
        growth: PaymentsEntitlementDeclaration.parse({ name: "Growth", quotas: { apiCalls: 1000 } }),
      },
      defaults: declarations.defaults,
    };
    expect(resolveQuota(input([], override, grown), "apiCalls").effective.value).toBeNull();
  });

  test("unrestricted with a patch pins the patched names and leaves the rest unlimited", () => {
    const override: AllowanceOverride = { unrestricted: true, quotas: { emails: 20_000 }, features: { sso: false } };
    expect(resolveQuota(input([], override), "emails").effective.value).toBe(20_000);
    expect(resolveQuota(input([], override), "seats").effective.value).toBeNull();
    expect(resolveFeature(input([], override), "sso").effective.value).toBe(false);
    expect(resolveFeature(input([], override), "auditExport").effective.value).toBe(true);
  });

  test("a feature pin wins over the plan", () => {
    expect(resolveFeature(input(["start"], patch({}, { sso: true })), "sso").effective).toEqual({
      value: true,
      source: "override",
      key: null,
    });
  });
});

describe("undeclared names", () => {
  test("a quota read for a name nothing declares throws core/internal, naming it and listing the declared", () => {
    // A typo must never read as unlimited, and must not read as zero either.
    try {
      requireDeclaredQuota(declarations, "emals");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.code).toBe("core/internal");
      expect(payload.message).toContain('"emals"');
      expect(payload.detail).toContain("emails, projects, seats");
    }
  });

  test("a feature read for a name nothing declares throws the same way", () => {
    expect(() => requireDeclaredFeature(declarations, "sssso")).toThrow(/sssso/);
    expect(() => requireDeclaredFeature(declarations, "sso")).not.toThrow();
  });
});
