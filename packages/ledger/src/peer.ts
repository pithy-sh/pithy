// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { openLedger } from "./ledger";

/**
 * **What a capability composed beside the ledger may call — handed to it, never imported by it** (#645).
 *
 * `@pithy-sh/ledger` is an optional peer of `payments` (a purchase that credits a balance) and of
 * `multiplayer` (a wager a game settles). Both used to reach it with `import("@pithy-sh/ledger/src/ledger")`
 * behind a `try`, which is optional at runtime and required at bundle time: wrangler's esbuild resolves a
 * literal specifier whether or not the branch holding it ever runs, so a project without the ledger could not
 * deploy them at all.
 *
 * So the arrow is reversed. `ledger()` carries this object as `ledgerPeer`, a dependent finds it among the
 * composed capabilities in its `compose` hook, and a host Worker — which composes nothing — is handed it by the
 * entry `pithy` generates when the project composes the ledger. The dependent never names this package, so a
 * project without it has nothing to resolve.
 *
 * Its own module, and deliberately small, so that generated host entry imports the primitive and nothing
 * else: `capability.ts` brings the routes, and a Workflow host needs none of them.
 */
export const ledgerPeer = { openLedger } as const;

/** The ledger's peer surface, by type — what `ledgerPeer` holds. */
export type LedgerPeer = typeof ledgerPeer;
