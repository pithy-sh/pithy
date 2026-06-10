import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { createMigrationRegistry } from "./registry";

const noop: Migration = { up: async () => {}, down: async () => {} };

/** Mimic Kysely's default migration ordering (nameComparator = localeCompare). */
function kyselyOrder(keys: string[]): string[] {
  return [...keys].sort((a, b) => a.localeCompare(b));
}

describe("createMigrationRegistry", () => {
  test("composes globally-ordered keys — core before app, as Kysely sorts them", async () => {
    const provider = createMigrationRegistry([
      { namespace: "app", order: 1000, migrations: { "0001_init": noop } },
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { namespace: "auth", order: 100, migrations: { "0001_init": noop, "0002_sessions": noop } },
    ]);
    const keys = Object.keys(await provider.getMigrations());
    expect(kyselyOrder(keys)).toEqual([
      "0000_core_0001_init",
      "0100_auth_0001_init",
      "0100_auth_0002_sessions",
      "1000_app_0001_init",
    ]);
  });

  test("keys are stable regardless of input array order", async () => {
    const a = createMigrationRegistry([
      { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
    ]);
    const b = createMigrationRegistry([
      { namespace: "core", order: 0, migrations: { "0001_init": noop } },
      { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
    ]);
    expect(kyselyOrder(Object.keys(await a.getMigrations()))).toEqual(
      kyselyOrder(Object.keys(await b.getMigrations())),
    );
  });

  test("throws on duplicate order", () => {
    expect(() =>
      createMigrationRegistry([
        { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { namespace: "billing", order: 100, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate migration order/i);
  });

  test("throws on duplicate namespace", () => {
    expect(() =>
      createMigrationRegistry([
        { namespace: "auth", order: 100, migrations: { "0001_init": noop } },
        { namespace: "auth", order: 200, migrations: { "0001_init": noop } },
      ]),
    ).toThrow(/duplicate namespace/i);
  });

  test("throws on out-of-range or non-integer order (would break the 4-digit key sort)", () => {
    expect(() => createMigrationRegistry([{ namespace: "x", order: 10000, migrations: {} }])).toThrow(/order/i);
    expect(() => createMigrationRegistry([{ namespace: "y", order: -1, migrations: {} }])).toThrow(/order/i);
    expect(() => createMigrationRegistry([{ namespace: "z", order: 1.5, migrations: {} }])).toThrow(/order/i);
  });

  test("returns an empty provider for no sets", async () => {
    const provider = createMigrationRegistry([]);
    expect(await provider.getMigrations()).toEqual({});
  });

  test("rejects a malformed namespace", () => {
    for (const ns of ["Auth", "auth_users", "1auth", "auth-x", ""]) {
      expect(() => createMigrationRegistry([{ namespace: ns, order: 0, migrations: {} }])).toThrow(/namespace/i);
    }
  });

  test("rejects a malformed local key (unpadded / wrong charset)", () => {
    for (const key of ["1_init", "0001_Init", "0001-init", "init", "001_x"]) {
      expect(() => createMigrationRegistry([{ namespace: "auth", order: 0, migrations: { [key]: noop } }])).toThrow(
        /key/i,
      );
    }
  });

  test("appending a migration keeps prior keys byte-identical (stability)", async () => {
    const before = createMigrationRegistry([{ namespace: "auth", order: 100, migrations: { "0001_init": noop } }]);
    const after = createMigrationRegistry([
      { namespace: "auth", order: 100, migrations: { "0001_init": noop, "0002_sessions": noop } },
    ]);
    expect(Object.keys(await before.getMigrations())).toEqual(["0100_auth_0001_init"]);
    expect(Object.keys(await after.getMigrations())).toEqual(["0100_auth_0001_init", "0100_auth_0002_sessions"]);
  });
});
