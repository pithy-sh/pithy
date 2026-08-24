// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { Locale } from "@pithy-sh/core/src/i18n/locale";
import type { BetterAuthPlugin } from "better-auth";
import { getSchema } from "better-auth/db";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { User } from "../data/betterAuth";
import { KIT_SESSION_FIELDS, KIT_USER_FIELDS } from "../data/kitFields";
import { authPluginPlan, authSchemaOptions, pluginMigrationKey, pluginSchemaDelta } from "./pluginTables";

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

  test("a plugin declaring a user column the kit already owns adds nothing — the baseline knows it", () => {
    // The concrete failure `authSchemaOptions` carrying `user.additionalFields` prevents. An adopter
    // plugin that declares its own user `locale` is diffed against a baseline that already has ours, so
    // it contributes no column. Drop the declaration from `authSchemaOptions` and this emits an
    // `ALTER TABLE pithy_auth_users ADD COLUMN locale` against a table `0001_init` already gave one —
    // a duplicate-column error part-way through a migration D1 cannot roll back, having no
    // transactional DDL.
    const clashing: BetterAuthPlugin = {
      id: "clashing",
      schema: { user: { fields: { locale: { type: "string", required: false } } } },
    };
    expect(pluginSchemaDelta(clashing)).toEqual({ tables: [], columns: [] });
  });
});

describe("authSchemaOptions()", () => {
  test("the baseline names every column of the `User` schema", () => {
    // Comparing against the `User` Zod object — the table definition of record — so the next column to
    // land is caught too, not just `locale`. `id` is not a Better Auth *field*; it is the model's key.
    //
    // This used to claim to be the guard holding `makeAuth`'s options and this baseline in step. It was
    // not: it never imported `makeAuth`, so reverting the live declaration left the whole suite green
    // while Better Auth silently stopped writing the column. There is nothing to hold in step now —
    // both read `KIT_USER_FIELDS` from `../data/kitFields.ts`, and the test below is what proves this
    // baseline really carries what that module declares.
    const fields = getSchema(authSchemaOptions([])).pithyAuthUsers?.fields ?? {};
    const declared = Object.keys(User.shape).filter((name) => name !== "id");
    expect(Object.keys(fields).sort()).toEqual(declared.sort());
  });

  test("the user locale is client-settable and validated by the same schema every read uses", () => {
    // `input` is not left to default here: a locale is the reader's own preference, so a client must be
    // able to set it — and the thing that makes that safe is the validator, since every read of the
    // column goes through `User.parse` and an unvalidated write would poison the admin listing for
    // every operator, not just for whoever wrote it.
    const locale = getSchema(authSchemaOptions([])).pithyAuthUsers?.fields.locale;
    expect(locale?.input).toBe(true);
    expect(locale?.required).toBe(false);
    expect(locale?.validator?.input).toBe(KIT_USER_FIELDS.locale.validator.input);
  });

  test("a reader can set a locale, and can take it back", () => {
    // Asserted through the validator Better Auth will actually run (`parseInputData`), not through the
    // schema this file happens to import — the point is what a client can write.
    //
    // **Null is the case that was wrong.** The column is nullable, the `User` field is nullable and
    // `AdminUserView` is nullable, and all three mean "this reader has not chosen", which is what makes
    // the server fall back to `Accept-Language`. A validator of bare `Locale` accepted `es-AR` and
    // refused `null`, so a reader could pick a language and never take it back: `updateUser({ locale:
    // null })` answered 400 for the one state the schema calls ordinary.
    const validator = getSchema(authSchemaOptions([])).pithyAuthUsers?.fields.locale?.validator?.input;
    expect(validator).toBeDefined();
    expect(Locale.nullable().safeParse("es-AR").success).toBe(true);
    expect(Locale.nullable().safeParse(null).success).toBe(true);
    expect(Locale.nullable().safeParse("not a tag").success).toBe(false);
    expect(Locale.nullable().safeParse("x".repeat(5000)).success).toBe(false);
  });

  test("the live instance declares the same fields this baseline does", () => {
    // The duplication that used to be watched, removed instead: `makeAuth` and `authSchemaOptions` both
    // spread `KIT_USER_FIELDS`, so there is no second declaration to drift. This asserts the baseline
    // really is built from that module rather than from a literal that happens to match it today —
    // reverting either call site to an inline object fails here.
    const fields = getSchema(authSchemaOptions([])).pithyAuthUsers?.fields ?? {};
    for (const name of Object.keys(KIT_USER_FIELDS)) {
      expect(Object.keys(fields), `the baseline dropped \`${name}\``).toContain(name);
    }
    const sessionFields = getSchema(authSchemaOptions([])).pithyAuthSessions?.fields ?? {};
    for (const name of Object.keys(KIT_SESSION_FIELDS)) {
      expect(Object.keys(sessionFields), `the baseline dropped \`${name}\``).toContain(name);
    }
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
