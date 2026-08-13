// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { currentValue, encodeVersionedValue, type VersionedValue } from "./crypto/versionedValue";
import type { SecretRegistryEntry } from "./registry";

/**
 * **What a `cf-secrets-store` secret is materialised as, wherever it is materialised.**
 *
 * This lived in `dev/seedDevSecrets.ts` and was named for the one caller it then had. It is not a dev
 * rule. A Secrets Store secret reaches a Worker through a binding in every environment — a `.dev.vars`
 * line locally, a `secrets_store_secrets` entry when deployed — and the binding is what the Worker
 * reads, so the shape written into the store is the shape the Worker gets. One rule, one function, and
 * the reason it is here rather than there: #321 added a second producer (`storeSecretMinter`, which
 * writes a minted value into a real account's store) that restated the rule and got it wrong. A rule
 * restated at a second site is a rule that will diverge.
 */

/**
 * The `.dev.vars` value, or the Secrets Store entry, one `cf-secrets-store` secret is materialised as.
 *
 * **The full envelope, encoded** — the same shape provisioning writes into the Secrets Store, so a
 * multi-version secret keeps its versions instead of collapsing to whichever one is current.
 *
 * **Except for a `bootstrap` secret, which carries its current value verbatim.** That is not an
 * exception invented here: `SECRETS_ENCRYPTION_KEYS` is read by `resolveEncryptionConfig` straight off
 * its binding, because it is what the envelope decoder needs in order to exist, and provisioning has
 * always written it un-enveloped. Materialising it like the others would hand a Worker a value it
 * rejects with `SECRETS_ENCRYPTION_KEYS is not a valid EncryptionConfig` — and only at the first read,
 * with the binding plainly present. See {@link SecretRegistryEntry.bootstrap}.
 */
export function bindingValue(entry: SecretRegistryEntry, value: VersionedValue): string {
  return entry.bootstrap ? currentValue(value) : encodeVersionedValue(value);
}
