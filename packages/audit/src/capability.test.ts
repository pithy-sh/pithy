// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { AUDIT_MIGRATION_ORDER, AuditConfig, audit, isAuditCapability } from "./capability";
import { AUDIT_CHAIN_EXPORT_SCOPE, AUDIT_EVENT_DETAIL_READ_SCOPE, AUDIT_TRAIL_READ_SCOPE } from "./http/guards";

describe("audit capability", () => {
  test("doctor asks whether object lock is in force on the checkpoint bucket (#822)", async () => {
    const refuse = async () => {
      throw new Error("not asked here");
    };
    const account: SettingsAccountReader = {
      d1Databases: refuse,
      zone: refuse,
      vaultSecret: refuse,
      storeEntry: refuse,
      appRows: refuse,
      vaultSecretField: refuse,
      accountToken: refuse,
      r2BucketLock: async () => "unlocked",
    };
    const findings = await audit().settings?.account?.({
      project: "acme",
      worker: "api",
      workerDirectory: "api",
      environments: [{ name: "prod", origin: null }],
      account,
    });
    expect(findings).toEqual([
      expect.objectContaining({ setting: "AUDIT_CHECKPOINTS object lock", environment: "prod" }),
    ]);
  });

  test("contributes the audit table to the app database on the DB binding by default", () => {
    const db = audit().databases?.app;
    expect(db?.binding).toBe("DB");
    expect(Object.keys(db?.tables ?? {})).toEqual(["pithyAuditEvents", "pithyAuditSinks"]);
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
    expect(cap.requiredBindings.map((b) => b.name)).toEqual(["ANALYTICS", "AUDIT_CHECKPOINTS", "AUDIT_CHECKPOINT"]);
  });

  test("binds the checkpoint bucket, optionally, so an unprovisioned Worker still records (#822)", () => {
    expect(audit().requiredBindings.find((b) => b.name === "AUDIT_CHECKPOINTS")).toMatchObject({
      type: "r2",
      optional: true,
    });
  });

  test("ships its migrations in order, at its declared order", () => {
    // Asserted as a list rather than a count. `0001` was the whole schema until the first publish; after
    // it the chain is append-only: `0002` is the actor kind (#721), `0003` the call index (#812), and `0004` the
    // request index a credential's reach joins on (#828), and `0005` the hash chain (#822).
    const db = audit().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual([
      "0001_init",
      "0002_actor_kind",
      "0003_call_index",
      "0004_request_index",
      "0005_chain",
      "0006_sinks",
    ]);
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
    expect(audit().adminRoutes?.map((route) => route.path)).toEqual([
      "/audit/events",
      "/audit/control-plane/access-history",
      "/audit/control-plane/reach",
      "/audit/control-plane/usage",
      "/audit/control-plane/verify",
      "/audit/control-plane/export",
      "/audit/events/:eventId",
    ]);
    expect(audit({ basePath: "/trail" }).adminRoutes?.map((route) => route.path)).toEqual([
      "/trail/events",
      "/trail/control-plane/access-history",
      "/trail/control-plane/reach",
      "/trail/control-plane/usage",
      "/trail/control-plane/verify",
      "/trail/control-plane/export",
      "/trail/events/:eventId",
    ]);
  });

  test("every advertised route is a read, and only the full event needs the detail scope", () => {
    // The trail is append-only, and the two scopes are what stops a credential issued to render a
    // recent-activity pane from also resolving every client IP in the project. The access history rides
    // the listing scope (#831): it reads named metadata keys and never an IP or a user-agent. Reach rides
    // it too (#828): it discloses no IP, user-agent or capability metadata. So does usage (#812): it counts
    // calls and discloses no IP, user-agent or capability metadata. The chain's verify and export need their own
    // scope (#822): an export is the trail in bulk.
    const routes = audit().adminRoutes ?? [];
    expect(routes.map((route) => [route.method, route.path, route.scope])).toEqual([
      ["GET", "/audit/events", AUDIT_TRAIL_READ_SCOPE],
      ["GET", "/audit/control-plane/access-history", AUDIT_TRAIL_READ_SCOPE],
      ["GET", "/audit/control-plane/reach", AUDIT_TRAIL_READ_SCOPE],
      ["GET", "/audit/control-plane/usage", AUDIT_TRAIL_READ_SCOPE],
      ["GET", "/audit/control-plane/verify", AUDIT_CHAIN_EXPORT_SCOPE],
      ["GET", "/audit/control-plane/export", AUDIT_CHAIN_EXPORT_SCOPE],
      ["GET", "/audit/events/:eventId", AUDIT_EVENT_DETAIL_READ_SCOPE],
    ]);
  });

  test("is discoverable via isAuditCapability and rejects other capabilities", () => {
    expect(isAuditCapability(audit())).toBe(true);
    const other = { name: "email", requiredBindings: [] } as Capability;
    expect(isAuditCapability(other)).toBe(false);
  });
});
