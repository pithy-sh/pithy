// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";

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
    remove: (name) => store.deleteSecretIfPresent(name),
  };
}
