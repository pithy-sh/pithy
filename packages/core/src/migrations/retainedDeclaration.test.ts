// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";
import { describe, expect, test, vi } from "vitest";
import { defineCapability } from "../capability/capability";
import { declareRetained, declareRetainedDown, retainedTablesOf, retainedTablesOfDown } from "./retainedDeclaration";

const migration = (): Migration => ({ up: async () => {}, down: async () => {} });

describe("retainedTablesOfDown", () => {
  test("is every table declared on that down, each once, and nothing for an undeclared one", () => {
    const down = async (): Promise<void> => {};
    declareRetainedDown(down, ["pithyVaultSecrets"]);
    declareRetainedDown(down, ["pithyVaultSecrets", "pithyVaultKeys"]);
    declareRetainedDown(down, []);
    expect(retainedTablesOfDown(down)).toEqual(["pithyVaultSecrets", "pithyVaultKeys"]);
    expect(retainedTablesOfDown(async () => {})).toEqual([]);
    expect(retainedTablesOfDown(Object.create(down))).toEqual([]);
  });

  test("a down carries no enumerable mark", () => {
    const down = async (): Promise<void> => {};
    declareRetainedDown(down, ["pithyVaultSecrets"]);
    expect(Object.keys(down)).toEqual([]);
  });

  test("a frozen down is declared too, and adds to what it holds", () => {
    const down = Object.freeze(async (): Promise<void> => {});
    declareRetainedDown(down, ["pithyVaultSecrets"]);
    declareRetainedDown(down, ["pithyVaultKeys"]);
    expect(retainedTablesOfDown(down)).toEqual(["pithyVaultSecrets", "pithyVaultKeys"]);
  });

  test("a down frozen after its first declaration keeps it and takes the next", () => {
    const down = async (): Promise<void> => {};
    declareRetainedDown(down, ["pithyVaultSecrets"]);
    Object.freeze(down);
    declareRetainedDown(down, ["pithyVaultKeys"]);
    expect(retainedTablesOfDown(down)).toEqual(["pithyVaultSecrets", "pithyVaultKeys"]);
  });
});

describe("retainedTablesOf", () => {
  test("is the sorted union over every down in a set, and skips a migration with none", () => {
    const one = migration();
    const two = migration();
    declareRetained({ "0001_one": one }, ["pithyB"]);
    declareRetained({ "0002_two": two }, ["pithyA"]);
    expect(retainedTablesOf({ "0001_one": one, "0002_two": two, "0003_up": { up: async () => {} } })).toEqual([
      "pithyA",
      "pithyB",
    ]);
  });
});

describe("two copies of core", () => {
  test("a capability one copy defines declares its retained tables to the other", async () => {
    vi.resetModules();
    const other = {
      capability: await import("../capability/capability"),
      declaration: await import("./retainedDeclaration"),
    };
    expect(other.capability.defineCapability).not.toBe(defineCapability);
    expect(other.declaration.retainedTablesOf).not.toBe(retainedTablesOf);
    const vault = other.capability.defineCapability({
      name: "vault",
      requiredBindings: [{ type: "d1", name: "DB" }],
      databases: {
        vault: {
          binding: "DB",
          tables: {},
          migrations: { "0001_init": migration() },
          migrationOrder: 1000,
          retained: ["pithyVaultSecrets"],
        },
      },
    });
    const migrations = vault.databases?.vault?.migrations ?? {};

    expect(retainedTablesOf(migrations)).toEqual(["pithyVaultSecrets"]);
  });

  test("a down one copy declares is declared to the other, and the other adds to it", async () => {
    vi.resetModules();
    const other = await import("./retainedDeclaration");
    expect(other.declareRetainedDown).not.toBe(declareRetainedDown);
    const down = async (): Promise<void> => {};
    other.declareRetainedDown(down, ["pithyVaultSecrets"]);
    declareRetainedDown(down, ["pithyVaultKeys"]);

    expect(retainedTablesOfDown(down)).toEqual(["pithyVaultSecrets", "pithyVaultKeys"]);
    expect(other.retainedTablesOfDown(down)).toEqual(["pithyVaultSecrets", "pithyVaultKeys"]);
  });
});
