// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineSecretTable } from "./defineSecretTable";
import { secretTableMigration } from "./migration";
import {
  appliedSecretTables,
  diffSecretTable,
  nextMigrationName,
  renderMigrationIndex,
  renderSecretTableMigration,
} from "./plan";

const declare = (keys: string[], secrets: string[]) =>
  defineSecretTable({
    name: "customer",
    keys: Object.fromEntries(keys.map((key) => [key, z.string().describe(`The ${key}.`)])),
    secrets: Object.fromEntries(secrets.map((secret) => [secret, { valueType: "text" as const, rotatable: true }])),
  });

const CREATE = secretTableMigration({
  from: null,
  to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] },
});

describe("appliedSecretTables", () => {
  test("folds each table's steps in key order, ignoring migrations that carry none", () => {
    const plain: Migration = { up: async () => {} };
    const alter = secretTableMigration({
      from: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] },
      to: { table: "customer", keys: ["userId", "organizationId", "teamId"], secrets: ["STRIPE_KEY"] },
    });
    const applied = appliedSecretTables({
      "0002_customer_team_id": alter,
      "0001_customer_init": CREATE,
      "0000_x": plain,
    });
    expect(applied.get("customer")).toEqual({
      table: "customer",
      keys: ["userId", "organizationId", "teamId"],
      secrets: ["STRIPE_KEY"],
    });
  });
});

describe("diffSecretTable", () => {
  test("a table the chain has never seen is a create", () => {
    expect(diffSecretTable(declare(["userId", "organizationId"], ["STRIPE_KEY"]), undefined)).toEqual({
      kind: "create",
      table: "customer",
      step: { from: null, to: { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] } },
      addedKeys: ["userId", "organizationId"],
      addedSecrets: ["STRIPE_KEY"],
      removedSecrets: [],
    });
  });

  test("a declaration matching the chain is unchanged, whatever order it lists its keys and names in", () => {
    const applied = { table: "customer", keys: ["userId", "organizationId"], secrets: ["A", "B"] };
    expect(diffSecretTable(declare(["organizationId", "userId"], ["B", "A"]), applied)).toEqual({
      kind: "unchanged",
      table: "customer",
    });
  });

  test("a gained key or secret is an alter that appends, keeping the applied order", () => {
    const applied = { table: "customer", keys: ["userId", "organizationId"], secrets: ["STRIPE_KEY"] };
    const diff = diffSecretTable(declare(["teamId", "userId", "organizationId"], ["STRIPE_KEY", "API"]), applied);
    expect(diff).toEqual({
      kind: "alter",
      table: "customer",
      step: {
        from: applied,
        to: { table: "customer", keys: ["userId", "organizationId", "teamId"], secrets: ["STRIPE_KEY", "API"] },
      },
      addedKeys: ["teamId"],
      addedSecrets: ["API"],
      removedSecrets: [],
    });
  });

  test("a dropped secret name is an alter of the registration alone", () => {
    const applied = { table: "customer", keys: ["userId"], secrets: ["A", "B"] };
    const diff = diffSecretTable(declare(["userId"], ["A"]), applied);
    expect(diff).toMatchObject({ kind: "alter", addedKeys: [], addedSecrets: [], removedSecrets: ["B"] });
  });

  test("a removed key is refused by name, and a rename reads as one", () => {
    const applied = { table: "customer", keys: ["userId", "organizationId"], secrets: ["A"] };
    const removed = diffSecretTable(declare(["userId"], ["A"]), applied);
    expect(removed).toEqual({ kind: "refused", table: "customer", removedKeys: ["organizationId"] });
    const renamed = diffSecretTable(declare(["userId", "orgId"], ["A"]), applied);
    expect(renamed).toEqual({ kind: "refused", table: "customer", removedKeys: ["organizationId"] });
  });
});

describe("nextMigrationName", () => {
  test("numbers after the highest file and names the change", () => {
    const create = diffSecretTable(declare(["userId"], ["A"]), undefined);
    expect(nextMigrationName(["index.ts"], create)).toBe("0001_customer_init");
    const alter = diffSecretTable(declare(["userId", "teamId"], ["A"]), {
      table: "customer",
      keys: ["userId"],
      secrets: ["A"],
    });
    expect(nextMigrationName(["0001_customer_init.ts", "0006_by_hand.ts", "index.ts"], alter)).toBe(
      "0007_customer_team_id",
    );
    const secrets = diffSecretTable(declare(["userId"], ["A", "B"]), {
      table: "customer",
      keys: ["userId"],
      secrets: ["A"],
    });
    expect(nextMigrationName(["0001_customer_init.ts"], secrets)).toBe("0002_customer_secrets");
  });

  test("refuses an unchanged or refused diff — there is nothing to name", () => {
    expect(() => nextMigrationName([], { kind: "unchanged", table: "customer" })).toThrow(InternalError);
  });
});

describe("renderSecretTableMigration", () => {
  test("writes an ordinary migration whose step is the diff's, in the brand's voice", () => {
    const diff = diffSecretTable(declare(["userId", "organizationId"], ["STRIPE_KEY"]), undefined);
    const source = renderSecretTableMigration(diff);
    expect(source).toContain('import { secretTableMigration } from "@pithy-sh/secrets/src/tables/migration";');
    expect(source).toContain("export default secretTableMigration(");
    expect(source).toContain('"userId", "organizationId"');
    expect(source).not.toMatch(/successfully/i);
    expect(source).toContain(
      'export default secretTableMigration({\n  from: null,\n  to: {\n    table: "customer",\n    keys: ["userId", "organizationId"],\n    secrets: ["STRIPE_KEY"],\n  },\n});\n',
    );
  });
});

describe("renderMigrationIndex", () => {
  test("imports every migration file beside it, in order, under its key", () => {
    const source = renderMigrationIndex(["0002_customer_team_id.ts", "index.ts", "0001_customer_init.ts", "notes.md"]);
    expect(source).toContain('import m0001CustomerInit from "./0001_customer_init";');
    expect(source).toContain('import m0002CustomerTeamId from "./0002_customer_team_id";');
    expect(source).toContain('"0001_customer_init": m0001CustomerInit,');
    expect(source.indexOf("0001_customer_init")).toBeLessThan(source.indexOf("0002_customer_team_id"));
    expect(source).toContain("export const secretTableMigrations");
    expect(source).not.toContain("notes");
  });

  test("an empty directory exports an empty set", () => {
    expect(renderMigrationIndex([])).toContain("export const secretTableMigrations = {};");
  });

  test("an alter renders both plans, and a long list breaks one name per line", () => {
    const many = Array.from({ length: 12 }, (_, index) => `A_VERY_LONG_SECRET_NAME_${index}`);
    const diff = diffSecretTable(declare(["userId", "teamId"], many), {
      table: "customer",
      keys: ["userId"],
      secrets: [],
    });
    const source = renderSecretTableMigration(diff);
    expect(source).toContain('  from: {\n    table: "customer",\n    keys: ["userId"],\n    secrets: [],\n  },');
    expect(source).toContain('    secrets: [\n      "A_VERY_LONG_SECRET_NAME_0",\n');
    for (const line of source.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
  });
});
