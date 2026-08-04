// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { VERSION_METADATA_BINDING } from "@pithy-sh/core/src/worker/identity";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * The `version_metadata` binding every Pithy Worker should declare, and the idempotent repair for one
 * that does not.
 *
 * **This exists because the feature shipped without it and nobody noticed for a release.**
 * `createBackend` has always read `env.CF_VERSION_METADATA` and stamped a `version` field onto every log
 * record; `docs/LOGGING.md` documented it; a Workers-runtime test proved it worked. No template declared
 * the binding, so the field was absent in every scaffolded project and nobody could correlate a log line
 * to the deploy that produced it — the first question anyone asks when a deploy goes wrong. Correct code,
 * never wired, nothing complaining.
 *
 * It is **not** a capability binding, so it does not travel through `pithy add`'s manifest path. No
 * capability requires it, every Worker wants it, and it is populated by the platform rather than by
 * anything Pithy provisions. That makes it a property of the scaffold — which is why the repair is its
 * own step in `pithy upgrade` rather than a row in some capability's `requiredBindings`.
 *
 * **Top level, never per environment.** It is metadata about the build, and `env.<name>` stanzas replace
 * rather than merge, so a per-environment copy would be three places for one fact to drift in. Cloudflare
 * inherits the top-level declaration into every environment.
 */

/** The wrangler key that declares it. One word from the platform's own schema. */
export const VERSION_METADATA_KEY = "version_metadata";

/** The shape this module reads and writes. Only the key it owns — everything else is the adopter's. */
interface WranglerVersionMetadata {
  version_metadata?: { binding?: string };
}

/**
 * Whether this config already declares the binding under the name the runtime reads.
 *
 * Keys on the **binding name**, not merely on the key's presence. A `version_metadata` block naming
 * something else binds a value nothing in the tree consumes and leaves the logger exactly as blind as no
 * declaration at all — so that is drift to report, not a declaration to respect.
 */
export function hasVersionMetadata(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  return (config as WranglerVersionMetadata).version_metadata?.binding === VERSION_METADATA_BINDING;
}

/**
 * Declare the binding on a Worker that lacks it. Returns whether anything changed.
 *
 * Idempotent, and **never overwrites an adopter's own value.** A config already naming a different
 * binding is left alone: renaming it would silently repoint a binding they may be reading themselves,
 * and the honest move is to report the drift and let them decide. Writing goes through
 * `writeWranglerConfig`, so comments survive.
 */
export async function applyVersionMetadata(workerDir: string): Promise<boolean> {
  // A Worker with no `wrangler.jsonc` is an ordinary member of the project — a Vite frontend joins the
  // dev set through `pithy.worker.jsonc` with a `dev.command` and never deploys. It reaches the
  // reconcile plan like any other, so this must decline rather than throw: the rest of the engine
  // already tolerates it (`readStanzas` returns no stanzas for exactly this case), and an unguarded
  // read here would abort the whole `pithy upgrade --apply` run, taking every Worker after it in
  // discovery order with it. The same applies to a wrangler.jsonc with a syntax error, which the plan
  // side already swallows — reporting drift it cannot repair is the honest outcome.
  let config: WranglerVersionMetadata;
  try {
    config = (await readWranglerConfig(workerDir)) as WranglerVersionMetadata;
  } catch {
    return false;
  }
  if (config.version_metadata !== undefined) return false;

  // Assign the whole block rather than mutating in place: the key is absent, so there is no existing
  // object carrying comment-json's symbol-keyed comments to preserve.
  config.version_metadata = { binding: VERSION_METADATA_BINDING };
  await writeWranglerConfig(workerDir, config);
  return true;
}
