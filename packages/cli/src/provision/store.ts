// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CreateSecretOutcome } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";

/**
 * The account's one Secrets Store, as provisioning needs it.
 *
 * A Cloudflare account has exactly one, flat and unpartitionable, so the entry name is the only
 * partition there is — which is why every name here comes from a {@link ProvisionScope} and never from
 * a caller's string. Behind a seam so the orchestration above is tested without credentials.
 */
export interface SecretsStore {
  /** The store's id — the `store_id` every `secrets_store_secrets` entry carries. */
  readonly storeId: string;
  /** Is there an entry of this name? */
  exists(name: string): Promise<boolean>;
  /** Write a value under `name`. Overwrites in place; never deletes first. */
  put(name: string, value: string): Promise<void>;
  /**
   * Write a value under `name` only if nothing is there, never overwriting, so two runs racing to create one
   * secret leave exactly one value (#643). `created` when this call made it, `present` when one was there
   * already, `unconfirmed` when the create failed and an entry is there now — perhaps this call's own. A caller's
   * correctness must never turn on which of those it got; see `createSecretIfAbsent`.
   */
  create(name: string, value: string): Promise<CreateSecretOutcome>;
  /** Delete an entry if it is there. Resolves `true` when something was removed. */
  remove(name: string): Promise<boolean>;
}

/** The live store, over the `@pithy-sh/cloudflare` control-plane client. */
export function cloudflareSecretsStore(clients: CloudflareClients, storeId: string): SecretsStore {
  const store = clients.secrets(storeId);
  return {
    storeId,
    exists: (name) => store.exists(name),
    put: (name, value) => store.putSecret(name, value),
    create: (name, value) => store.createSecretIfAbsent(name, value),
    remove: (name) => store.deleteSecretIfPresent(name),
  };
}
