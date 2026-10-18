// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { retainedTablesOf } from "@pithy-sh/core/src/migrations/retainedDeclaration";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { declaredSecretTables, SECRET_TABLES_MIGRATION_ORDER, secretTablesDatabase } from "./database";
import { defineSecretTable } from "./defineSecretTable";
import { secretTableMigration } from "./migration";

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: { userId: z.string().describe("The user."), organizationId: z.string().describe("The organization.") },
  secrets: { STRIPE_KEY: { valueType: "text", rotatable: true } },
});
const ConnectionSecrets = defineSecretTable({
  name: "connection",
  keys: { installationId: z.string().describe("The installation.") },
  secrets: { SIGNING_KEY: { valueType: "text", rotatable: true } },
});

const migrations = {
  "0001_customer_init": secretTableMigration({
    from: null,
    to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] },
  }),
};

describe("secretTablesDatabase", () => {
  test("is a SECRETS database spec carrying each table's row, its migrations, and the tables retained", () => {
    const spec = secretTablesDatabase({ tables: [CustomerSecrets, ConnectionSecrets], migrations });
    expect(spec.binding).toBe("SECRETS");
    expect(Object.keys(spec.tables)).toEqual(["pithySecretsCustomerSecrets", "pithySecretsConnectionSecrets"]);
    expect(spec.migrations).toBe(migrations);
    expect(spec.migrationOrder).toBe(SECRET_TABLES_MIGRATION_ORDER);
    expect(spec.retained).toEqual(["pithySecretsCustomerSecrets", "pithySecretsConnectionSecrets"]);
    expect(spec.secretTables).toEqual([CustomerSecrets, ConnectionSecrets]);
  });

  test("sorts after the secrets capability's own migrations, so the registry exists first", () => {
    expect(SECRET_TABLES_MIGRATION_ORDER).toBeGreaterThan(100);
  });

  test("with no migrations yet, declares the tables and nothing to run", () => {
    const spec = secretTablesDatabase({ tables: [CustomerSecrets] });
    expect(spec.migrations).toBeUndefined();
    expect(spec.retained).toBeUndefined();
  });

  test("refuses two tables of one name, and something that is not a declared table", () => {
    expect(() => secretTablesDatabase({ tables: [CustomerSecrets, CustomerSecrets] })).toThrow(InternalError);
    expect(() => secretTablesDatabase({ tables: [{ name: "customer" } as never] })).toThrow(/defineSecretTable/);
  });

  test("a capability composing it records its tables as retained on every down", () => {
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: { secrets: secretTablesDatabase({ tables: [CustomerSecrets], migrations }) },
    });
    expect(retainedTablesOf(app.databases?.secrets?.migrations ?? {})).toEqual(["pithySecretsCustomerSecrets"]);
  });
});

describe("declaredSecretTables", () => {
  test("finds every declared table across a composition, with the capability and database it came from", () => {
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        db: { binding: "DB", tables: {} },
        secrets: secretTablesDatabase({ tables: [CustomerSecrets], migrations }),
      },
    });
    const other = defineCapability({ name: "other", requiredBindings: [] });
    const found = declaredSecretTables([other, app]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ capability: "app", database: "secrets", tables: [CustomerSecrets] });
    expect(found[0]?.migrations).toBe(migrations);
  });
});
