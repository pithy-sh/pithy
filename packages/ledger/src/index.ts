// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add ledger` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the `openLedger` primitive other
 * capabilities call in-process, and the read shapes an app renders. Every other module is by deep path
 * (`@pithy-sh/ledger/src/...`); this is the documented contract, not a barrel over the package.
 */

export {
  isLedgerCapability,
  LEDGER_MIGRATION_ORDER,
  type LedgerCapability,
  type LedgerOptions,
  ledger,
} from "./capability";
export { LedgerConfig, type LedgerConfigInput, LedgerCurrency, resolveCurrency } from "./config/config";
export type { Balance } from "./data/account";
export { LedgerAccount } from "./data/account";
export { LedgerHold } from "./data/hold";
export { LedgerTransaction, TransactionKind } from "./data/transaction";
export { type Ledger, openLedger } from "./ledger";
