// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { beforeEachMigration } from "./retained";
import { declareRetainedDown, retainedTablesOfDown } from "./retainedDeclaration";

/** A provider over `migrations`, as a registry would yield it. */
function providerOf(migrations: Record<string, Migration>): MigrationProvider {
  return { getMigrations: async () => migrations };
}

/** Kysely is never touched here: the bodies record that they ran, and nothing else. */
const db = {} as Kysely<unknown>;

describe("beforeEachMigration", () => {
  test("the hook hears each migration's name and direction before its body runs", async () => {
    const heard: string[] = [];
    const wrapped = beforeEachMigration(
      providerOf({
        "0001_one": {
          up: async () => void heard.push("up body"),
          down: async () => void heard.push("down body"),
        },
      }),
      async (name, direction) => void heard.push(`${direction} ${name}`),
    );

    const migration = (await wrapped.getMigrations())["0001_one"] as Migration;
    await migration.up(db);
    await migration.down?.(db);

    expect(heard).toEqual(["Up 0001_one", "up body", "Down 0001_one", "down body"]);
  });

  test("a throw from the hook means the body never runs", async () => {
    let ran = false;
    const up = async (): Promise<void> => {
      ran = true;
    };
    const wrapped = beforeEachMigration(providerOf({ "0001_one": { up } }), async () => {
      throw new Error("planted");
    });

    const migration = (await wrapped.getMigrations())["0001_one"] as Migration;
    await expect(migration.up(db)).rejects.toThrow("planted");
    expect(ran).toBe(false);
  });

  /**
   * **The reason this lives beside the retained guard and not in the CLI.** A `down` wrapped in a new
   * function is a function the retained declaration has never heard of, and `guardRetained` handed it would
   * find nothing declared and let the vault's `down` through (#588).
   */
  test("a wrapped down keeps the retained declaration of the one it wraps", async () => {
    const down = async (): Promise<void> => {};
    declareRetainedDown(down, ["pithySecretsSystemSecrets"]);
    const wrapped = beforeEachMigration(providerOf({ "0001_vault": { up: async () => {}, down } }), async () => {});

    const migration = (await wrapped.getMigrations())["0001_vault"] as Migration;
    expect(migration.down).not.toBe(down);
    expect(retainedTablesOfDown(migration.down as object)).toEqual(["pithySecretsSystemSecrets"]);
  });

  test("a migration with no down gains none", async () => {
    const wrapped = beforeEachMigration(providerOf({ "0001_one": { up: async () => {} } }), async () => {});
    expect((await wrapped.getMigrations())["0001_one"]?.down).toBeUndefined();
  });
});
