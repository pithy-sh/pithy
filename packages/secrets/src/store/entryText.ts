// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";

/**
 * **What a Cloudflare Secrets Store entry holds for one freshly written value — the whole of the
 * envelope decision, in one place** (#517).
 *
 * A Worker reads a `cf-secrets-store` secret straight off its binding. For nearly every secret that
 * plaintext is an encoded `{ currentVersion, versions }` envelope, decoded through
 * `decodeVersionedValue`, and the envelope is what makes a value rotation expressible at all. For a
 * `bootstrap` secret it is the value itself, because a `bootstrap` secret is *defined* as one read
 * before the store that decoder needs is open: `resolveEncryptionConfig` takes the master key's binding
 * plaintext, `JSON.parse`s it and parses an `EncryptionConfig` — there is no decode step it could put
 * an envelope through, and there cannot be one, since the master key is what that step's decryption
 * needs in order to exist.
 *
 * `#323` settled the identical question for the dev secrets file and stated the rule generally: **the
 * file states the payload the destination receives.** A store entry is a destination, and this is that
 * rule at it. `ensureMasterKey` has always obeyed it — it writes `JSON.stringify(EncryptionConfig)`
 * with nothing around it — which is why the asymmetry predates the axis that names it.
 *
 * ## Why it is a function rather than two lines at each writer
 *
 * Because two lines at each writer is what happened. `storeSecretMinter` reaches the same answer through
 * `devSecretPayload(...).text` — the dev file's payload reader, which has to make the same decision for
 * `.dev.vars` — and `storeSecretWriter` composed `encodeVersionedValue(initialVersionedValue(value))`
 * unconditionally, so an operator's `pithy secrets create` on a `bootstrap` entry wrote a value the boot
 * reader answers `is not a valid EncryptionConfig` to, having reported success. The two producers are
 * pinned to each other in `entryText.test.ts`; this is the one every new writer should reach for.
 *
 * It takes the registry entry's `bootstrap` flag rather than the entry, so a dispatch request carrying
 * the flag (`SecretWriteRequest.bootstrap`) can be handed to it directly — a writer downstream of the
 * routing seam has the fact and not the declaration.
 */
export function storeEntryText(entry: { bootstrap?: boolean }, value: string): string {
  return entry.bootstrap === true ? value : encodeVersionedValue(initialVersionedValue(value));
}
