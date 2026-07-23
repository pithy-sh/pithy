/**
 * The package entrypoint — the surface `pithy add wallet` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the `ledger` primitive other capabilities
 * call in-process, and the read shapes an app renders. Every other module is imported by deep path
 * (`@pithy-sh/wallet/src/...`); this is the documented contract, not a barrel over the package.
 */

export {
  isWalletCapability,
  WALLET_MIGRATION_ORDER,
  type WalletCapability,
  type WalletOptions,
  wallet,
} from "./capability";
export { resolveCurrency, WalletConfig, type WalletConfigInput, WalletCurrency } from "./config/config";
export type { Balance } from "./data/account";
export { WalletAccount } from "./data/account";
export { WalletHold } from "./data/hold";
export { TransactionKind, WalletTransaction } from "./data/transaction";
export { type Ledger, ledger } from "./ledger/ledger";
