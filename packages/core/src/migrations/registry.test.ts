// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { createMigrationRegistry } from "./registry";

const noop: Migration = { up: async () => {}, down: async () => {} };

/** Mimic Kysely's default migration ordering (nameComparator = localeCompare). */
function kyselyOrder(keys: string[]): string[] {
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** The provider for a database name, asserting it was registered (narrows the indexed access). */
function providerFor(registry: Record<string, MigrationProvider>, database: string): MigrationProvider {
  const provider = registry[database];
  if (!provider) throw new Error(`expected a provider for database "${database}"`);
  return provider;
}

describe("createMigrationRegistry", () => {
  test("returns one ordered provider per database, keyed by database name", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
      { database: "analytics", namespace: "events", order: 0, migrations: { "0001_init": noop } },
    ]);
    expect(Object.keys(registry).sort()).toEqual(["analytics", "app"]);
    expect(kyselyOrder(Object.keys(await providerFor(registry, "app").getMigrations()))).toEqual([
      "0000_core_0001_init",
      "0100_auth_0001_init",
    ]);
    expect(Object.keys(await providerFor(registry, "analytics").getMigrations())).toEqual(["0000_events_0001_init"]);
  });

  test("within a database, composes globally-ordered keys — core before app, as Kysely sorts them", async () => {
    const registry = createMigrationRegistry([
      { database: "app", namespace: "app", order: 1000, migrations: { "0001_init": noop } },
      { database: "app", namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop, "0002_sessions": noop } },
    ]);
    const keys = Object.keys(await providerFor(registry, "app").getMigrations());
    expect(kyselyOrder(keys)).toEqual([
      "0000_core_0001_init",
      "0100_auth_0001_init",
      "0100_auth_0002_sessions",
      "1000_app_0001_init",
    ]);
  });

  test("keys are stable regardless of input array order", async () => {
    const a = createMigrationRegistry([
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
      { database: "app", namespace: "core", order: 0, migrations: { "0001_init": noop } },
    ]);
    const b = createMigrationRegistry([
      { database: "app", namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
    ]);
    expect(kyselyOrder(Object.keys(await providerFor(a, "app").getMigrations()))).toEqual(
      kyselyOrder(Object.keys(await providerFor(b, "app").getMigrations())),
    );
  });

  test("the same order recurs across databases but collides within one", () => {
    // Same order in two different databases is fine — order is scoped per database.
    expect(() =>
      createMigrationRegistry([
        { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { database: "analytics", namespace: "events", order: 100, migrations: { "0001_init": noop } },
      ]),
    ).not.toThrow();
    // Same order twice in one database throws.
    expect(() =>
      createMigrationRegistry([
        { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { database: "app", namespace: "billing", order: 100, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate migration order/i);
  });

  test("the same namespace recurs across databases but collides within one", () => {
    // A capability with tables in two databases contributes a set per database under one namespace.
    expect(() =>
      createMigrationRegistry([
        { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { database: "analytics", namespace: "auth", order: 100, migrations: { "0001_events": noop } },
      ]),
    ).not.toThrow();
    // Same namespace twice in one database throws.
    expect(() =>
      createMigrationRegistry([
        { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { database: "app", namespace: "auth", order: 200, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate namespace/i);
  });

  test("invariant violations throw a typed PithyError (core/internal), not a plain Error", () => {
    try {
      createMigrationRegistry([{ database: "app", namespace: "BAD", order: 0, migrations: {} }]);
      throw new Error("expected createMigrationRegistry to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).payload.code).toBe("core/internal");
    }
  });

  test("throws on out-of-range or non-integer order (would break the 4-digit key sort)", () => {
    expect(() => createMigrationRegistry([{ database: "app", namespace: "x", order: 10000, migrations: {} }])).toThrow(
      /order/i,
    );
    expect(() => createMigrationRegistry([{ database: "app", namespace: "y", order: -1, migrations: {} }])).toThrow(
      /order/i,
    );
    expect(() => createMigrationRegistry([{ database: "app", namespace: "z", order: 1.5, migrations: {} }])).toThrow(
      /order/i,
    );
  });

  test("returns an empty registry for no sets", () => {
    expect(createMigrationRegistry([])).toEqual({});
  });

  test("rejects a malformed namespace", () => {
    for (const ns of ["Auth", "auth_users", "1auth", "auth-x", ""]) {
      expect(() => createMigrationRegistry([{ database: "app", namespace: ns, order: 0, migrations: {} }])).toThrow(
        /namespace/i,
      );
    }
  });

  test("rejects a malformed local key (unpadded / wrong charset)", () => {
    for (const key of ["1_init", "0001_Init", "0001-init", "init", "001_x"]) {
      expect(() =>
        createMigrationRegistry([{ database: "app", namespace: "auth", order: 0, migrations: { [key]: noop } }]),
      ).toThrow(/key/i);
    }
  });

  test("appending a migration keeps prior keys byte-identical (stability)", async () => {
    const before = createMigrationRegistry([
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop } },
    ]);
    const after = createMigrationRegistry([
      { database: "app", namespace: "auth", order: 100, migrations: { "0001_init": noop, "0002_sessions": noop } },
    ]);
    expect(Object.keys(await providerFor(before, "app").getMigrations())).toEqual(["0100_auth_0001_init"]);
    expect(Object.keys(await providerFor(after, "app").getMigrations())).toEqual([
      "0100_auth_0001_init",
      "0100_auth_0002_sessions",
    ]);
  });
});
