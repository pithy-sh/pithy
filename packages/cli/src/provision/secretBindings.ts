// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { ProvisionScope, SecretNameScope } from "@pithy-sh/core/src/naming/provisionScope";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import { isMintableSecret, type SecretRegistry, type SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { aggregateSecretRegistries } from "@pithy-sh/secrets/src/sharedSecretsStore";

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

/**
 * The secret registry a Worker composes, or `null` when it composes no secrets capability at all.
 *
 * **The aggregate, not the secrets capability's own slice.** `aggregateSecretRegistries` is the exact
 * call the Worker makes at composition: every capability contributes the secrets it owns, and
 * `CONNECTION_KEY_ENCRYPTION_KEY` is the adopter's `app` declaration rather than something re-typed into
 * `secrets({ registry })`. Reading the slice bound the master key and nothing else — so a
 * `cf-secrets-store` secret declared by auth, or by the adopter's own capability, got a binding from no
 * command at all, and the Worker booted healthy and failed at the first read of it. That is the half of
 * #238 the master key hid, and it is the same resolution `pithy seed` already uses (`devSecrets/targets`).
 *
 * The `secrets` capability stays the gate. A Worker that declares a `cf-secrets-store` secret and
 * composes no `secrets` has no store to read it from and no `SECRETS` binding to reach one, so there is
 * nothing there to bind.
 */
export function workerSecretRegistry(capabilities: readonly Capability[]): SecretRegistry | null {
  if (!capabilities.some(isSecretsCapability)) return null;
  return aggregateSecretRegistries(capabilities);
}

/**
 * The registry entries that need a `secrets_store_secrets` binding — one predicate, so a stanza writer
 * and a stanza reader cannot disagree about what belongs in one.
 *
 * **A keyspace is skipped.** It has no single value and therefore no single entry; its members are
 * written one key at a time by the application that mints them, and a binding under the bare name would
 * address an entry nothing ever writes.
 */
export function boundSecretNames(registry: SecretRegistry): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => entry.backend === "cf-secrets-store" && !entry.keyed)
    .map(([binding]) => binding);
}

/** One secret a run is about to create: what the Worker binds it as, what it is called here, what it is. */
export interface MintTarget {
  /** The Worker binding name, which is the registry key. */
  binding: string;
  /** The store entry to write, named for this scope. */
  secretName: string;
  /** The registry entry — carries how the value is minted. */
  entry: SecretRegistryEntry;
}

/**
 * Create one declared-but-absent secret. Injected, so the orchestration here is tested without an
 * account, and so a caller with no store credentials simply passes nothing and mints nothing.
 *
 * It resolves once the value is written and readable. It never returns the value, and nothing here ever
 * sees one.
 */
export type MintStoreSecret = (target: MintTarget) => Promise<void>;

/**
 * Every `cf-secrets-store` secret a registry declares, as a complete binding named for `scope`.
 *
 * Which secrets those are is {@link boundSecretNames}' answer, shared with the reader that reports a
 * stanza missing one — the writer and the check cannot disagree about what belongs in a stanza.
 *
 * `exists` decides what is bound rather than what is declared. Cloudflare rejects a deploy whose
 * `secrets_store_secrets` entry names a secret that is not there, so binding a declared-but-unwritten
 * secret would turn a missing value into a failed deploy of the whole Worker. The caller reports what
 * it left out.
 *
 * **`mint` is what stops provisioning asking a human to generate random bytes (#321).** A secret whose
 * registry entry says its value is arbitrary has no decision in it, and this is the moment the tool
 * already knows the value is absent. So it is created here and bound in the same pass. Three properties
 * hold it in place, and each has a test:
 *
 * - **Absent first.** `exists` is consulted before `mint`, always. Replacing a live key-encryption key
 *   orphans every value sealed under it, so creating a missing secret and replacing an existing one are
 *   different acts and only the first happens here. A re-run mints nothing.
 * - **Declared first.** {@link isMintableSecret} gates it. A supplied secret stays in `missing`, named
 *   on its own line, because a random string there authenticates against nothing.
 * - **This backend only.** The Secrets Store answers *does this exist* authoritatively, which is what
 *   makes "never regenerate" checkable. A `d1` secret's value is sealed under the master key inside the
 *   manager Worker, and the CLI has no such check for one — so nothing here mints one.
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
  /** Creates a declared-but-absent mintable secret. Omitted means create nothing, and report as before. */
  mint?: MintStoreSecret;
}): Promise<{ bound: SecretStoreBinding[]; missing: string[]; minted: string[] }> {
  const bound: SecretStoreBinding[] = [];
  const missing: string[] = [];
  const minted: string[] = [];
  for (const binding of boundSecretNames(options.registry)) {
    const entry = options.registry[binding] as SecretRegistry[string];
    const secretName = options.scope.secretEntry(binding, entry.scope as SecretNameScope);
    let present = await options.exists(secretName);
    if (!present && options.mint && isMintableSecret(entry)) {
      await options.mint({ binding, secretName, entry });
      minted.push(binding);
      present = true;
    }
    if (present) {
      bound.push({ binding, store_id: options.storeId, secret_name: secretName });
    } else {
      missing.push(binding);
    }
  }
  return { bound, missing, minted };
}
