// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { AUDIT_MIGRATION_ORDER, AuditConfig, audit, isAuditCapability } from "./capability";

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

  test("ships its migrations in order, at its declared order", () => {
    // The keys are the order they run in, so the list is asserted rather than the count: a migration
    // added ahead of `0001_init` would compose a ledger name that sorts before an applied one.
    const db = audit().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual(["0001_init", "0002_tenant"]);
    expect(db?.migrationOrder).toBe(AUDIT_MIGRATION_ORDER);
  });

  test("installs a middleware that replaces the emit seam", () => {
    expect(audit().middleware?.length).toBe(1);
  });

  test("mounts its control-plane read routes at /audit by default", () => {
    // The default lives in `AuditConfig` and nowhere else. A second fallback inside the route
    // registrar is how the mounted path and the advertised path drift apart, and a management client
    // composing calls from a manifest that names the wrong one 404s against exactly the adopters who
    // changed something.
    expect(AuditConfig.parse({}).basePath).toBe("/audit");
    expect(audit().adminRoutes?.map((route) => route.path)).toEqual(["/audit/events", "/audit/events/:eventId"]);
    expect(audit({ basePath: "/trail" }).adminRoutes?.map((route) => route.path)).toEqual([
      "/trail/events",
      "/trail/events/:eventId",
    ]);
  });

  test("every advertised route is a read, behind its own scope", () => {
    // The trail is append-only, and the two scopes are what stops a credential issued to render a
    // recent-activity pane from also resolving every client IP in the project.
    const routes = audit().adminRoutes ?? [];
    expect(routes.map((route) => route.method)).toEqual(["GET", "GET"]);
    expect(new Set(routes.map((route) => route.scope)).size).toBe(routes.length);
  });

  test("is discoverable via isAuditCapability and rejects other capabilities", () => {
    expect(isAuditCapability(audit())).toBe(true);
    const other = { name: "email", requiredBindings: [] } as Capability;
    expect(isAuditCapability(other)).toBe(false);
  });
});
