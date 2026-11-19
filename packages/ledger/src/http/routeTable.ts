// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ScopeGate } from "@pithy-sh/core/src/capability/capability";
import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import type { LedgerConfig } from "../config/config";
import { ledgerAdminRoutes } from "./scopes";

/** Where the ledger routes mount when no `basePath` is given. */
export const LEDGER_DEFAULT_BASE_PATH = "/ledger";

/**
 * Every route `registerLedgerRoutes` mounts under `base`: the management surface, then a caller's balances.
 */
export function ledgerRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(ledgerAdminRoutes(base)),
    ...declareRoutes(base, [
      ["GET", "/:currency/transactions"],
      ["GET", "/:currency"],
      ["POST", "/:currency/credit"],
      ["POST", "/:currency/debit"],
    ]),
  ];
}

/**
 * The routes `registerLedgerRoutes` gates on an `AuthContext` scope: a credit and a debit from the adopter's own
 * backend. `routeContract.test.ts` holds it to the routes' own specs.
 */
export function ledgerScopeGates(base: string, config: LedgerConfig): ScopeGate[] {
  return [
    { scope: config.adminScope, route: `POST ${base}/:currency/credit` },
    { scope: config.adminScope, route: `POST ${base}/:currency/debit` },
  ];
}
