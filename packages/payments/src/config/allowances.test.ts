// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  AllowanceName,
  declarationProblems,
  declaredFeatureNames,
  declaredQuotaNames,
  PaymentsAllowanceDefaults,
  PaymentsEntitlementDeclaration,
  QuotaValue,
} from "./allowances";

const growth = PaymentsEntitlementDeclaration.parse({
  name: "Growth",
  quotas: { emails: 5000, projects: 10, seats: 10 },
  features: { sso: true, auditExport: false },
  overrideMax: { emails: 100_000 },
});

describe("QuotaValue", () => {
  test("a whole number from zero, or null for unlimited", () => {
    expect(QuotaValue.parse(0)).toBe(0);
    expect(QuotaValue.parse(25)).toBe(25);
    expect(QuotaValue.parse(null)).toBeNull();
  });

  test.each([[1.5], [-1], ["25"], [Number.NaN]])("refuses %p", (value) => {
    expect(QuotaValue.safeParse(value).success).toBe(false);
  });
});

describe("AllowanceName", () => {
  test.each([["emails"], ["auditExport"], ["storage_bytes"]])("accepts %s", (name) => {
    expect(AllowanceName.parse(name)).toBe(name);
  });

  test.each([["Emails"], ["1seats"], ["two words"], [""]])("refuses %p", (name) => {
    expect(AllowanceName.safeParse(name).success).toBe(false);
  });
});

describe("PaymentsEntitlementDeclaration", () => {
  test("a key with no quotas and no features still parses — the boolean case is the floor of the model", () => {
    expect(PaymentsEntitlementDeclaration.parse({ name: "Pro" })).toEqual({ name: "Pro", quotas: {}, features: {} });
  });

  test("a non-integer quota is refused, and the path names the quota", () => {
    const result = PaymentsEntitlementDeclaration.safeParse({ name: "Growth", quotas: { emails: 2.5 } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["quotas", "emails"]);
  });

  test("defaults parse empty", () => {
    expect(PaymentsAllowanceDefaults.parse({})).toEqual({ quotas: {}, features: {} });
  });
});

describe("declared names", () => {
  test("are derived from every key and the floor, deduplicated and sorted", () => {
    const declarations = {
      entitlements: { growth, start: PaymentsEntitlementDeclaration.parse({ name: "Start", quotas: { storage: 1 } }) },
      defaults: PaymentsAllowanceDefaults.parse({ quotas: { emails: 50 }, features: { beta: false } }),
    };
    expect(declaredQuotaNames(declarations)).toEqual(["emails", "projects", "seats", "storage"]);
    expect(declaredFeatureNames(declarations)).toEqual(["auditExport", "beta", "sso"]);
  });

  test("a project declaring nothing declares no names", () => {
    expect(declaredQuotaNames({ entitlements: {} })).toEqual([]);
    expect(declaredFeatureNames({ entitlements: {} })).toEqual([]);
  });
});

describe("declarationProblems", () => {
  test("a sound declaration has none", () => {
    expect(declarationProblems({ entitlements: { growth } })).toEqual([]);
  });

  test("an overrideMax naming a quota the key does not declare is refused, naming both", () => {
    const problems = declarationProblems({
      entitlements: { growth: { ...growth, overrideMax: { emals: 10 } } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toEqual(["entitlements", "growth", "overrideMax", "emals"]);
    expect(problems[0]?.message).toContain('"growth"');
    expect(problems[0]?.message).toContain('"emals"');
  });

  test("an overrideMax below the quota it bounds is refused — it would refuse what the plan already grants", () => {
    const problems = declarationProblems({
      entitlements: { growth: { ...growth, overrideMax: { emails: 4999 } } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("below the 5000");
  });

  test("an overrideMax equal to the quota is legal", () => {
    expect(declarationProblems({ entitlements: { growth: { ...growth, overrideMax: { emails: 5000 } } } })).toEqual([]);
  });

  test("an overrideMax on an unlimited quota is refused — every ceiling is below unlimited", () => {
    const scale = PaymentsEntitlementDeclaration.parse({
      name: "Scale",
      quotas: { emails: null },
      overrideMax: { emails: 1_000_000 },
    });
    expect(declarationProblems({ entitlements: { scale } })[0]?.message).toContain("unlimited");
  });

  test("a name declared as a quota on one key and a feature on another is refused", () => {
    const other = PaymentsEntitlementDeclaration.parse({ name: "Other", features: { seats: true } });
    expect(declarationProblems({ entitlements: { growth, other } })[0]?.message).toContain('"seats"');
  });
});
