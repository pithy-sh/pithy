// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { describe, expect, it } from "vitest";
import { isLedgerCapability, LEDGER_MIGRATION_ORDER, ledger } from "./capability";
import {
  LedgerAccountNotFoundError,
  LedgerCurrencyNotFoundError,
  LedgerHoldNotFoundError,
  LedgerHoldNotOpenError,
  LedgerInsufficientFundsError,
  LedgerInvalidAmountError,
} from "./error/errors";

const currencies = [{ code: "chips", name: "Casino Chips" }];

/**
 * The capability's identity, and the three names derived from it that outlive any refactor: the table
 * prefix, the composed migration key, and the error-code domain. CLAUDE.md requires all three to carry
 * the same `<capability>` segment, and requires the composed key to be stable forever — a rename after
 * release makes Kysely read applied migrations as unapplied and re-run them. The package was renamed
 * from `wallet` while unpublished precisely so those names could still move; these assertions are what
 * stop them moving again.
 */
describe("ledger()", () => {
  it("names itself so the migration namespace, table prefix, and error domain line up", () => {
    expect(ledger({ currencies }).name).toBe("ledger");
  });

  it("requires only the app D1 binding", () => {
    expect(ledger({ currencies }).requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  it("declares no peer capabilities — auth is a seam, not a dependency", () => {
    expect(ledger({ currencies }).dependsOn ?? []).toEqual([]);
  });

  it("prefixes every table it provides with pithy_ledger_", () => {
    const tables = Object.keys(ledger({ currencies }).databases?.app?.tables ?? {});
    expect(tables.sort()).toEqual(["pithyLedgerAccounts", "pithyLedgerHolds", "pithyLedgerTransactions"]);
    // CamelCasePlugin snake-cases each to `pithy_ledger_*`; the prefix is what keeps them out of an
    // adopter's own namespace, so every table must carry it, not just the ones a reader remembers.
    for (const table of tables) expect(table.startsWith("pithyLedger")).toBe(true);
  });

  it("ships its migration under a stable local key, at its allocated order", () => {
    const spec = ledger({ currencies }).databases?.app;
    expect(Object.keys(spec?.migrations ?? {})).toEqual(["0001_accounts"]);
    expect(spec?.migrationOrder).toBe(LEDGER_MIGRATION_ORDER);
    expect(LEDGER_MIGRATION_ORDER).toBe(650);
  });

  it("composes to 0650_ledger_0001_accounts — the applied-migration name, stable forever", async () => {
    const spec = ledger({ currencies }).databases?.app;
    const registry = createMigrationRegistry([
      {
        database: "app",
        namespace: ledger({ currencies }).name,
        order: spec?.migrationOrder ?? -1,
        migrations: spec?.migrations ?? {},
      },
    ]);
    expect(Object.keys(await (registry.app?.getMigrations() ?? Promise.resolve({})))).toEqual([
      "0650_ledger_0001_accounts",
    ]);
  });

  it("throws only ledger/* error codes", () => {
    const thrown = [
      new LedgerCurrencyNotFoundError(),
      new LedgerAccountNotFoundError(),
      new LedgerHoldNotFoundError(),
      new LedgerInsufficientFundsError(),
      new LedgerHoldNotOpenError(),
      new LedgerInvalidAmountError(),
    ];
    for (const error of thrown) expect(error.payload.code.startsWith("ledger/")).toBe(true);
  });

  it("carries its parsed config, and the guard recognizes it", () => {
    const capability = ledger({ currencies });
    expect(isLedgerCapability(capability)).toBe(true);
    expect(capability.ledgerConfig.adminScope).toBe("ledger:admin");
  });
});
