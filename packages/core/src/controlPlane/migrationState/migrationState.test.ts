// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import { HealthSummaryKey } from "../discovery/healthSummary";
import { MIGRATIONS_READ_SCOPE } from "../scope/scope";
import { composeMigrationDatabases, MIGRATION_HEALTH_KEYS, migrationView } from "./migrationState";

const noop: Migration = { up: async () => {}, down: async () => {} };

const audit = defineCapability({
  name: "audit",
  requiredBindings: [],
  databases: { app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 250 } },
});

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  databases: {
    app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 1000 },
    analytics: { binding: "ANALYTICS", tables: {}, migrations: { "0001_events": noop }, migrationOrder: 0 },
  },
});

/** A capability that declares tables in a database and ships no migrations for it. */
const reader = defineCapability({
  name: "reader",
  requiredBindings: [],
  databases: { reports: { binding: "REPORTS_DB", tables: {} } },
});

describe("composeMigrationDatabases", () => {
  test("one entry per database this Worker binds, each with the binding it is read through", () => {
    const composed = composeMigrationDatabases([audit, app]);
    expect(composed.map(({ database, binding }) => ({ database, binding }))).toEqual([
      { database: "analytics", binding: "ANALYTICS" },
      { database: "app", binding: "DB" },
    ]);
  });

  test("composes the provider through the same registry the CLI migrates with", async () => {
    const app_ = composeMigrationDatabases([audit, app]).find((entry) => entry.database === "app");
    expect(Object.keys((await app_?.provider.getMigrations()) ?? {})).toEqual([
      "0250_audit_0001_init",
      "1000_app_0001_init",
    ]);
  });

  test("knows each declared migration's namespace from the set it came from", () => {
    const app_ = composeMigrationDatabases([audit, app]).find((entry) => entry.database === "app");
    expect(app_?.namespaces.get("0250_audit_0001_init")).toBe("audit");
    expect(app_?.namespaces.get("1000_app_0001_init")).toBe("app");
  });

  test("a database bound with no migrations is still reported, with nothing declared", async () => {
    // Bound and unmigrated is a fact about the environment. Leaving it out would read as not bound.
    const reports = composeMigrationDatabases([reader]).find((entry) => entry.database === "reports");
    expect(reports?.binding).toBe("REPORTS_DB");
    expect(await reports?.provider.getMigrations()).toEqual({});
  });

  test("no capabilities, no databases", () => {
    expect(composeMigrationDatabases([])).toEqual([]);
  });
});

describe("migrationView", () => {
  test("names a declared migration's namespace from the set it came from", () => {
    expect(migrationView("1000_app_0001_init", new Map([["1000_app_0001_init", "app"]]))).toEqual({
      name: "1000_app_0001_init",
      namespace: "app",
    });
  });

  test("takes an undeclared migration's namespace from its key, the only source there is", () => {
    expect(migrationView("0400_vault_0001_init", new Map())).toEqual({
      name: "0400_vault_0001_init",
      namespace: "vault",
    });
  });

  test("answers null for a key no registry composed, rather than guessing one", () => {
    expect(migrationView("20260101_init", new Map())).toEqual({ name: "20260101_init", namespace: null });
  });
});

describe("MIGRATION_HEALTH_KEYS", () => {
  test("pendingMigrations grades at most zero, and undeclaredMigrations grades nothing", () => {
    // Undeclared is relative to this Worker: a database shared with another Worker lists that Worker's
    // migrations there, so a bound of zero would report a corrupted chain on a database that is fine.
    const keys = MIGRATION_HEALTH_KEYS.map((key) => HealthSummaryKey.parse(key));
    expect(keys.map((key) => [key.key, key.kind, key.scope, key.cost, key.nominal])).toEqual([
      ["pendingMigrations", "count", MIGRATIONS_READ_SCOPE, "indexed", { atMost: 0 }],
      ["undeclaredMigrations", "count", MIGRATIONS_READ_SCOPE, "indexed", null],
    ]);
  });

  test("the undeclared key's summary says it is relative to this Worker", () => {
    const undeclared = MIGRATION_HEALTH_KEYS.find((key) => key.key === "undeclaredMigrations");
    expect(undeclared?.summary).toMatch(/this Worker/);
  });
});
