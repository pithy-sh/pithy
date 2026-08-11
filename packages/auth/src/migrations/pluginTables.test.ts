// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { authPluginPlan, pluginMigrationKey, pluginSchemaDelta } from "./pluginTables";

describe("pluginSchemaDelta()", () => {
  test("organization → its three tables, and the session column it puts the active org in", () => {
    const delta = pluginSchemaDelta(organization());

    expect(delta.tables.map((table) => table.name)).toEqual(["organization", "member", "invitation"]);
    // The half a create-table-only reading misses: the plugin also widens a table the kit already owns,
    // and `setActive` writes to it on the first call.
    expect(delta.columns).toEqual([
      { table: "pithyAuthSessions", name: "activeOrganizationId", type: "text", notNull: false, index: false },
    ]);
  });

  test("organization's `organization` table carries id, the declared columns, and its unique slug", () => {
    const [table] = pluginSchemaDelta(organization()).tables;

    expect(table?.columns).toEqual([
      { name: "id", type: "text", notNull: true, primaryKey: true, unique: false, index: false },
      { name: "name", type: "text", notNull: true, primaryKey: false, unique: false, index: false },
      { name: "slug", type: "text", notNull: true, primaryKey: false, unique: true, index: true },
      { name: "logo", type: "text", notNull: false, primaryKey: false, unique: false, index: false },
      { name: "createdAt", type: "text", notNull: true, primaryKey: false, unique: false, index: false },
      { name: "metadata", type: "text", notNull: false, primaryKey: false, unique: false, index: false },
    ]);
  });

  test("a boolean field is integer and a date field is text — the storage the kit's own tables use", () => {
    const delta = pluginSchemaDelta(admin());
    const byName = new Map(delta.columns.map((column) => [column.name, column]));

    // `admin` widens the user and session tables rather than adding any of its own.
    expect(delta.tables).toEqual([]);
    expect(byName.get("banned")?.type).toBe("integer");
    expect(byName.get("banExpires")?.type).toBe("text");
    expect(byName.get("impersonatedBy")?.table).toBe("pithyAuthSessions");
  });

  test("a column added to an existing table is never NOT NULL — SQLite cannot add one to a table with rows", () => {
    for (const column of pluginSchemaDelta(admin()).columns) expect(column.notNull).toBe(false);
  });

  test("the kit's own four contribute nothing — the baseline is subtracted, not the empty schema", () => {
    // A plugin that declares no schema of its own leaves the diff empty; if the baseline were wrong,
    // every plugin would claim `pithy_auth_users` and every table beside it.
    const inert: BetterAuthPlugin = { id: "inert" };
    expect(pluginSchemaDelta(inert)).toEqual({ tables: [], columns: [] });
  });
});

describe("pluginMigrationKey()", () => {
  test.each([
    ["organization", "0002_plugin_organization"],
    ["two-factor", "0002_plugin_two_factor"],
    ["api-key", "0002_plugin_api_key"],
  ])("%s → %s", (id, key) => {
    expect(pluginMigrationKey(id)).toBe(key);
    // The key format `createMigrationRegistry` enforces; a key it rejects fails the whole project.
    expect(key).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});

describe("authPluginPlan()", () => {
  test("no plugins → no migrations, so a project that adds none has an unchanged ledger", () => {
    expect(authPluginPlan([])).toEqual({ migrations: {}, extensions: [] });
  });

  test("one migration per plugin that has a schema, keyed by its id", () => {
    expect(Object.keys(authPluginPlan([organization(), admin()]).migrations)).toEqual([
      "0002_plugin_organization",
      "0002_plugin_admin",
    ]);
  });

  test("a plugin with no schema of its own contributes no migration", () => {
    expect(authPluginPlan([{ id: "inert" }]).migrations).toEqual({});
  });

  test("two plugins claiming the same table are refused, naming the table and both plugins", () => {
    const first: BetterAuthPlugin = { id: "first", schema: { widget: { fields: { label: { type: "string" } } } } };
    const second: BetterAuthPlugin = { id: "second", schema: { widget: { fields: { label: { type: "string" } } } } };

    expect(() => authPluginPlan([first, second])).toThrow(PithyError);
    expect(() => authPluginPlan([first, second])).toThrow(/widget/);
    expect(() => authPluginPlan([first, second])).toThrow(/second/);
  });

  test("a plugin claiming a table the kit already owns is refused, naming it", () => {
    const squatter: BetterAuthPlugin = {
      id: "squatter",
      schema: { pithyAuthDevices: { fields: { label: { type: "string" } } } },
    };
    expect(() => authPluginPlan([squatter])).toThrow(/pithyAuthDevices/);
  });
});
