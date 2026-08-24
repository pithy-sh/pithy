// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";

/**
 * **Assemble a set of capabilities the way a Worker does at startup.**
 *
 * `createBackend` runs exactly this loop (`@pithy-sh/core/src/createBackend.ts`) — every hook, in
 * composition order — and until a capability's hook has run, half of what that capability reports is
 * a placeholder rather than an answer. `@pithy-sh/i18n` fills its `composedMessages` in its hook, so
 * its `layersFor` walks empty catalogs before it; `@pithy-sh/email` adopts that `layersFor` in its
 * own, so `hostCatalogs()` is `{}` and every `email/*` key resolves to its raw key string.
 *
 * That last sentence is the whole reason this is a shared function rather than a loop each caller
 * writes. **Reading an uncomposed capability is silent and it is worse than not reading it at all**:
 * `enqueueEmail` falls back to the kit's own English when it is handed no `layersFor`, so a project
 * that adds `i18n()` and gets an uncomposed one mails a footer link labeled
 * `email/shell.unsubscribe` — adding the capability broke a path that was correct without it. Three
 * CLI sites read one of those values, each was written independently, and two of the three forgot.
 *
 * ## Why the CLI composes the project-wide union rather than one Worker's set
 *
 * `createBackend` composes exactly the capabilities of the Worker it is booting. Every caller here is
 * resolving a **host Worker that composes nothing at all** — `pithy email provision`'s standalone send
 * host, `pithy testers`' daily-pass host, `pithy dev`'s local materialization of both. One host serves
 * the whole project (its name carries `<project>-<env>-`, not a Worker), and it is deployed once
 * whichever Worker's `pithy.config.ts` brought the capability in. So the set it is stamped from is the
 * project's whole capability surface, and a project where one Worker composes `i18n()` and another
 * composes `email()` gets a host carrying the catalogs — which is the honest answer for a Worker that
 * belongs to neither of them.
 *
 * Composition is idempotent: every kit hook assigns rather than accumulates, so composing a set twice
 * leaves it where composing it once did.
 */
export function composeCapabilities(capabilities: Capability[]): Capability[] {
  for (const capability of capabilities) capability.compose?.({ capabilities });
  return capabilities;
}
