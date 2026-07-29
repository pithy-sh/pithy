import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { WalletConfig, type WalletConfigInput } from "./config/config";
import { walletTables } from "./data/tables";
import { registerWalletRoutes } from "./http/routes";
import { wallet_0001_ledger } from "./migrations/0001_ledger";
import { walletExampleSeed } from "./seeds/example";

/**
 * Where wallet's migrations sort in the app database. Unique per database; the registry composes keys like
 * `0650_wallet_0001_ledger`. Sits after rating (600).
 *
 * Wallet was also at 600 until this was corrected — `pithy migrate` threw `duplicate migration order 600
 * in database "app"` for any project composing both. Nothing orders wallet against rating in particular;
 * rating simply kept the slot, and the two tables do not reference each other.
 */
export const WALLET_MIGRATION_ORDER = 650;

export type WalletOptions = WalletConfigInput & {
  /** Mount the routes somewhere other than `/wallet`. */
  basePath?: string;
};

export interface WalletCapability extends Capability {
  walletConfig: WalletConfig;
}

/**
 * The wallet capability: a per-user balance ledger for an app's economy — chips, gold, credits, tokens.
 *
 * Fully optional. Config, migrations, routes, and bindings arrive only on `pithy add wallet`, and
 * `pithy remove wallet` is the clean inverse. The store is D1, always: the ledger's correctness — atomic
 * movements, idempotent operations, overdraft protection — is enforced by D1's own transactions and `CHECK`
 * constraints (see `ledger/ledger.ts`), which is exactly what a balance store must guarantee.
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
export function wallet(options: WalletOptions = { currencies: [] }): WalletCapability {
  const { basePath, ...configInput } = options;
  // Parse the currency set at assembly — a duplicate code or a bad currency fails on deploy, not on the
  // first transaction.
  const resolved = WalletConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_ledger": wallet_0001_ledger };
  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const capability = defineCapability({
    name: "wallet",
    requiredBindings,
    config: WalletConfig,
    databases: {
      app: {
        binding: "DB",
        tables: walletTables(),
        migrationOrder: WALLET_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerWalletRoutes({ config: resolved, basePath }),
    seeds: [walletExampleSeed],
  });

  return Object.assign(capability, { walletConfig: resolved });
}

export function isWalletCapability(capability: Capability): capability is WalletCapability {
  return capability.name === "wallet" && "walletConfig" in capability;
}
