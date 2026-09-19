// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsLedgerPeer } from "../grants/ledgerSeam";

/**
 * **The reconcile host's composition: the optional peers it was handed** (#645).
 *
 * An app Worker composes capabilities and `payments()`'s `compose` hook finds the ledger among them. This host
 * composes nothing — it is a prebuilt Worker the adopter never authors — so it has no hook and nothing to find
 * a ledger in. It still owes a credit when a pass repairs a purchase whose product has a `grants.ledger`
 * clause, and it may not import `@pithy-sh/ledger` to make one, for the reason `grants/ledgerSeam.ts` gives.
 *
 * So `pithy` hands it over. When the project's catalog credits a balance, the CLI deploys this host from an
 * entry it generates beside the resolved config, which imports the ledger's `ledgerPeer` from the project's
 * own install and calls {@link providePeers} before re-exporting `worker.ts` unchanged. A catalog that credits
 * nothing gets no entry: `main` stays `worker.ts`, and the bundle never meets the specifier.
 *
 * Its own module rather than an export of `worker.ts`, because every export of a Worker's main module is read
 * as an entrypoint, and a function is not one.
 */

/** What this host may be handed, keyed by the capability that supplies it. */
export interface PaymentsHostPeers {
  /** `ledger()`'s peer surface, when the catalog credits a balance. */
  readonly ledger?: PaymentsLedgerPeer;
}

/**
 * The peers this host was handed — empty when its entry handed none.
 *
 * A value rather than a getter, and read as a property inside a Workflow's `run`: it is set once, by the entry,
 * before the isolate serves anything, so every replay of a run reads the same thing — which is what
 * `workflowDeterminism.test.ts` holds every driver body to.
 */
export const hostPeers: { -readonly [Key in keyof PaymentsHostPeers]: PaymentsHostPeers[Key] } = {};

/** Hand this host its peers. Called once, by the generated entry, before any request or cron fire. */
export function providePeers(peers: PaymentsHostPeers): void {
  Object.assign(hostPeers, peers);
}
