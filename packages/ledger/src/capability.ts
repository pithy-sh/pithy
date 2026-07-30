// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { LedgerConfig, type LedgerConfigInput } from "./config/config";
import { ledgerTables } from "./data/tables";
import { registerLedgerRoutes } from "./http/routes";
import { ledger_0001_accounts } from "./migrations/0001_accounts";
import { ledgerExampleSeed } from "./seeds/example";

/**
 * Where ledger's migrations sort in the app database. Unique per database; the registry composes keys like
 * `0650_ledger_0001_accounts`. Sits after rating (600).
 *
 * Ledger was also at 600 until this was corrected — `pithy migrate` threw `duplicate migration order 600
 * in database "app"` for any project composing both. Nothing orders ledger against rating in particular;
 * rating simply kept the slot, and the two tables do not reference each other.
 */
export const LEDGER_MIGRATION_ORDER = 650;

export type LedgerOptions = LedgerConfigInput & {
  /** Mount the routes somewhere other than `/ledger`. */
  basePath?: string;
};

export interface LedgerCapability extends Capability {
  ledgerConfig: LedgerConfig;
}

/**
 * The ledger capability: a per-user balance ledger for an app's economy — chips, gold, credits, tokens.
 *
 * Fully optional. Config, migrations, routes, and bindings arrive only on `pithy add ledger`, and
 * `pithy remove ledger` is the clean inverse. The store is D1, always: the ledger's correctness — atomic
 * movements, idempotent operations, overdraft protection — is enforced by D1's own transactions and `CHECK`
 * constraints (see `ledger.ts`), which is exactly what a balance store must guarantee.
 *
 * It is currency-agnostic and takes no position on whether an app's units map to money — that, and any
 * regulation it implies, is the adopter's concern. Pithy provides the ledger; the adopter provides the
 * compliance.
 *
 * `dependsOn` is deliberately empty. Auth is a seam, not a peer: reads scope to `c.var.auth.userId` and
 * admin writes require a scope, so without `@pithy-sh/auth` every route is denied. The ledger itself is a
 * server-authoritative primitive other capabilities call in-process — `@pithy-sh/multiplayer` uses it to
 * escrow wagers and settle payouts.
 */
export function ledger(options: LedgerOptions = { currencies: [] }): LedgerCapability {
  const { basePath, ...configInput } = options;
  // Parse the currency set at assembly — a duplicate code or a bad currency fails on deploy, not on the
  // first transaction.
  const resolved = LedgerConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_accounts": ledger_0001_accounts };
  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const capability = defineCapability({
    name: "ledger",
    requiredBindings,
    config: LedgerConfig,
    databases: {
      app: {
        binding: "DB",
        tables: ledgerTables(),
        migrationOrder: LEDGER_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerLedgerRoutes({ config: resolved, basePath }),
    seeds: [ledgerExampleSeed],
  });

  return Object.assign(capability, { ledgerConfig: resolved });
}

export function isLedgerCapability(capability: Capability): capability is LedgerCapability {
  return capability.name === "ledger" && "ledgerConfig" in capability;
}
