// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthPeer } from "@pithy-sh/auth/src/peer";

/**
 * **The daily-pass host's composition: the optional peers it was handed** (#645).
 *
 * An app Worker composes capabilities and `testers()`'s `compose` hook finds auth among them. This host
 * composes nothing — it is a prebuilt Worker the adopter never authors — so it has nothing to find auth in. It
 * still reads whether each tester has used the app, and it may not import `@pithy-sh/auth` to do it: a literal
 * specifier naming an optional package is one wrangler's esbuild resolves whether or not the branch holding it
 * ever runs, so a project without auth could not deploy this host at all.
 *
 * So `pithy` hands it over. When the project composes auth, the CLI deploys this host from an entry it
 * generates beside the resolved config, which imports auth's `authPeer` from the project's own install and
 * calls {@link providePeers} before re-exporting `worker.ts` unchanged. A project without auth gets no entry,
 * and every tester reads `unobservable`, which is the honest reading.
 *
 * Its own module rather than an export of `worker.ts`, because every export of a Worker's main module is read
 * as an entrypoint, and a function is not one.
 */

/** What this host may be handed, keyed by the capability that supplies it. */
export interface TestersHostPeers {
  /** `auth()`'s peer surface, when the project composes auth. */
  readonly auth?: AuthPeer;
}

/**
 * The peers this host was handed — empty when its entry handed none.
 *
 * A value rather than a getter, and read as a property inside a Workflow's `run`: it is set once, by the entry,
 * before the isolate serves anything, so every replay of a run reads the same thing — which is what
 * `workflowDeterminism.test.ts` holds every driver body to.
 */
export const hostPeers: { -readonly [Key in keyof TestersHostPeers]: TestersHostPeers[Key] } = {};

/** Hand this host its peers. Called once, by the generated entry, before any request or cron fire. */
export function providePeers(peers: TestersHostPeers): void {
  Object.assign(hostPeers, peers);
}
