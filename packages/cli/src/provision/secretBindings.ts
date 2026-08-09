// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { ProvisionScope, SecretNameScope } from "@pithy-sh/core/src/naming/provisionScope";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";

/**
 * **The `secrets_store_secrets` stanza nothing wrote.**
 *
 * `pithy add` deliberately does not write a `secret` binding, and the reason in
 * `core/src/capability/bindings.ts` is sound: the entry needs a `store_id` and a `secret_name` that do
 * not exist until an account has been reached, so "telling anyone to add one of these to
 * `wrangler.jsonc` sends them somewhere the value does not exist". The defect was that having deferred
 * it, nothing came back — the skip was a decision about *when* and was implemented as a decision about
 * *whether*. A Worker deployed without `SECRETS_ENCRYPTION_KEYS` and failed at its first request.
 *
 * Provisioning is the step being deferred to: it is when the store id is in hand and the entry
 * certainly exists. The entry **name** comes from the scope, so a feature binds its own master key and
 * `staging` binds staging's — the join key is the binding, and the binding never changes.
 *
 * **`dev` never gets a stanza, and that is deliberate rather than an omission.** Local dev materialises
 * every `cf-secrets-store` secret into the generated `.dev.vars` (#179), so a stanza there would name
 * store entries a local run never reads. Provisioning only ever writes `scope.stanza`, which is a
 * deployed or feature environment and never `dev`.
 */

/** One `secrets_store_secrets` entry, complete — wrangler rejects an entry missing any of the three. */
export interface SecretStoreBinding {
  /** The Worker binding name, which is the registry key: the same name every read site uses. */
  binding: string;
  /** The account's one Secrets Store. */
  store_id: string;
  /** The entry inside it, named for this scope. */
  secret_name: string;
}

/** The secret registry a Worker composes, or `null` when it composes no secrets capability at all. */
export function workerSecretRegistry(capabilities: readonly Capability[]): SecretRegistry | null {
  const capability = capabilities.find(isSecretsCapability);
  return capability ? capability.secretRegistry : null;
}

/**
 * Every `cf-secrets-store` secret a registry declares, as a complete binding named for `scope`.
 *
 * **A keyspace is skipped.** It has no single value and therefore no single entry; its members are
 * written one key at a time by the application that mints them, and a binding under the bare name
 * would address an entry nothing ever writes.
 *
 * `exists` decides what is bound rather than what is declared. Cloudflare rejects a deploy whose
 * `secrets_store_secrets` entry names a secret that is not there, so binding a declared-but-unwritten
 * secret would turn a missing value into a failed deploy of the whole Worker. The caller reports what
 * it left out.
 */
export async function secretsStoreBindings(options: {
  /** The registry to read — one Worker's own, so a Worker gets only what it declares. */
  registry: SecretRegistry;
  /** The scope: what each entry is called in this environment. */
  scope: ProvisionScope;
  /** The account's one Secrets Store id. */
  storeId: string;
  /** Whether an entry of that name is in the store. */
  exists: (name: string) => Promise<boolean>;
}): Promise<{ bound: SecretStoreBinding[]; missing: string[] }> {
  const bound: SecretStoreBinding[] = [];
  const missing: string[] = [];
  for (const [binding, entry] of Object.entries(options.registry)) {
    if (entry.backend !== "cf-secrets-store" || entry.keyed) continue;
    const secretName = options.scope.secretEntry(binding, entry.scope as SecretNameScope);
    if (await options.exists(secretName)) {
      bound.push({ binding, store_id: options.storeId, secret_name: secretName });
    } else {
      missing.push(binding);
    }
  }
  return { bound, missing };
}
