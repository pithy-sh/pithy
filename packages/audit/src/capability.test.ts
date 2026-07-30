// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { AUDIT_MIGRATION_ORDER, audit, isAuditCapability } from "./capability";

describe("audit capability", () => {
  test("contributes the audit table to the app database on the DB binding by default", () => {
    const db = audit().databases?.app;
    expect(db?.binding).toBe("DB");
    expect(Object.keys(db?.tables ?? {})).toEqual(["pithyAuditEvents"]);
  });

  // Table keys are camelCase (CamelCasePlugin emits the snake_case `pithy_audit_` SQL); every
  // provided table must be namespaced under the capability so it can't clash with an adopter's.
  test("every provided table is namespaced under pithyAudit (the pithy_audit_ prefix)", () => {
    for (const name of Object.keys(audit().databases?.app?.tables ?? {})) {
      expect(name.startsWith("pithyAudit")).toBe(true);
    }
  });

  test("defaults the database binding to DB and requires it", () => {
    const byName = Object.fromEntries(audit().requiredBindings.map((b) => [b.name, b.type]));
    expect(byName.DB).toBe("d1");
  });

  test("honors a configured database binding for the table, migration, and required binding", () => {
    const cap = audit({ database: "ANALYTICS" });
    expect(cap.auditDatabase).toBe("ANALYTICS");
    expect(cap.databases?.app?.binding).toBe("ANALYTICS");
    expect(cap.requiredBindings.map((b) => b.name)).toEqual(["ANALYTICS"]);
  });

  test("ships the 0001_init migration at its declared order", () => {
    const db = audit().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual(["0001_init"]);
    expect(db?.migrationOrder).toBe(AUDIT_MIGRATION_ORDER);
  });

  test("installs a middleware that replaces the emit seam", () => {
    expect(audit().middleware?.length).toBe(1);
  });

  test("is discoverable via isAuditCapability and rejects other capabilities", () => {
    expect(isAuditCapability(audit())).toBe(true);
    const other = { name: "email", requiredBindings: [] } as Capability;
    expect(isAuditCapability(other)).toBe(false);
  });
});
